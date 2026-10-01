import type { BootstrapResponse, Channel, DmChannel, PublicUser } from '@hearth/shared';
import { t } from '../i18n';

/**
 * Pure updates of the cached `['bootstrap']` data for socket events and mutation responses.
 * All are idempotent: applying the same event twice gives the same result.
 */

/** Channels in their single `position` order (text and voice share it). */
export function sortChannels(channels: readonly Channel[]): Channel[] {
  return channels.toSorted((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export function upsertChannel(boot: BootstrapResponse, channel: Channel): BootstrapResponse {
  const others = boot.channels.filter((c) => c.id !== channel.id);
  return { ...boot, channels: sortChannels([...others, channel]) };
}

export function removeChannel(boot: BootstrapResponse, channelId: string): BootstrapResponse {
  const channels = boot.channels.filter((c) => c.id !== channelId);
  const dms = boot.dms.filter((d) => d.id !== channelId);
  if (channels.length === boot.channels.length && dms.length === boot.dms.length) return boot;
  return { ...boot, channels, dms };
}

export function replaceChannels(boot: BootstrapResponse, channels: readonly Channel[]): BootstrapResponse {
  return { ...boot, channels: sortChannels(channels) };
}

export function upsertDm(boot: BootstrapResponse, dm: DmChannel): BootstrapResponse {
  if (boot.dms.some((d) => d.id === dm.id)) return boot;
  return { ...boot, dms: [...boot.dms, dm] };
}

export function upsertUser(boot: BootstrapResponse, user: PublicUser): BootstrapResponse {
  const known = boot.users.some((u) => u.id === user.id);
  const users = known ? boot.users.map((u) => (u.id === user.id ? user : u)) : [...boot.users, user];
  const me = boot.me.id === user.id ? { ...boot.me, ...user } : boot.me;
  return { ...boot, users, me };
}

// ---- Display helpers ----

/**
 * "Deleted user" / "Unknown user" in the current UI language. Functions, not constants, so the text
 * follows a language switch (callers render inside components subscribed to the locale).
 */
export function deletedUserName(): string {
  return t('common.deletedUser');
}

export function unknownUserName(): string {
  return t('common.unknownUser');
}

/** Author label: the display name, "Deleted user" when deactivated (CONTRACTS B.7b rule 5). */
export function authorName(user: PublicUser | undefined): string {
  if (!user) return unknownUserName();
  return user.deactivated ? deletedUserName() : user.displayName;
}

/** How a user is shown next to their content (messages, DMs, voice). */
export interface UserDisplay {
  name: string;
  /** `null` when there is no image to show (none, or a deleted user). */
  avatarUrl: string | null;
  /** Deactivated: "Deleted user" with the neutral avatar, never their name or picture. */
  deleted: boolean;
}

/** A user's name and avatar as displayed; unknown users show as "Unknown user". */
export function displayUser(user: PublicUser | undefined): UserDisplay {
  if (!user) return { name: unknownUserName(), avatarUrl: null, deleted: false };
  if (user.deactivated) return { name: deletedUserName(), avatarUrl: null, deleted: true };
  return { name: user.displayName, avatarUrl: user.avatarUrl, deleted: false };
}

/** Sidebar / title label of a DM: the other user's display name ("Deleted user" when deactivated). */
export function dmName(boot: BootstrapResponse, dm: DmChannel): string {
  return authorName(boot.users.find((u) => u.id === dm.otherUserId));
}

export type ResolvedChannel =
  { kind: 'channel'; channel: Channel } | { kind: 'dm'; dm: DmChannel; otherUser: PublicUser | undefined };

/** A text/voice channel or a DM of the current user, by id. */
export function findChannel(boot: BootstrapResponse, channelId: string): ResolvedChannel | null {
  const channel = boot.channels.find((c) => c.id === channelId);
  if (channel) return { kind: 'channel', channel };
  const dm = boot.dms.find((d) => d.id === channelId);
  if (dm) return { kind: 'dm', dm, otherUser: boot.users.find((u) => u.id === dm.otherUserId) };
  return null;
}

export type ChannelViewState =
  | { status: 'loading' }
  /** Not in bootstrap any more: deleted (maybe while offline, with no `channel:deleted` seen). */
  | { status: 'gone' }
  /** A voice channel: not viewable here (the route loader redirects these). */
  | { status: 'unsupported' }
  | { status: 'ready'; resolved: ResolvedChannel };

/** What `/channels/:channelId` should show for the cached bootstrap. */
export function channelViewState(boot: BootstrapResponse | undefined, channelId: string): ChannelViewState {
  if (!boot) return { status: 'loading' };
  const resolved = findChannel(boot, channelId);
  if (!resolved) return { status: 'gone' };
  if (resolved.kind === 'channel' && resolved.channel.type !== 'text') return { status: 'unsupported' };
  return { status: 'ready', resolved };
}
