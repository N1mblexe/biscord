import type { VoiceStatePayload, VoiceTokenResponse } from '@hearth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createVoiceController, VOICE_MESSAGES, type VoiceControllerDeps } from './controller';
import { useVoiceSession } from './session';

const LOUNGE = '11111111-1111-4111-8111-111111111111';
const GAMES = '22222222-2222-4222-8222-222222222222';

function token(channelId: string): VoiceTokenResponse {
  return {
    token: `jwt-${channelId}`,
    url: 'ws://livekit.test',
    roomName: `voice_${channelId}`,
    expiresAt: '2026-09-29T10:10:00.000Z',
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued promise callbacks (the mic queue) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake room and server that record every call in order. */
function harness(overrides: Partial<VoiceControllerDeps> = {}) {
  const log: string[] = [];
  const sent: VoiceStatePayload[] = [];
  const notices: string[] = [];
  let micFails = false;
  const deps: VoiceControllerDeps = {
    room: {
      connect: (_url, jwt) => {
        log.push(`connect ${jwt}`);
        return Promise.resolve();
      },
      disconnect: () => {
        log.push('disconnect');
        return Promise.resolve();
      },
      setMicrophoneEnabled: (enabled) => {
        log.push(`mic ${enabled ? 'on' : 'off'}`);
        return micFails && enabled ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
    },
    fetchToken: (channelId) => {
      log.push(`token ${channelId}`);
      return Promise.resolve(token(channelId));
    },
    sendState: (payload) => {
      sent.push(payload);
    },
    notify: (message) => {
      notices.push(message);
    },
    ...overrides,
  };
  return {
    controller: createVoiceController(deps),
    log,
    sent,
    notices,
    failMic: () => {
      micFails = true;
    },
  };
}

const session = () => useVoiceSession.getState();

beforeEach(() => {
  session().reset();
});

describe('voice controller', () => {
  it('joins: token → leave any old room → connect → mic on → voice:state', async () => {
    const { controller, log, sent } = harness();
    await controller.join(LOUNGE);
    await flush();
    expect(log).toEqual([`token ${LOUNGE}`, 'disconnect', `connect jwt-${LOUNGE}`, 'mic on']);
    expect(session()).toMatchObject({ channelId: LOUNGE, roomName: `voice_${LOUNGE}`, state: 'connected' });
    expect(sent).toEqual([
      { channelId: LOUNGE, selfMute: false, selfDeaf: false, camera: false, screen: false },
    ]);
  });

  it('switching channels leaves the old room before connecting to the new one', async () => {
    const { controller, log, sent } = harness();
    await controller.join(LOUNGE);
    await flush();
    log.length = 0;
    await controller.join(GAMES);
    await flush();
    expect(log).toEqual([`token ${GAMES}`, 'disconnect', `connect jwt-${GAMES}`, 'mic on']);
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connected' });
    expect(sent.at(-1)?.channelId).toBe(GAMES);
  });

  it('joining the channel we are in is a no-op', async () => {
    const { controller, log } = harness();
    await controller.join(LOUNGE);
    log.length = 0;
    await controller.join(LOUNGE);
    expect(log).toEqual([]);
  });

  it('a join overtaken by another join stops before touching the room', async () => {
    const tokens = new Map<string, Deferred<VoiceTokenResponse>>();
    const { controller, log } = harness({
      fetchToken: (channelId) => {
        log.push(`token ${channelId}`);
        const d = deferred<VoiceTokenResponse>();
        tokens.set(channelId, d);
        return d.promise;
      },
    });
    const first = controller.join(LOUNGE);
    const second = controller.join(GAMES);
    tokens.get(GAMES)?.resolve(token(GAMES));
    await second;
    tokens.get(LOUNGE)?.resolve(token(LOUNGE));
    await first;
    await flush();
    expect(log).toEqual([
      `token ${LOUNGE}`,
      `token ${GAMES}`,
      'disconnect',
      `connect jwt-${GAMES}`,
      'mic on',
    ]);
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connected' });
  });

  it('leave during connect wins: the join ends quietly and we stay out', async () => {
    const connecting = deferred<undefined>();
    let pending = false;
    const { controller, log, notices } = harness({
      room: {
        connect: () => {
          log.push('connect');
          pending = true;
          return connecting.promise;
        },
        disconnect: () => {
          log.push('disconnect');
          // A real Room aborts a pending connect when disconnected.
          if (pending) connecting.reject(new Error('aborted'));
          return Promise.resolve();
        },
        setMicrophoneEnabled: () => {
          log.push('mic');
          return Promise.resolve();
        },
      },
    });
    const joining = controller.join(LOUNGE);
    await flush();
    expect(session().state).toBe('connecting');
    await controller.leave();
    await joining;
    await flush();
    expect(session()).toMatchObject({ channelId: null, state: 'disconnected' });
    expect(log).not.toContain('mic');
    expect(notices).toEqual([]);
  });

  it('a failed token request leaves voice with a message', async () => {
    const { controller, notices } = harness({ fetchToken: () => Promise.reject(new Error('503')) });
    await controller.join(LOUNGE);
    expect(session()).toMatchObject({ channelId: null, state: 'disconnected' });
    expect(notices).toEqual([VOICE_MESSAGES.joinFailed]);
  });

  it('deafen self-mutes and undeafen restores the earlier mic state, each sent to the server', async () => {
    const { controller, log, sent } = harness();
    await controller.join(LOUNGE);
    await flush();
    log.length = 0;
    sent.length = 0;

    // Each change is applied to the mic (one at a time, always the latest desired state).
    controller.toggleMute();
    await flush();
    controller.toggleDeafen();
    await flush();
    controller.toggleDeafen();
    await flush();
    expect(session()).toMatchObject({ micMuted: true, deafened: false });
    expect(sent.map((s) => [s.selfMute, s.selfDeaf])).toEqual([
      [true, false],
      [true, true],
      [true, false],
    ]);
    expect(log).toEqual(['mic off', 'mic off', 'mic off']);

    controller.toggleMute();
    await flush();
    controller.toggleDeafen();
    await flush();
    controller.toggleDeafen();
    await flush();
    expect(session()).toMatchObject({ micMuted: false, deafened: false });
    expect(log.slice(3)).toEqual(['mic on', 'mic off', 'mic on']);
  });

  it('rapid toggles settle on the final mic state', async () => {
    const { controller, log } = harness();
    await controller.join(LOUNGE);
    await flush();
    log.length = 0;
    controller.toggleMute();
    controller.toggleMute();
    controller.toggleDeafen();
    await flush();
    expect(log.at(-1)).toBe('mic off');
    controller.toggleDeafen();
    await flush();
    expect(log.at(-1)).toBe('mic on');
  });

  it('mute state set before joining applies on connect', async () => {
    const { controller, log, sent } = harness();
    controller.toggleDeafen();
    expect(sent).toEqual([]);
    await controller.join(LOUNGE);
    await flush();
    expect(log.at(-1)).toBe('mic off');
    expect(sent).toEqual([
      { channelId: LOUNGE, selfMute: true, selfDeaf: true, camera: false, screen: false },
    ]);
  });

  it('an unavailable mic leaves us joined but muted', async () => {
    const h = harness();
    h.failMic();
    await h.controller.join(LOUNGE);
    await flush();
    expect(session()).toMatchObject({ state: 'connected', micMuted: true });
    expect(h.notices).toEqual([VOICE_MESSAGES.micUnavailable]);
    expect(h.sent.at(-1)).toMatchObject({ selfMute: true, selfDeaf: false });
  });

  it('reconnecting and an unexpected disconnect', async () => {
    const { controller, notices } = harness();
    await controller.join(LOUNGE);
    controller.onReconnecting();
    expect(session().state).toBe('reconnecting');
    controller.onReconnected();
    expect(session().state).toBe('connected');
    controller.onDisconnected();
    expect(session()).toMatchObject({ channelId: null, state: 'disconnected' });
    expect(notices).toEqual([VOICE_MESSAGES.dropped]);
  });

  it('ignores the disconnect of the old room while switching, and of a room we left', async () => {
    // The real Room emits Disconnected from inside disconnect().
    const events: { onDisconnect?: () => void } = {};
    const { controller, notices } = harness({
      room: {
        connect: () => Promise.resolve(),
        disconnect: () => {
          events.onDisconnect?.();
          return Promise.resolve();
        },
        setMicrophoneEnabled: () => Promise.resolve(),
      },
    });
    events.onDisconnect = () => {
      controller.onDisconnected();
    };
    await controller.join(LOUNGE);
    await controller.join(GAMES);
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connected' });
    await controller.leave();
    expect(session().state).toBe('disconnected');
    expect(notices).toEqual([]);
  });
});
