import type { BootstrapResponse, Message } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { notificationTitle, plainTextPreview, shouldNotify, type NotifyDecision } from './notifications';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERAL = '11111111-1111-4111-8111-111111111111';
const DM = '22222222-2222-4222-8222-222222222222';

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: '7',
    channelId: GENERAL,
    authorId: ALICE,
    content: '@bob look',
    createdAt: '2026-09-28T10:00:00.000Z',
    editedAt: null,
    attachments: [],
    reactions: [],
    mentionUserIds: [ME],
    nonce: null,
    ...overrides,
  };
}

function decision(overrides: Partial<NotifyDecision> = {}): NotifyDecision {
  return {
    message: msg(),
    meId: ME,
    enabled: true,
    permission: 'granted',
    visibility: 'hidden',
    ...overrides,
  };
}

const user = (id: string, displayName: string) => ({
  id,
  username: displayName.toLowerCase(),
  displayName,
  avatarUrl: null,
  role: 'member' as const,
  deactivated: false,
});

const boot: BootstrapResponse = {
  me: { ...user(ME, 'Bob'), createdAt: '2026-09-28T10:00:00.000Z', locale: 'en' },
  users: [user(ME, 'Bob'), user(ALICE, 'Alice')],
  channels: [{ id: GENERAL, type: 'text', name: 'general', position: 0 }],
  dms: [{ id: DM, type: 'dm', otherUserId: ALICE }],
  readStates: [],
  voice: {},
  onlineUserIds: [],
  livekitUrl: 'ws://localhost:7880',
};

describe('shouldNotify', () => {
  it('notifies a mention from someone else while hidden, enabled and granted', () => {
    expect(shouldNotify(decision())).toBe(true);
  });

  it('never notifies while the tab is visible', () => {
    expect(shouldNotify(decision({ visibility: 'visible' }))).toBe(false);
  });

  it('needs the setting and the permission', () => {
    expect(shouldNotify(decision({ enabled: false }))).toBe(false);
    expect(shouldNotify(decision({ permission: 'default' }))).toBe(false);
    expect(shouldNotify(decision({ permission: 'denied' }))).toBe(false);
    expect(shouldNotify(decision({ permission: 'unsupported' }))).toBe(false);
  });

  it('needs a mention of me, and never for my own messages', () => {
    expect(shouldNotify(decision({ message: msg({ mentionUserIds: [] }) }))).toBe(false);
    expect(shouldNotify(decision({ message: msg({ mentionUserIds: [ALICE] }) }))).toBe(false);
    expect(shouldNotify(decision({ message: msg({ authorId: ME }) }))).toBe(false);
  });
});

describe('notification text', () => {
  it('titles a channel message "<author> in #<channel>" and a DM "<author>"', () => {
    expect(notificationTitle(boot, msg())).toBe('Alice in #general');
    expect(notificationTitle(boot, msg({ channelId: DM }))).toBe('Alice');
  });

  it('strips Markdown syntax crudely and keeps usernames intact', () => {
    expect(plainTextPreview('**hey** @bob_smith, see [this](https://x.y) and `code` ~~no~~ *em*')).toBe(
      'hey @bob_smith, see this and code no em',
    );
    expect(plainTextPreview('> quoted\n- item\n```js\nlet a;\n```')).toBe('quoted item let a;');
  });

  it('cuts at 120 characters without splitting an emoji', () => {
    expect(plainTextPreview('a'.repeat(200))).toHaveLength(120);
    const emoji = '😀'.repeat(130);
    expect(Array.from(plainTextPreview(emoji))).toHaveLength(120);
  });
});
