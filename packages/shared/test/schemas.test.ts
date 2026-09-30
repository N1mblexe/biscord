import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AttachmentParams,
  ChangePasswordRequest,
  ChannelName,
  CreateChannelRequest,
  CreateInviteRequest,
  CreateMessageRequest,
  DisplayName,
  InviteCodeParams,
  LoginRequest,
  Password,
  RegisterRequest,
  ResetPasswordRequest,
  TestSeedMessagesRequest,
  UpdateMeRequest,
  UpdateMessageRequest,
  isLenientNulFailure,
  IsoDate,
  ListMessagesQuery,
  MessageId,
  MessageIdOrZero,
  Username,
  parseVoiceRoomName,
  voiceRoomName,
} from '../src/index.js';

const UUID_A = '3f2c1b9e-8a4d-4c6b-9f1e-2d3c4b5a6f70';
const UUID_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('ids', () => {
  it('MessageId rejects 0 and leading zeros', () => {
    expect(MessageId.safeParse('0').success).toBe(false);
    expect(MessageId.safeParse('01').success).toBe(false);
    expect(MessageId.safeParse('-1').success).toBe(false);
    expect(MessageId.safeParse('1').success).toBe(true);
    expect(MessageId.safeParse('9007199254740991').success).toBe(true);
    expect(MessageId.safeParse('12345678901234567').success).toBe(false);
  });

  it('MessageIdOrZero accepts 0', () => {
    expect(MessageIdOrZero.safeParse('0').success).toBe(true);
    expect(MessageIdOrZero.safeParse('42').success).toBe(true);
    expect(MessageIdOrZero.safeParse('00').success).toBe(false);
  });

  it('IsoDate accepts Z and offsets', () => {
    expect(IsoDate.safeParse('2026-09-28T12:00:00.000Z').success).toBe(true);
    expect(IsoDate.safeParse('2026-09-28T12:00:00+02:00').success).toBe(true);
    expect(IsoDate.safeParse('2026-09-28').success).toBe(false);
  });
});

describe('Username', () => {
  it('rejects uppercase', () => {
    expect(Username.safeParse('Alice').success).toBe(false);
    expect(Username.safeParse('alice_01').success).toBe(true);
  });

  it('enforces length 3–32', () => {
    expect(Username.safeParse('ab').success).toBe(false);
    expect(Username.safeParse('a'.repeat(33)).success).toBe(false);
  });
});

describe('CreateMessageRequest', () => {
  it('rejects empty content with no attachments', () => {
    expect(CreateMessageRequest.safeParse({ content: '' }).success).toBe(false);
    expect(CreateMessageRequest.safeParse({ content: '   ', attachmentIds: [] }).success).toBe(false);
  });

  it('accepts attachments-only messages', () => {
    const r = CreateMessageRequest.safeParse({ content: '', attachmentIds: [UUID_A] });
    expect(r.success).toBe(true);
  });

  it('trims content and defaults attachmentIds', () => {
    const r = CreateMessageRequest.parse({ content: '  hi  ' });
    expect(r).toEqual({ content: 'hi', attachmentIds: [] });
  });

  it('enforces attachment limits and uniqueness', () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `3f2c1b9e-8a4d-4c6b-9f1e-2d3c4b5a6f${String(i).padStart(2, '0')}`,
    );
    expect(CreateMessageRequest.safeParse({ content: 'x', attachmentIds: eleven }).success).toBe(false);
    expect(CreateMessageRequest.safeParse({ content: 'x', attachmentIds: [UUID_A, UUID_A] }).success).toBe(
      false,
    );
    expect(CreateMessageRequest.safeParse({ content: 'x', attachmentIds: [UUID_A, UUID_B] }).success).toBe(
      true,
    );
  });

  it('enforces content and nonce length', () => {
    expect(CreateMessageRequest.safeParse({ content: 'a'.repeat(4001) }).success).toBe(false);
    expect(CreateMessageRequest.safeParse({ content: 'a'.repeat(4000) }).success).toBe(true);
    expect(CreateMessageRequest.safeParse({ content: 'a', nonce: 'n'.repeat(65) }).success).toBe(false);
  });
});

describe('ListMessagesQuery', () => {
  it('rejects before and after together', () => {
    expect(ListMessagesQuery.safeParse({ before: '10', after: '5' }).success).toBe(false);
  });

  it('coerces limit from a query string and defaults to 50', () => {
    expect(ListMessagesQuery.parse({ limit: '25', before: '10' })).toEqual({ limit: 25, before: '10' });
    expect(ListMessagesQuery.parse({})).toEqual({ limit: 50 });
    expect(ListMessagesQuery.parse({ after: '7' })).toEqual({ limit: 50, after: '7' });
  });

  it('bounds limit to 1–100 integers', () => {
    expect(ListMessagesQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListMessagesQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListMessagesQuery.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(ListMessagesQuery.safeParse({ limit: 'abc' }).success).toBe(false);
  });
});

describe('CreateInviteRequest', () => {
  it('applies defaults and bounds', () => {
    expect(CreateInviteRequest.parse({})).toEqual({ maxUses: 1, expiresInHours: 168 });
    expect(CreateInviteRequest.safeParse({ maxUses: 26 }).success).toBe(false);
    expect(CreateInviteRequest.safeParse({ expiresInHours: 721 }).success).toBe(false);
  });
});

describe('voice room names', () => {
  it('round-trips', () => {
    const name = voiceRoomName(UUID_A);
    expect(name).toBe(`voice_${UUID_A}`);
    expect(parseVoiceRoomName(name)).toBe(UUID_A);
  });

  it('rejects foreign room names', () => {
    expect(parseVoiceRoomName('voice_not-a-uuid')).toBeNull();
    expect(parseVoiceRoomName(UUID_A)).toBeNull();
    expect(parseVoiceRoomName(`text_${UUID_A}`)).toBeNull();
  });
});

describe('NUL characters (B.9 rule 1)', () => {
  const NUL = '\u0000';

  it('strict fields reject a NUL with a plain (non-lenient) issue', () => {
    const cases: [string, { safeParse: (v: unknown) => { success: boolean } }, unknown][] = [
      ['DisplayName', DisplayName, `bob${NUL}`],
      ['Password', Password, `longenough${NUL}`],
      ['ChannelName', ChannelName, `gen${NUL}eral`],
      ['Username', Username, `bob${NUL}`],
      ['UpdateMeRequest', UpdateMeRequest, { displayName: `a${NUL}` }],
      ['CreateChannelRequest', CreateChannelRequest, { type: 'text', name: `a${NUL}` }],
      ['CreateMessageRequest.content', CreateMessageRequest, { content: `hi${NUL}` }],
      ['CreateMessageRequest.nonce', CreateMessageRequest, { content: 'hi', nonce: `n${NUL}` }],
      ['UpdateMessageRequest', UpdateMessageRequest, { content: `hi${NUL}` }],
      ['AttachmentParams', AttachmentParams, { id: UUID_A, filename: `a${NUL}.png` }],
      [
        'TestSeedMessagesRequest',
        TestSeedMessagesRequest,
        { channelId: UUID_A, authorId: UUID_B, count: 1, prefix: NUL },
      ],
      [
        'RegisterRequest.password',
        RegisterRequest,
        { inviteCode: 'ABC', username: 'bob', displayName: 'Bob', password: `longenough${NUL}` },
      ],
    ];
    for (const [name, schema, value] of cases) {
      expect(schema.safeParse(value).success, name).toBe(false);
    }
    const r = UpdateMeRequest.safeParse({ displayName: `a${NUL}` });
    expect(!r.success && isLenientNulFailure(r.error)).toBe(false);
  });

  it('lenient fields reject a NUL with an issue the server answers like a wrong value', () => {
    const cases: [string, { safeParse: (v: unknown) => z.ZodSafeParseResult<unknown> }, unknown][] = [
      ['LoginRequest.username', LoginRequest, { username: `bob${NUL}`, password: 'x' }],
      ['LoginRequest.password', LoginRequest, { username: 'bob', password: `x${NUL}` }],
      [
        'ResetPasswordRequest.username',
        ResetPasswordRequest,
        { username: NUL, code: 'ABC', newPassword: 'longenough1' },
      ],
      [
        'ResetPasswordRequest.code',
        ResetPasswordRequest,
        { username: 'bob', code: `A${NUL}`, newPassword: 'longenough1' },
      ],
      [
        'ChangePasswordRequest.currentPassword',
        ChangePasswordRequest,
        { currentPassword: NUL, newPassword: 'longenough1' },
      ],
      [
        'RegisterRequest.inviteCode',
        RegisterRequest,
        { inviteCode: `A${NUL}`, username: 'bob', displayName: 'Bob', password: 'longenough1' },
      ],
      ['InviteCodeParams', InviteCodeParams, { code: `A${NUL}` }],
    ];
    for (const [name, schema, value] of cases) {
      const r = schema.safeParse(value);
      expect(r.success, name).toBe(false);
      expect(!r.success && isLenientNulFailure(r.error), name).toBe(true);
    }
  });

  it('a lenient NUL mixed with another invalid field is not a lenient-only failure', () => {
    const r = ResetPasswordRequest.safeParse({ username: 'bob', code: `A${NUL}`, newPassword: 'short' });
    expect(!r.success && isLenientNulFailure(r.error)).toBe(false);
  });

  it('values without a NUL still pass', () => {
    expect(LoginRequest.safeParse({ username: 'Bob ', password: 'x' }).success).toBe(true);
    expect(DisplayName.parse('  Bob  ')).toBe('Bob');
    expect(InviteCodeParams.safeParse({ code: 'abc' }).success).toBe(true);
  });
});
