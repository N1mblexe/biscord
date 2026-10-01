import type { VoiceStatePayload } from '@hearth/shared';
import { ConnectionState, RoomEvent, Track, TrackEvent, type Room } from 'livekit-client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createVoiceController, type LocalVideoKind } from './controller';
import { watchLocalVideo } from './localVideo';
import { useVoiceSession } from './session';

const LOUNGE = '11111111-1111-4111-8111-111111111111';

type Listener = (...args: unknown[]) => void;

/** The part of LiveKit's event emitters the watcher uses. */
class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== fn),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  count(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

class FakeTrack extends FakeEmitter {
  constructor(readonly source: Track.Source) {
    super();
  }
}

interface FakePub {
  source: Track.Source;
  track: FakeTrack | undefined;
}

/**
 * A LiveKit room as the watcher sees it: a connection state, room events, and the local
 * publications (what `publishedVideo` reads).
 */
class FakeRoom extends FakeEmitter {
  state: ConnectionState = ConnectionState.Connected;
  readonly pubs = new Map<Track.Source, FakePub>();
  readonly localParticipant = {
    isLocal: true,
    trackPublications: new Map<string, FakePub>(),
  };

  publish(source: Track.Source, track = new FakeTrack(source)): FakePub {
    const pub = { source, track };
    this.pubs.set(source, pub);
    this.localParticipant.trackPublications.set(source, pub);
    this.emit(RoomEvent.LocalTrackPublished, pub, this.localParticipant);
    return pub;
  }

  unpublish(source: Track.Source): void {
    const pub = this.pubs.get(source);
    if (!pub) return;
    this.pubs.delete(source);
    this.localParticipant.trackPublications.delete(source);
    this.emit(RoomEvent.LocalTrackUnpublished, pub, this.localParticipant);
  }

  /** LiveKit's full reconnect: `republishAllTracks` while `Reconnecting`, then `Reconnected`. */
  fullReconnect(): void {
    this.state = ConnectionState.Reconnecting;
    const pubs = [...this.pubs.values()];
    for (const pub of pubs) this.unpublish(pub.source);
    for (const pub of pubs) this.publish(pub.source, pub.track);
    this.state = ConnectionState.Connected;
  }

  asRoom(): Room {
    // The watcher only touches the members faked here.
    return this as unknown as Room;
  }
}

const session = () => useVoiceSession.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A real controller on a fake LiveKit room, wired through `watchLocalVideo` like VoiceProvider. */
function setup() {
  const room = new FakeRoom();
  const sent: VoiceStatePayload[] = [];
  const ended: LocalVideoKind[] = [];
  const controller = createVoiceController<FakePub>({
    room: {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      setMicrophoneEnabled: () => Promise.resolve(),
      setMicGate: () => Promise.resolve(),
      restartMic: () => Promise.resolve(),
      setCameraEnabled: (enabled) => {
        if (!enabled) {
          room.unpublish(Track.Source.Camera);
          return Promise.resolve([]);
        }
        return Promise.resolve([room.publish(Track.Source.Camera)]);
      },
      setScreenShareEnabled: (enabled) => {
        if (!enabled) {
          room.unpublish(Track.Source.ScreenShare);
          room.unpublish(Track.Source.ScreenShareAudio);
          return Promise.resolve([]);
        }
        return Promise.resolve([
          room.publish(Track.Source.ScreenShare),
          room.publish(Track.Source.ScreenShareAudio),
        ]);
      },
      unpublish: (pubs) => {
        for (const pub of pubs) room.unpublish(pub.source);
        return Promise.resolve();
      },
      publishedVideo: () =>
        room.state === ConnectionState.Connected
          ? { camera: room.pubs.has(Track.Source.Camera), screen: room.pubs.has(Track.Source.ScreenShare) }
          : null,
    },
    fetchToken: (channelId) =>
      Promise.resolve({
        token: 'jwt',
        url: 'ws://livekit.test',
        roomName: `voice_${channelId}`,
        expiresAt: '2026-09-29T10:10:00.000Z',
      }),
    sendState: (payload) => {
      sent.push(payload);
    },
    notify: () => undefined,
    alert: () => undefined,
  });
  const unwatch = watchLocalVideo(room.asRoom(), (kind) => {
    ended.push(kind);
    controller.onLocalVideoEnded(kind);
  });
  return { room, controller, sent, ended, unwatch };
}

async function sharingBoth() {
  const t = setup();
  await t.controller.join(LOUNGE);
  t.controller.toggleCamera();
  t.controller.toggleScreen();
  await flush();
  expect(session()).toMatchObject({ camera: 'on', screen: 'on' });
  return t;
}

beforeEach(() => {
  session().reset();
});

describe('local camera and screen: ended vs. a reconnect', () => {
  it("a full reconnect's unpublish + republish changes nothing", async () => {
    const t = await sharingBoth();
    const sentBefore = t.sent.length;
    t.controller.onReconnecting();
    t.room.fullReconnect();
    t.controller.onReconnected();
    await flush();
    expect(t.ended).toEqual([]);
    expect(session()).toMatchObject({ state: 'connected', camera: 'on', screen: 'on' });
    expect(t.room.pubs.has(Track.Source.ScreenShare)).toBe(true);
    expect(t.room.pubs.has(Track.Source.ScreenShareAudio)).toBe(true);
    // The re-sent state after the reconnect still says both are on.
    expect(t.sent.length).toBe(sentBefore + 1);
    expect(t.sent.at(-1)).toMatchObject({ camera: true, screen: true });
  });

  it("the screen track's own ended (browser's Stop sharing) turns it off and removes its audio", async () => {
    const t = await sharingBoth();
    // Republished twice: still one listener on the same track.
    t.room.fullReconnect();
    t.room.fullReconnect();
    const track = t.room.pubs.get(Track.Source.ScreenShare)?.track;
    expect(track?.count(TrackEvent.Ended)).toBe(1);

    const sentBefore = t.sent.length;
    track?.emit(TrackEvent.Ended, track);
    await flush();
    // (Our own stop's unpublish echoes back as a second, ignored "ended".)
    expect(t.ended[0]).toBe('screen');
    expect(t.sent.length).toBe(sentBefore + 1);
    expect(session()).toMatchObject({ camera: 'on', screen: 'off' });
    expect(t.room.pubs.has(Track.Source.ScreenShare)).toBe(false);
    expect(t.room.pubs.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(t.sent.at(-1)).toMatchObject({ camera: true, screen: false });
  });

  it('LiveKit muting a camera it could not restart turns the camera off; a remote mute does not', async () => {
    const t = await sharingBoth();
    const camera = t.room.pubs.get(Track.Source.Camera);
    t.room.emit(RoomEvent.TrackMuted, camera, { isLocal: false });
    expect(session().camera).toBe('on');
    t.room.emit(RoomEvent.TrackMuted, camera, t.room.localParticipant);
    expect(t.ended[0]).toBe('camera');
    expect(session().camera).toBe('off');
    expect(t.sent.at(-1)).toMatchObject({ camera: false, screen: true });
  });

  it('an unpublish while connected (not ours, not a reconnect) counts as ended', async () => {
    const t = await sharingBoth();
    t.room.unpublish(Track.Source.ScreenShare);
    await flush();
    expect(session().screen).toBe('off');
    expect(t.room.pubs.has(Track.Source.ScreenShareAudio)).toBe(false);
  });

  it('unsubscribes from the room and the tracks', async () => {
    const t = await sharingBoth();
    const track = t.room.pubs.get(Track.Source.ScreenShare)?.track;
    t.unwatch();
    expect(t.room.count(RoomEvent.LocalTrackPublished)).toBe(0);
    expect(t.room.count(RoomEvent.LocalTrackUnpublished)).toBe(0);
    expect(t.room.count(RoomEvent.TrackMuted)).toBe(0);
    expect(track?.count(TrackEvent.Ended)).toBe(0);
  });
});
