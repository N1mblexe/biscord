import { eq } from 'drizzle-orm';
import { voiceRoomName, type PublicUser, type Role, type VoiceKickedReason } from '@hearth/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Queryable, UserRow } from '../db/types.js';
import { AppError, loggableError } from '../lib/errors.js';
import { toPublicUser } from '../lib/serialize.js';
import { ignoreNotFound, type VoiceBackend } from '../livekit/client.js';
import type { LiveKitHealth } from '../livekit/health.js';
import type { Realtime } from '../realtime/io.js';
import type { VoiceState } from '../realtime/voice-state.js';
import type { Storage } from '../storage/paths.js';
import { deleteChannel as deleteChannelRow, findChannel } from './channels.js';
import { revokeRedeemableInvitesBy } from './invites.js';
import { voidUnusedResetCodes } from './resetCodes.js';
import { deleteUserSessions } from './sessions.js';
import { assertStillAdmin, countActiveUsers, countOtherActiveAdmins, lockUsers } from './users.js';

export interface LifecycleDeps {
  db: Db;
  /** The account cap (`MAX_USERS`), shared with registration. */
  maxUsers: number;
  realtime: Realtime;
  voice: VoiceState;
  voiceBackend: VoiceBackend;
  livekitHealth: LiveKitHealth;
  storage: Storage;
  log: FastifyBaseLogger;
}

/**
 * CONTRACTS B.7 / B.7b: every multi-system flow (DB, sockets, LiveKit, disk). Each runs its steps in the
 * contract's order, emits only after the DB commit, and is idempotent, so a crash between steps is repaired
 * by repeating the request (and, for LiveKit, by the voice reconcile loop).
 */
export interface Lifecycle {
  /** Row 35. The same role → the user, no event. `LAST_ADMIN` when it would leave no active admin. */
  changeRole(actorId: string, targetId: string, role: Role): Promise<PublicUser>;
  /** Row 36 (B.7 "deactivate user"). Already deactivated → no-op. `LAST_ADMIN` as for demotion. */
  deactivateUser(actorId: string, targetId: string, log?: FastifyBaseLogger): Promise<void>;
  /** Row 37. Already active → no-op. `USER_LIMIT` at the account cap. Sessions are not restored. */
  reactivateUser(actorId: string, targetId: string): Promise<void>;
  /** Row 31. `NOT_FOUND` unless the user is in that voice channel; `LIVEKIT_UNAVAILABLE` if LiveKit fails. */
  disconnectFromVoice(channelId: string, userId: string, log?: FastifyBaseLogger): Promise<void>;
  /**
   * Row 18 (B.7 "delete voice channel" / "delete text channel"). `actorId` must still be an admin in the
   * delete transaction (B.7b rule 7).
   */
  deleteChannel(actorId: string, channelId: string, log?: FastifyBaseLogger): Promise<void>;
}

const userNotFound = (): AppError => new AppError('NOT_FOUND', 'User not found');
const lastAdmin = (): AppError =>
  new AppError('LAST_ADMIN', 'The server must keep at least one active admin');

/** The target row, locked for the rest of the transaction; `NOT_FOUND` if missing. */
async function lockTarget(tx: Queryable, id: string): Promise<UserRow> {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update');
  if (row === undefined) throw userNotFound();
  return row;
}

/** B.7b rule 1: taking `target` out of the active admins must leave at least one (counted under the lock). */
async function assertNotLastAdmin(tx: Queryable, target: UserRow): Promise<void> {
  if (target.role !== 'admin' || target.deactivatedAt !== null) return;
  if ((await countOtherActiveAdmins(tx, target.id)) === 0) throw lastAdmin();
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { db, realtime, voice, voiceBackend, livekitHealth, storage } = deps;

  const kickNotice = (userIds: readonly string[], channelId: string, reason: VoiceKickedReason): void => {
    realtime.emitToUsers(userIds, 'voice:kicked', { channelId, reason });
  };

  /** Drops the membership from memory (→ `voice:left`) unless the user reconnected with another sid since. */
  const forgetMembership = (channelId: string, userId: string, sid: string): Promise<void> =>
    voice.exclusive(() => {
      voice.participantLeft(channelId, userId, sid);
    });

  return {
    async changeRole(actorId, rawTargetId, role) {
      const targetId = rawTargetId.toLowerCase();
      const result = await db.transaction(async (tx) => {
        await lockUsers(tx);
        const target = await lockTarget(tx, targetId);
        if (target.role === role) return { user: target, changed: false };
        // Checked before the actor: two admins demoting each other both get LAST_ADMIN's 409 on the loser.
        if (role === 'member') await assertNotLastAdmin(tx, target);
        await assertStillAdmin(tx, actorId);
        const [updated] = await tx.update(users).set({ role }).where(eq(users.id, targetId)).returning();
        if (updated === undefined) throw userNotFound();
        return { user: updated, changed: true };
      });
      const user = toPublicUser(result.user);
      if (result.changed) realtime.emitToAll('user:updated', { user });
      return user;
    },

    async deactivateUser(actorId, rawTargetId, log = deps.log) {
      // In-memory state (voice, rooms) is keyed by the lower-case id; the route accepts either case.
      const targetId = rawTargetId.toLowerCase();
      // B.7 step 1: one transaction (users lock → last-admin guard → deactivatedAt → void the user's unused
      // reset codes and revoke their redeemable invites → delete sessions).
      const result = await db.transaction(async (tx) => {
        await lockUsers(tx);
        const target = await lockTarget(tx, targetId);
        if (target.deactivatedAt !== null) return null;
        await assertNotLastAdmin(tx, target);
        await assertStillAdmin(tx, actorId);
        const [updated] = await tx
          .update(users)
          .set({ deactivatedAt: new Date() })
          .where(eq(users.id, targetId))
          .returning();
        if (updated === undefined) throw userNotFound();
        // B.7b rule 7: no credential outlives the deactivation, so a later reactivation doesn't revive them.
        await voidUnusedResetCodes(tx, targetId);
        await revokeRedeemableInvitesBy(tx, targetId);
        return { user: updated, sessionIds: await deleteUserSessions(tx, targetId) };
      });
      // B.7b rule 2: already deactivated → 204 without events.
      if (result === null) return;

      const membership = voice.membershipOf(targetId);
      // Sent while the sockets are still open (after step 2 nobody would hear it); step 2 follows at once.
      if (membership !== null) kickNotice([targetId], membership.channelId, 'deactivated');

      // Step 2: `session:revoked` to every socket of the user, then close them.
      realtime.revokeUser(targetId, result.sessionIds, 'deactivated');

      // Step 3: out of LiveKit. A failure is logged: the DB is the source of truth, and both the reconcile
      // loop and the join webhook remove a deactivated user's participant.
      if (membership !== null) {
        try {
          await ignoreNotFound(voiceBackend.removeParticipant(voiceRoomName(membership.channelId), targetId));
        } catch (err) {
          log.warn(
            { err: loggableError(err), channelId: membership.channelId, userId: targetId },
            'deactivate: removeParticipant failed; the voice reconcile will retry',
          );
        }
        await forgetMembership(membership.channelId, targetId, membership.sid);
      }

      // Step 4: the new profile, then an immediate offline (no grace period).
      realtime.emitToAll('user:updated', { user: toPublicUser(result.user) });
      realtime.forceOffline(targetId);
    },

    async reactivateUser(actorId, rawTargetId) {
      const targetId = rawTargetId.toLowerCase();
      const reactivated = await db.transaction(async (tx) => {
        await lockUsers(tx);
        const target = await lockTarget(tx, targetId);
        if (target.deactivatedAt === null) return null;
        await assertStillAdmin(tx, actorId);
        // The same lock and cap as registration.
        if ((await countActiveUsers(tx)) >= deps.maxUsers) {
          throw new AppError('USER_LIMIT', 'This server has reached its user limit');
        }
        const [updated] = await tx
          .update(users)
          .set({ deactivatedAt: null })
          .where(eq(users.id, targetId))
          .returning();
        if (updated === undefined) throw userNotFound();
        return updated;
      });
      // B.7b rule 2: already active → 204 without events. Rule 3: no session is restored.
      if (reactivated !== null) realtime.emitToAll('user:updated', { user: toPublicUser(reactivated) });
    },

    async disconnectFromVoice(rawChannelId, rawUserId, log = deps.log) {
      const channelId = rawChannelId.toLowerCase();
      const userId = rawUserId.toLowerCase();
      const channel = await findChannel(db, channelId);
      const membership = voice.membershipOf(userId);
      if (channel?.type !== 'voice' || membership?.channelId !== channel.id) {
        throw new AppError('NOT_FOUND', 'That user is not in this voice channel');
      }
      if (livekitHealth.cached() === 'down') {
        throw new AppError('LIVEKIT_UNAVAILABLE', 'Voice server unavailable');
      }
      // The reason first, so the client shows a notice instead of treating the drop as a network error.
      kickNotice([userId], channel.id, 'admin');
      try {
        await ignoreNotFound(voiceBackend.removeParticipant(voiceRoomName(channel.id), userId));
      } catch (err) {
        log.warn(
          { err: loggableError(err), channelId, userId },
          'voice disconnect: removeParticipant failed',
        );
        throw new AppError('LIVEKIT_UNAVAILABLE', 'Voice server unavailable');
      }
      await forgetMembership(channel.id, userId, membership.sid);
    },

    async deleteChannel(actorId, channelId, log = deps.log) {
      // Snapshot before `deleteRoom`: LiveKit's participant_left webhooks for the closing room may be
      // applied before the DB delete commits, emptying memory before the occupants could be read.
      const occupants = voice.participantIds(channelId.toLowerCase());
      // Steps 1–2: `deleteRoom` (voice; a 404 counts as success, anything else → 503 and no DB change),
      // then the DB delete (cascades), collecting attachment keys.
      const { channel, storageKeys } = await deleteChannelRow(db, actorId, channelId, { voiceBackend, log });
      if (channel.type === 'voice') {
        // Its webhooks are ignored from now on (no such channel); drop what's left of it silently.
        const remaining = await voice.exclusive(() => {
          const ids = voice.participantIds(channel.id);
          voice.forgetChannel(channel.id);
          return ids;
        });
        kickNotice([...new Set([...occupants, ...remaining])], channel.id, 'channel_deleted');
      }
      // Step 3: broadcast.
      realtime.emitToAll('channel:deleted', { channelId: channel.id });
      if (channel.type === 'voice') {
        // B.7b rule 7: a join between the first `deleteRoom` and the commit re-created the room (rooms
        // auto-create), so close it once more. A 404 is the usual answer; a failure is only logged: the
        // room holds nobody Hearth tracks, and LiveKit closes it once it empties.
        try {
          await ignoreNotFound(voiceBackend.deleteRoom(voiceRoomName(channel.id)));
        } catch (err) {
          log.warn(
            { err: loggableError(err), channelId: channel.id },
            'voice channel delete: the second deleteRoom failed',
          );
        }
      }
      // Text channels, B.7 step 4: files go after the commit and the broadcast; failures are logged.
      await storage.removeKeys(storageKeys);
    },
  };
}
