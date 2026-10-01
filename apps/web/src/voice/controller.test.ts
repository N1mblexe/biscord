import type { VoiceStatePayload, VoiceTokenResponse } from '@hearth/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n/store';
import {
  createVoiceController,
  voiceMessage,
  type LocalGate,
  type VoiceControllerDeps,
  type VoiceRoomPort,
} from './controller';
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

/**
 * A fake room and server that record every call in order. Camera and screen publishing wait on
 * `video.<kind>` when set (a deferred the test settles), else resolve at once. A start resolves with
 * named publications (`camera#1`, `screen#1` + `screen-audio#1`); `published` is what the fake
 * LiveKit really publishes, and `livekitConnected = false` makes `publishedVideo()` unknown.
 */
function harness(
  overrides: Omit<Partial<VoiceControllerDeps<string>>, 'room'> & {
    room?: Partial<VoiceRoomPort<string>>;
  } = {},
) {
  const log: string[] = [];
  const sent: VoiceStatePayload[] = [];
  const notices: string[] = [];
  const alerts: string[] = [];
  const video: { camera?: Deferred<undefined>; screen?: Deferred<undefined> } = {};
  const published = { camera: false, screen: false };
  const lk = { connected: true };
  let starts = 0;
  let micFails = false;
  const { room: roomOverrides, ...rest } = overrides;
  const deps: VoiceControllerDeps<string> = {
    room: {
      connect: (_url, jwt) => {
        log.push(`connect ${jwt}`);
        return Promise.resolve();
      },
      disconnect: () => {
        log.push('disconnect');
        published.camera = false;
        published.screen = false;
        return Promise.resolve();
      },
      setMicrophoneEnabled: (enabled, transmit) => {
        log.push(`mic ${enabled ? 'on' : 'off'}${enabled && !transmit ? ' gated' : ''}`);
        return micFails && enabled ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
      setMicGate: (open) => {
        log.push(`gate ${open ? 'open' : 'closed'}`);
        return Promise.resolve();
      },
      restartMic: (constraints) => {
        log.push(`restart ${JSON.stringify(constraints)}`);
        return Promise.resolve();
      },
      setCameraEnabled: async (enabled) => {
        log.push(`camera ${enabled ? 'on' : 'off'}`);
        if (!enabled) {
          published.camera = false;
          return [];
        }
        if (video.camera) await video.camera.promise;
        published.camera = true;
        starts += 1;
        return [`camera#${String(starts)}`];
      },
      setScreenShareEnabled: async (enabled, withAudio) => {
        log.push(`screen ${enabled ? `on audio=${String(withAudio)}` : 'off'}`);
        if (!enabled) {
          published.screen = false;
          return [];
        }
        if (video.screen) await video.screen.promise;
        published.screen = true;
        starts += 1;
        const n = String(starts);
        return withAudio ? [`screen#${n}`, `screen-audio#${n}`] : [`screen#${n}`];
      },
      unpublish: (pubs) => {
        log.push(`unpublish+stop ${pubs.join(' ')}`);
        for (const pub of pubs) {
          if (pub.startsWith('camera')) published.camera = false;
          if (pub.startsWith('screen#')) published.screen = false;
        }
        return Promise.resolve();
      },
      publishedVideo: () => (lk.connected ? { ...published } : null),
      ...roomOverrides,
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
    alert: (message) => {
      alerts.push(message);
    },
    ...rest,
  };
  return {
    controller: createVoiceController(deps),
    log,
    sent,
    notices,
    alerts,
    video,
    published,
    lk,
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
  it('joins: leave any old room (with the token request) → connect → mic on → voice:state', async () => {
    const { controller, log, sent } = harness();
    await controller.join(LOUNGE);
    await flush();
    expect(log).toEqual(['disconnect', `token ${LOUNGE}`, `connect jwt-${LOUNGE}`, 'mic on']);
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
    expect(log).toEqual(['disconnect', `token ${GAMES}`, `connect jwt-${GAMES}`, 'mic on']);
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connected' });
    expect(sent.at(-1)?.channelId).toBe(GAMES);
  });

  it('switching channels takes our mic, camera and screen out of the old room at once, not after the token', async () => {
    const pending = deferred<VoiceTokenResponse>();
    let hang = false;
    const h = harness({
      fetchToken: (channelId) => {
        h.log.push(`token ${channelId}`);
        return hang ? pending.promise : Promise.resolve(token(channelId));
      },
    });
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    h.controller.toggleScreen();
    await flush();
    expect(h.published).toEqual({ camera: true, screen: true });
    h.log.length = 0;

    // The token for the new room hangs: the old room is left anyway.
    hang = true;
    void h.controller.join(GAMES);
    expect(h.log).toEqual(['disconnect', `token ${GAMES}`]);
    expect(h.published).toEqual({ camera: false, screen: false });
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connecting', camera: 'off', screen: 'off' });
    // A mute while connecting is local only: nothing is live to apply it to.
    h.controller.toggleMute();
    await flush();
    expect(h.log).toEqual(['disconnect', `token ${GAMES}`]);

    pending.resolve(token(GAMES));
    await flush();
    expect(h.log.slice(2)).toEqual([`connect jwt-${GAMES}`, 'mic off']);
    expect(h.sent.at(-1)).toMatchObject({ channelId: GAMES, selfMute: true, camera: false, screen: false });
  });

  it('a token request that never answers times out: aborted, out of voice with a clear message', async () => {
    let signal: AbortSignal | undefined;
    const { controller, log, notices } = harness({
      tokenTimeoutMs: 20,
      fetchToken: (_channelId, s) => {
        signal = s;
        return new Promise(() => undefined); // hangs, ignoring the signal
      },
    });
    const joining = controller.join(LOUNGE);
    expect(session().state).toBe('connecting');
    await joining;
    expect(signal?.aborted).toBe(true);
    expect(session()).toMatchObject({ channelId: null, state: 'disconnected' });
    expect(notices).toEqual([voiceMessage('joinTimedOut')]);
    expect(log.filter((l) => l.startsWith('connect'))).toEqual([]);
  });

  it('a join overtaken by a leave aborts its token request, quietly', async () => {
    let signal: AbortSignal | undefined;
    const pending = deferred<VoiceTokenResponse>();
    const { controller, notices } = harness({
      fetchToken: (_channelId, s) => {
        signal = s;
        s.addEventListener('abort', () => {
          pending.reject(new DOMException('aborted', 'AbortError'));
        });
        return pending.promise;
      },
    });
    const joining = controller.join(LOUNGE);
    await controller.leave();
    await joining;
    expect(signal?.aborted).toBe(true);
    expect(session()).toMatchObject({ channelId: null, state: 'disconnected' });
    expect(notices).toEqual([]);
  });

  it('joining the channel we are in is a no-op', async () => {
    const { controller, log } = harness();
    await controller.join(LOUNGE);
    log.length = 0;
    await controller.join(LOUNGE);
    expect(log).toEqual([]);
  });

  it('a join overtaken by another join stops before connecting (its token request is aborted)', async () => {
    const tokens = new Map<string, Deferred<VoiceTokenResponse>>();
    const signals = new Map<string, AbortSignal>();
    const { controller, log } = harness({
      fetchToken: (channelId, signal) => {
        log.push(`token ${channelId}`);
        const d = deferred<VoiceTokenResponse>();
        tokens.set(channelId, d);
        signals.set(channelId, signal);
        return d.promise;
      },
    });
    const first = controller.join(LOUNGE);
    const second = controller.join(GAMES);
    expect(signals.get(LOUNGE)?.aborted).toBe(true);
    tokens.get(GAMES)?.resolve(token(GAMES));
    await second;
    tokens.get(LOUNGE)?.resolve(token(LOUNGE));
    await first;
    await flush();
    expect(log).toEqual([
      'disconnect',
      `token ${LOUNGE}`,
      'disconnect',
      `token ${GAMES}`,
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
    expect(notices).toEqual([voiceMessage('joinFailed')]);
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
    expect(h.notices).toEqual([voiceMessage('micUnavailable')]);
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
    expect(notices).toEqual([voiceMessage('dropped')]);
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

/** The camera/screen flags of the last `voice:state` sent. */
function lastFlags(sent: readonly VoiceStatePayload[]) {
  const last = sent.at(-1);
  return last ? { camera: last.camera, screen: last.screen } : undefined;
}

describe('camera and screen share controls', () => {
  it('camera: off → starting → on (flag sent) → stop (flag cleared at once) → off', async () => {
    const h = harness();
    h.video.camera = deferred();
    await h.controller.join(LOUNGE);
    await flush();
    h.log.length = 0;

    h.controller.toggleCamera();
    expect(session().camera).toBe('starting');
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: false });
    // A second click while the browser is still asking does nothing.
    h.controller.toggleCamera();
    h.video.camera.resolve(undefined);
    await flush();
    expect(session().camera).toBe('on');
    expect(h.log).toEqual(['camera on']);
    expect(h.sent.at(-1)).toEqual({
      channelId: LOUNGE,
      selfMute: false,
      selfDeaf: false,
      camera: true,
      screen: false,
    });

    h.controller.toggleCamera();
    expect(session().camera).toBe('stopping');
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: false });
    await flush();
    expect(session().camera).toBe('off');
    expect(h.log).toEqual(['camera on', 'camera off']);
    expect(h.alerts).toEqual([]);
  });

  it('screen share asks for tab audio per the checkbox', async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleScreen();
    await flush();
    expect(session().screen).toBe('on');
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: true });
    h.controller.toggleScreen();
    await flush();
    session().set({ shareTabAudio: false });
    h.controller.toggleScreen();
    await flush();
    expect(h.log.filter((l) => l.startsWith('screen'))).toEqual([
      'screen on audio=true',
      'screen off',
      'screen on audio=false',
    ]);
  });

  it('a cancelled or denied screen share alerts and leaves everything off', async () => {
    const h = harness();
    h.video.screen = deferred();
    await h.controller.join(LOUNGE);
    await flush();
    const sentBefore = h.sent.length;
    h.controller.toggleScreen();
    h.video.screen.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await flush();
    expect(session().screen).toBe('off');
    expect(session().state).toBe('connected');
    expect(h.alerts).toEqual([voiceMessage('screenBlocked')]);
    // Nothing changed, so nothing new is sent; the last state still says not sharing.
    expect(h.sent.length).toBe(sentBefore);
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: false });
  });

  it('an unavailable camera alerts with its own message', async () => {
    const h = harness({ room: { setCameraEnabled: () => Promise.reject(new Error('NotFoundError')) } });
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    await flush();
    expect(session().camera).toBe('off');
    expect(h.alerts).toEqual([voiceMessage('cameraBlocked')]);
  });

  it("the browser's own stop sharing turns the screen off and clears the flag", async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleScreen();
    h.controller.toggleCamera();
    await flush();
    expect(lastFlags(h.sent)).toEqual({ camera: true, screen: true });

    h.controller.onLocalVideoEnded('screen');
    expect(session().screen).toBe('off');
    expect(session().camera).toBe('on');
    expect(lastFlags(h.sent)).toEqual({ camera: true, screen: false });
    // The unpublish event that follows our own stop is a no-op.
    const count = h.sent.length;
    h.controller.onLocalVideoEnded('screen');
    expect(h.sent.length).toBe(count);
  });

  it('the track event from our own stop does not send twice', async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    await flush();
    h.controller.toggleCamera();
    const count = h.sent.length;
    h.controller.onLocalVideoEnded('camera');
    await flush();
    expect(h.sent.length).toBe(count);
    expect(session().camera).toBe('off');
  });

  it('a track that ends while starting is unpublished instead of turned on', async () => {
    const h = harness();
    h.video.screen = deferred();
    await h.controller.join(LOUNGE);
    h.controller.toggleScreen();
    h.controller.onLocalVideoEnded('screen');
    h.video.screen.resolve(undefined);
    await flush();
    expect(session().screen).toBe('off');
    expect(h.log.filter((l) => l.startsWith('screen') || l.startsWith('unpublish'))).toEqual([
      'screen on audio=true',
      'unpublish+stop screen#1 screen-audio#1',
    ]);
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: false });
  });

  it('mute and deafen keep the video flags', async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    await flush();
    h.controller.toggleDeafen();
    expect(h.sent.at(-1)).toMatchObject({ selfMute: true, selfDeaf: true, camera: true, screen: false });
  });

  it('needs a room; leaving or dropping resets both to off, and a late result is ignored', async () => {
    const h = harness();
    h.controller.toggleCamera();
    expect(session().camera).toBe('off');

    h.video.camera = deferred();
    await h.controller.join(LOUNGE);
    h.controller.toggleScreen();
    await flush();
    h.controller.toggleCamera();
    await h.controller.leave();
    expect(session()).toMatchObject({ camera: 'off', screen: 'off' });
    h.video.camera.reject(new Error('aborted'));
    await flush();
    expect(h.alerts).toEqual([]);
    expect(session().camera).toBe('off');

    await h.controller.join(GAMES);
    h.video.camera = undefined;
    h.controller.toggleCamera();
    await flush();
    h.controller.onDisconnected();
    expect(session()).toMatchObject({ state: 'disconnected', camera: 'off', screen: 'off' });
  });
});

describe('camera and screen share: what LiveKit really publishes wins', () => {
  it('leave while starting, then a late resolve: unpublished and stopped, state stays off', async () => {
    const h = harness();
    h.video.camera = deferred();
    await h.controller.join(LOUNGE);
    await flush();
    h.controller.toggleCamera();
    expect(session().camera).toBe('starting');
    await h.controller.leave();
    expect(session()).toMatchObject({ state: 'disconnected', camera: 'off' });

    // The browser grants the camera after we left: LiveKit publishes, and it must go at once.
    h.video.camera.resolve(undefined);
    await flush();
    expect(h.log.at(-1)).toBe('unpublish+stop camera#1');
    expect(h.published.camera).toBe(false);
    expect(session().camera).toBe('off');
    expect(h.sent.some((p) => p.camera)).toBe(false);
  });

  it('switching rooms while the picker is open: the late share is unpublished from the next room', async () => {
    const h = harness();
    h.video.screen = deferred();
    await h.controller.join(LOUNGE);
    await flush();
    h.controller.toggleScreen();
    await h.controller.join(GAMES);
    await flush();
    h.video.screen.resolve(undefined);
    await flush();
    expect(h.log.at(-1)).toBe('unpublish+stop screen#1 screen-audio#1');
    expect(h.published.screen).toBe(false);
    expect(session()).toMatchObject({ channelId: GAMES, state: 'connected', screen: 'off' });
    expect(h.sent.some((p) => p.screen)).toBe(false);
  });

  it("the browser's own Stop sharing runs the button's stop (screen audio goes too)", async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleScreen();
    await flush();
    h.log.length = 0;
    h.controller.onLocalVideoEnded('screen');
    await flush();
    expect(h.log).toEqual(['screen off']);
    expect(session().screen).toBe('off');
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: false });
  });

  it('a reconnect that republishes everything keeps the state; one that lost a track turns it off', async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    h.controller.toggleScreen();
    await flush();

    h.lk.connected = false;
    h.controller.onReconnecting();
    h.lk.connected = true;
    h.controller.onReconnected();
    expect(session()).toMatchObject({ state: 'connected', camera: 'on', screen: 'on' });
    expect(lastFlags(h.sent)).toEqual({ camera: true, screen: true });

    // This time LiveKit couldn't republish the camera.
    h.lk.connected = false;
    h.controller.onReconnecting();
    h.published.camera = false;
    h.lk.connected = true;
    h.controller.onReconnected();
    expect(session()).toMatchObject({ state: 'connected', camera: 'off', screen: 'on' });
    expect(lastFlags(h.sent)).toEqual({ camera: false, screen: true });
  });

  it("resync never fights the server's reconcile with a flag LiveKit doesn't back", async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    h.controller.toggleCamera();
    h.controller.toggleScreen();
    await flush();
    const server = { selfMute: false, selfDeaf: false, camera: true, screen: true };

    // LiveKit lost our screen; the server's reconcile saw that and cleared the flag.
    h.published.screen = false;
    const count = h.sent.length;
    h.controller.syncState({ ...server, screen: false });
    expect(session().screen).toBe('off');
    expect(h.sent.length).toBe(count);
    // The next voice:updated agrees with us: still nothing to send, and no flapping.
    h.controller.syncState({ ...server, screen: false });
    expect(h.sent.length).toBe(count);

    // A camera LiveKit really publishes is re-asserted when the server lists it off.
    h.controller.syncState({ ...server, camera: false, screen: false });
    expect(lastFlags(h.sent)).toEqual({ camera: true, screen: false });

    // While LiveKit reconnects nothing is re-sent; onReconnected sends the truth.
    h.lk.connected = false;
    const before = h.sent.length;
    h.controller.syncState({ ...server, camera: false, screen: false });
    expect(h.sent.length).toBe(before);
  });

  it('anything published while the UI says off is stopped', async () => {
    const h = harness();
    await h.controller.join(LOUNGE);
    await flush();
    h.published.camera = true;
    h.log.length = 0;
    h.controller.syncState({ selfMute: false, selfDeaf: false, camera: false, screen: false });
    await flush();
    expect(h.log).toEqual(['camera off']);
    expect(h.published.camera).toBe(false);
    expect(session().camera).toBe('off');
  });
});

const PTT_IDLE: LocalGate = { inputMode: 'ptt', pttActive: false, vadGate: false, vadOpen: false };
const PTT_HELD: LocalGate = { ...PTT_IDLE, pttActive: true };

describe('local gate and mic restarts (CONTRACTS B.12 rule 2)', () => {
  it('defaults: always transmitting while in a room; resets on leave', async () => {
    const { controller, log } = harness();
    expect(session().transmitting).toBe(false);
    await controller.join(LOUNGE);
    await flush();
    expect(log.at(-1)).toBe('mic on');
    expect(session().transmitting).toBe(true);
    await controller.leave();
    expect(session()).toMatchObject({ transmitting: false, pttActive: false });
  });

  it('push-to-talk set before joining: the first publish stays muted until the key is held', async () => {
    const { controller, log } = harness();
    controller.setGate(PTT_IDLE);
    await controller.join(LOUNGE);
    await flush();
    expect(log.filter((l) => l.startsWith('mic') || l.startsWith('gate'))).toEqual(['mic on gated']);
    expect(session().transmitting).toBe(false);

    controller.setGate(PTT_HELD);
    expect(session().transmitting).toBe(true);
    await flush();
    controller.setGate(PTT_IDLE);
    await flush();
    expect(log.slice(-2)).toEqual(['gate open', 'gate closed']);
    expect(session().transmitting).toBe(false);
  });

  it('an input change that does not change the gate is not applied again', async () => {
    const { controller, log } = harness();
    await controller.join(LOUNGE);
    await flush();
    log.length = 0;
    controller.setGate({ inputMode: 'voice', pttActive: true, vadGate: false, vadOpen: false });
    controller.setGate({ inputMode: 'voice', pttActive: false, vadGate: true, vadOpen: true });
    await flush();
    expect(log).toEqual([]);
  });

  it('the gate never unmutes the mic while muted or deafened', async () => {
    const { controller, log, sent } = harness();
    await controller.join(LOUNGE);
    controller.setGate(PTT_IDLE);
    await flush();
    controller.toggleMute();
    await flush();
    log.length = 0;

    // Muted: holding the key changes nothing on the track and doesn't transmit.
    controller.setGate(PTT_HELD);
    await flush();
    expect(log).toEqual([]);
    expect(session().transmitting).toBe(false);

    // Unmuting with the key held transmits; letting go gates it again.
    controller.toggleMute();
    await flush();
    expect(log).toEqual(['mic on']);
    expect(session().transmitting).toBe(true);

    // Deafened (self-mutes): the gate toggling stays out of it.
    controller.toggleDeafen();
    controller.setGate(PTT_IDLE);
    controller.setGate(PTT_HELD);
    await flush();
    expect(log).toEqual(['mic on', 'mic off']);
    expect(session().transmitting).toBe(false);

    // Undeafen with the key released: published again, but gated.
    controller.setGate(PTT_IDLE);
    controller.toggleDeafen();
    await flush();
    expect(log.at(-1)).toBe('mic on gated');
    expect(session().transmitting).toBe(false);
    // The gate is local only: voice:state still says unmuted.
    expect(sent.at(-1)).toMatchObject({ selfMute: false, selfDeaf: false });
  });

  it('restartMic is serialized with mute toggles and the gate', async () => {
    const gates: Deferred<undefined>[] = [];
    const h = harness({
      room: {
        setMicrophoneEnabled: async (enabled, transmit) => {
          h.log.push(`mic ${enabled ? 'on' : 'off'}${enabled && !transmit ? ' gated' : ''} start`);
          const d = deferred<undefined>();
          gates.push(d);
          await d.promise;
          h.log.push(`mic ${enabled ? 'on' : 'off'} done`);
        },
        restartMic: (constraints) => {
          h.log.push(`restart ${JSON.stringify(constraints.echoCancellation)}`);
          return Promise.resolve();
        },
      },
    });
    const join = h.controller.join(LOUNGE);
    await join;
    await flush();
    gates.shift()?.resolve(undefined);
    await flush();
    h.log.length = 0;

    // A mute is in flight (LiveKit hasn't answered): the restart and the unmute wait their turn.
    h.controller.toggleMute();
    await flush();
    const restarted = h.controller.restartMic({ echoCancellation: false });
    h.controller.toggleMute();
    await flush();
    expect(h.log).toEqual(['mic off start']);
    gates.shift()?.resolve(undefined);
    await flush();
    expect(h.log).toEqual(['mic off start', 'mic off done', 'restart false', 'mic on start']);
    gates.shift()?.resolve(undefined);
    await restarted;
    await flush();
    expect(h.log.at(-1)).toBe('mic on done');
  });

  it('a failed restart rejects but the mic queue keeps going; outside a room it is a no-op', async () => {
    const h = harness({
      room: {
        restartMic: () => {
          h.log.push('restart');
          return Promise.reject(new Error('NotReadableError'));
        },
      },
    });
    await h.controller.restartMic({});
    expect(h.log).toEqual([]);

    await h.controller.join(LOUNGE);
    await flush();
    h.log.length = 0;
    await expect(h.controller.restartMic({})).rejects.toThrow('NotReadableError');
    h.controller.toggleMute();
    await flush();
    expect(h.log).toEqual(['restart', 'mic off']);
  });

  it('an unavailable mic stops transmitting', async () => {
    const h = harness();
    h.failMic();
    await h.controller.join(LOUNGE);
    await flush();
    expect(session()).toMatchObject({ micMuted: true, transmitting: false });
  });
});

describe('voiceMessage', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: 'en' });
  });

  it('keeps the English notice and alert text', () => {
    expect(voiceMessage('joinFailed')).toBe("Couldn't join the voice channel. Try again.");
    expect(voiceMessage('joinTimedOut')).toBe('The voice server took too long to answer. Try joining again.');
    expect(voiceMessage('micUnavailable')).toBe(
      'Microphone unavailable: check the browser permission. You joined muted.',
    );
    expect(voiceMessage('dropped')).toBe('You were disconnected from voice.');
    expect(voiceMessage('cameraBlocked')).toBe('Camera is unavailable or blocked');
    expect(voiceMessage('screenBlocked')).toBe('Screen share was cancelled or blocked');
    expect(voiceMessage('micLost')).toBe('Microphone disconnected — using the default device.');
    expect(voiceMessage('switchFailed')).toBe("Couldn't switch to that device.");
  });

  it('is translated when it is shown, not when the module loads', () => {
    useLocaleStore.setState({ locale: 'tr' });
    expect(voiceMessage('dropped')).toBe('Ses bağlantınız kesildi.');
    expect(voiceMessage('screenBlocked')).toBe('Ekran paylaşımı iptal edildi ya da engellendi');
  });
});
