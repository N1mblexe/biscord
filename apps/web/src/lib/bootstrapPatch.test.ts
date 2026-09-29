import type { BootstrapResponse, Channel, PublicUser } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import {
  authorName,
  channelViewState,
  displayUser,
  dmName,
  findChannel,
  removeChannel,
  replaceChannels,
  upsertChannel,
  upsertDm,
  upsertUser,
} from './bootstrapPatch';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RANDOM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const user = (id: string, displayName: string, extra: Partial<PublicUser> = {}): PublicUser => ({
  id,
  username: displayName.toLowerCase(),
  displayName,
  avatarUrl: null,
  role: 'member',
  deactivated: false,
  ...extra,
});

const ch = (id: string, name: string, position: number, type: Channel['type'] = 'text'): Channel => ({
  id,
  type,
  name,
  position,
});

const boot: BootstrapResponse = {
  me: { ...user(ME, 'Alice', { role: 'admin' }), createdAt: '2026-09-28T10:00:00.000Z' },
  users: [user(ME, 'Alice', { role: 'admin' }), user(BOB, 'Bob')],
  channels: [ch(GENERAL, 'general', 0), ch(VOICE, 'Lounge', 1, 'voice')],
  dms: [],
  readStates: [],
  voice: {},
  onlineUserIds: [],
  livekitUrl: 'ws://localhost:7880',
};

describe('bootstrap patches', () => {
  it('adds and renames channels idempotently, in position order', () => {
    const added = upsertChannel(boot, ch(RANDOM, 'random', 2));
    expect(upsertChannel(added, ch(RANDOM, 'random', 2)).channels).toEqual(added.channels);
    const renamed = upsertChannel(added, ch(RANDOM, 'off-topic', 2));
    expect(renamed.channels.map((c) => c.name)).toEqual(['general', 'Lounge', 'off-topic']);
  });

  it('replaces the order on channels:reordered', () => {
    const next = replaceChannels(boot, [ch(VOICE, 'Lounge', 0, 'voice'), ch(GENERAL, 'general', 1)]);
    expect(next.channels.map((c) => c.id)).toEqual([VOICE, GENERAL]);
  });

  it('removes a channel; removing twice is a no-op', () => {
    const next = removeChannel(boot, GENERAL);
    expect(next.channels.map((c) => c.id)).toEqual([VOICE]);
    expect(removeChannel(next, GENERAL)).toBe(next);
  });

  it('adds a DM once and resolves it', () => {
    const dm = { id: DM, type: 'dm' as const, otherUserId: BOB };
    const next = upsertDm(upsertDm(boot, dm), dm);
    expect(next.dms).toEqual([dm]);
    expect(dmName(next, dm)).toBe('Bob');
    expect(findChannel(next, DM)).toMatchObject({ kind: 'dm', otherUser: { id: BOB } });
    expect(findChannel(next, GENERAL)).toMatchObject({ kind: 'channel', channel: { name: 'general' } });
    expect(findChannel(next, RANDOM)).toBeNull();
  });

  it('updates users and me on user:updated', () => {
    const next = upsertUser(boot, user(ME, 'Alicia', { role: 'admin' }));
    expect(next.me.displayName).toBe('Alicia');
    expect(next.me.createdAt).toBe(boot.me.createdAt);
    const bob = upsertUser(boot, user(BOB, 'Bob', { deactivated: true }));
    expect(bob.users.find((u) => u.id === BOB)?.deactivated).toBe(true);
    expect(bob.me).toBe(boot.me);
  });

  it('labels deactivated and unknown authors', () => {
    expect(authorName(user(BOB, 'Bob'))).toBe('Bob');
    expect(authorName(user(BOB, 'Bob', { deactivated: true }))).toBe('Deleted user');
    expect(authorName(undefined)).toBe('Unknown user');
  });

  it('shows a deactivated user as "Deleted user" with the neutral avatar, never their name or picture', () => {
    const pic = '/api/avatars/b?v=12345678';
    expect(displayUser(user(BOB, 'Bob', { avatarUrl: pic }))).toEqual({
      name: 'Bob',
      avatarUrl: pic,
      deleted: false,
    });
    expect(displayUser(user(BOB, 'Bob', { avatarUrl: pic, deactivated: true }))).toEqual({
      name: 'Deleted user',
      avatarUrl: null,
      deleted: true,
    });
    expect(displayUser(undefined)).toEqual({ name: 'Unknown user', avatarUrl: null, deleted: false });
  });

  it('titles a DM with a deactivated user "Deleted user"', () => {
    const dm = { id: DM, type: 'dm' as const, otherUserId: BOB };
    const withDm = upsertDm(boot, dm);
    expect(dmName(withDm, dm)).toBe('Bob');
    expect(dmName(upsertUser(withDm, user(BOB, 'Bob', { deactivated: true })), dm)).toBe('Deleted user');
    expect(dmName(withDm, { ...dm, otherUserId: RANDOM })).toBe('Unknown user');
  });

  it('treats a channel missing from a refetched bootstrap as gone (deleted while offline)', () => {
    expect(channelViewState(undefined, GENERAL)).toEqual({ status: 'loading' });
    expect(channelViewState(boot, GENERAL)).toMatchObject({ status: 'ready', resolved: { kind: 'channel' } });
    expect(channelViewState(boot, VOICE)).toEqual({ status: 'unsupported' });
    // The refetch after reconnect no longer lists it, and no channel:deleted event was seen.
    const refetched = { ...boot, channels: boot.channels.filter((c) => c.id !== GENERAL) };
    expect(channelViewState(refetched, GENERAL)).toEqual({ status: 'gone' });
    expect(channelViewState(boot, DM)).toEqual({ status: 'gone' });
  });
});
