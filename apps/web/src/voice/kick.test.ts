import { afterEach, describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import { planVoiceKick, voiceKickNotice } from './kick';

const LOUNGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ADMIN = 'You were disconnected from voice by an admin.';
const DELETED = 'This voice channel was deleted.';

describe('voice:kicked notices', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: 'en' });
  });

  it('maps each reason to the contract text (deactivation is left to session:revoked)', () => {
    expect(voiceKickNotice('admin')).toBe(ADMIN);
    expect(voiceKickNotice('channel_deleted')).toBe(DELETED);
    expect(voiceKickNotice('deactivated')).toBeNull();
  });

  it('is in the UI language when the kick arrives', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(voiceKickNotice('admin')).toBe('Bir yönetici ses bağlantınızı kesti.');
    expect(voiceKickNotice('channel_deleted')).toBe('Bu ses kanalı silindi.');
  });
});

describe('planVoiceKick', () => {
  const inLounge = { channelId: LOUNGE, state: 'connected' as const, lastChannelId: LOUNGE };

  it('leaves and explains when we are in (or joining) that channel', () => {
    expect(planVoiceKick({ channelId: LOUNGE, reason: 'admin' }, inLounge)).toEqual({
      leave: true,
      notice: ADMIN,
    });
    expect(
      planVoiceKick({ channelId: LOUNGE, reason: 'channel_deleted' }, { ...inLounge, state: 'reconnecting' }),
    ).toEqual({ leave: true, notice: DELETED });
    expect(
      planVoiceKick({ channelId: LOUNGE, reason: 'admin' }, { ...inLounge, state: 'connecting' }),
    ).toEqual({ leave: true, notice: ADMIN });
  });

  it('only explains when LiveKit already dropped us from that channel', () => {
    const dropped = { channelId: null, state: 'disconnected' as const, lastChannelId: LOUNGE };
    expect(planVoiceKick({ channelId: LOUNGE, reason: 'channel_deleted' }, dropped)).toEqual({
      leave: false,
      notice: DELETED,
    });
  });

  it('ignores kicks from a channel this tab is not (or was not last) in', () => {
    // We have since moved to another channel.
    expect(
      planVoiceKick(
        { channelId: LOUNGE, reason: 'admin' },
        { ...inLounge, channelId: OTHER, lastChannelId: OTHER },
      ),
    ).toEqual({ leave: false, notice: null });
    // Another tab of ours was the one in voice.
    expect(
      planVoiceKick(
        { channelId: LOUNGE, reason: 'admin' },
        { channelId: null, state: 'disconnected', lastChannelId: null },
      ),
    ).toEqual({ leave: false, notice: null });
  });

  it('does nothing for a deactivation (the session:revoked redirect ends voice)', () => {
    expect(planVoiceKick({ channelId: LOUNGE, reason: 'deactivated' }, inLounge)).toEqual({
      leave: false,
      notice: null,
    });
  });
});
