import { createHash, randomUUID } from 'node:crypto';
import { voiceRoomName } from '@hearth/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccessToken, ServerError } from 'livekit-server-sdk';
import type { BackendParticipant, VoiceBackend } from '../../src/livekit/client.js';

export type BackendCall =
  | { op: 'listRooms' }
  | { op: 'listParticipants'; room: string }
  | { op: 'removeParticipant'; room: string; identity: string }
  | { op: 'deleteRoom'; room: string };

export const notFound = (): ServerError =>
  new ServerError('not_found', 'requested room does not exist', 404, 'not_found');
export const unavailable = (): Error => new TypeError('fetch failed');

/**
 * In-memory stand-in for LiveKit's RoomService. `rooms` is what LiveKit "has"; every call is recorded in
 * order (`calls`) together with a global sequence number shared with `order`, so tests can check ordering
 * against other events. `fail` makes an operation reject once per listed error.
 */
export class FakeVoiceBackend implements VoiceBackend {
  readonly rooms = new Map<string, BackendParticipant[]>();
  readonly calls: BackendCall[] = [];
  readonly fail: Partial<Record<BackendCall['op'], Error[]>> = {};
  /** Called on every operation, before it resolves (e.g. to observe DB state at that moment). */
  onCall: ((call: BackendCall) => void | Promise<void>) | null = null;

  private async record(call: BackendCall): Promise<void> {
    this.calls.push(call);
    await this.onCall?.(call);
    const error = this.fail[call.op]?.shift();
    if (error !== undefined) throw error;
  }

  /** Puts a participant into the room of `channelId` (creating the room). */
  put(
    channelId: string,
    userId: string,
    sid = `PA_${randomUUID().slice(0, 8)}`,
    joinedAtMs = Date.now(),
  ): string {
    const room = voiceRoomName(channelId);
    const list = this.rooms.get(room) ?? [];
    this.rooms.set(room, [
      ...list.filter((p) => p.identity !== userId),
      { identity: userId, sid, joinedAtMs },
    ]);
    return sid;
  }

  callsOf<Op extends BackendCall['op']>(op: Op): Extract<BackendCall, { op: Op }>[] {
    return this.calls.filter((c): c is Extract<BackendCall, { op: Op }> => c.op === op);
  }

  async listRooms(): Promise<string[]> {
    await this.record({ op: 'listRooms' });
    return [...this.rooms.keys()];
  }

  async listParticipants(room: string): Promise<BackendParticipant[]> {
    await this.record({ op: 'listParticipants', room });
    const list = this.rooms.get(room);
    if (list === undefined) throw notFound();
    return [...list];
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.record({ op: 'removeParticipant', room, identity });
    const list = this.rooms.get(room);
    if (list?.some((p) => p.identity === identity) !== true) throw notFound();
    this.rooms.set(
      room,
      list.filter((p) => p.identity !== identity),
    );
  }

  async deleteRoom(room: string): Promise<void> {
    await this.record({ op: 'deleteRoom', room });
    if (!this.rooms.delete(room)) throw notFound();
  }
}

/** The key/secret `testEnv()` uses (and LiveKit would sign webhooks with). */
export const TEST_LK_KEY = 'testkey';
export const TEST_LK_SECRET = 'test-only-secret-0123456789abcdef0123';

export interface WebhookInput {
  event: string;
  channelId?: string;
  /** Explicit room name (overrides `channelId`). */
  roomName?: string;
  userId?: string;
  sid?: string;
  joinedAtMs?: number;
  id?: string;
}

/** A LiveKit-shaped webhook JSON body (protobuf JSON names: camelCase, int64 as strings). */
export function webhookBody(input: WebhookInput): string {
  const room = input.roomName ?? (input.channelId === undefined ? undefined : voiceRoomName(input.channelId));
  const joinedAtMs = input.joinedAtMs ?? Date.now();
  return JSON.stringify({
    event: input.event,
    id: input.id ?? `EV_${randomUUID()}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    ...(room === undefined ? {} : { room: { sid: 'RM_test', name: room } }),
    ...(input.userId === undefined
      ? {}
      : {
          participant: {
            sid: input.sid ?? 'PA_default',
            identity: input.userId,
            state: 'ACTIVE',
            joinedAt: String(Math.floor(joinedAtMs / 1000)),
            joinedAtMs: String(joinedAtMs),
            name: 'someone',
          },
        }),
  });
}

/** Signs `body` as LiveKit does: an API-key JWT whose `sha256` claim is the base64 SHA-256 of the body. */
export async function signWebhook(body: string, secret = TEST_LK_SECRET, key = TEST_LK_KEY): Promise<string> {
  const token = new AccessToken(key, secret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

/** POSTs a signed webhook (the body can be tampered with after signing via `tamper`). */
export async function postWebhook(
  app: FastifyInstance,
  input: WebhookInput | string,
  options: {
    secret?: string;
    tamper?: (body: string) => string;
    authorization?: string | null;
    /** Defaults to LiveKit's `application/webhook+json`. */
    contentType?: string;
  } = {},
): Promise<LightMyRequestResponse> {
  const body = typeof input === 'string' ? input : webhookBody(input);
  const authorization =
    options.authorization === undefined ? await signWebhook(body, options.secret) : options.authorization;
  return app.inject({
    method: 'POST',
    url: '/api/livekit/webhook',
    headers: {
      'content-type': options.contentType ?? 'application/webhook+json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: options.tamper === undefined ? body : options.tamper(body),
  });
}
