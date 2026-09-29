import { VideoTrack, useTracks, type TrackReference } from '@livekit/components-react';
import { useQuery } from '@tanstack/react-query';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { useState } from 'react';
import { bootstrapQuery } from '../api/chat';
import { useVoiceRoom } from './context';
import { INITIAL_FOCUS, reduceFocus, tileKey, tilesChanged, type TileInfo, type TileSource } from './focus';
import { useVoiceSession } from './session';

const VIDEO_SOURCES = [Track.Source.Camera, Track.Source.ScreenShare];
/** On top of useTracks' publish/subscribe events: a stopped camera is a muted publication. */
const UPDATE_ON = [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted];

interface Tile extends TileInfo {
  trackRef: TrackReference;
  label: string;
}

/**
 * The video stage (`data-testid="video-stage"`, docs/plans/phase-7.md "Web UI contract"): shown
 * above the page while we are in voice and at least one camera or screen share is on, ours
 * included. A grid by default; clicking a tile focuses it (a large view plus a strip of the rest).
 * Tiles are sized by the layout, and LiveKit's adaptive stream picks each remote's quality from the
 * size and visibility of its `<video>`, so strip tiles get the low simulcast layers.
 */
export function VideoStage() {
  const room = useVoiceRoom();
  const live = useVoiceSession((s) => s.state === 'connected' || s.state === 'reconnecting');
  return live ? <Stage room={room} /> : null;
}

function Stage({ room }: { room: Room }) {
  const trackRefs = useTracks(VIDEO_SOURCES, { room, onlySubscribed: true, updateOnlyOn: UPDATE_ON });
  const { data: boot } = useQuery(bootstrapQuery);
  const [focusState, setFocusState] = useState(INITIAL_FOCUS);

  const tiles: Tile[] = trackRefs
    .filter((ref) => !ref.publication.isMuted)
    .map((ref) => {
      const userId = ref.participant.identity;
      const source: TileSource = ref.source === Track.Source.ScreenShare ? 'screen_share' : 'camera';
      const name =
        boot?.users.find((u) => u.id === userId)?.displayName ?? (ref.participant.name || 'Unknown user');
      return {
        key: tileKey(userId, source),
        userId,
        source,
        local: ref.participant.isLocal,
        trackRef: ref,
        label: source === 'screen_share' ? `${name} (screen)` : name,
      };
    });

  // Keep the focus in step with the tiles during render (auto-focus a new screen share, fall back
  // when the focused tile goes away) instead of one frame late from an effect.
  let focus = focusState;
  if (tilesChanged(focusState, tiles)) {
    focus = reduceFocus(focusState, { type: 'tiles', tiles });
    setFocusState(focus);
  }

  if (tiles.length === 0) return null;

  const select = (key: string) => {
    setFocusState((s) => reduceFocus(s, { type: 'select', key }));
  };
  const focused = tiles.find((t) => t.key === focus.focused);
  const others = focused ? tiles.filter((t) => t !== focused) : tiles;

  return (
    <section
      data-testid="video-stage"
      aria-label="Video"
      className="flex h-[45vh] min-h-56 shrink-0 flex-col gap-2 border-b border-white/5 bg-black/30 p-2"
    >
      {focused ? (
        <>
          <div className="flex min-h-0 flex-1 gap-2">
            <VideoTile tile={focused} focused onSelect={select} className="min-h-0 flex-1" />
          </div>
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
            {others.map((t) => (
              <VideoTile
                key={t.key}
                tile={t}
                focused={false}
                onSelect={select}
                className="h-20 w-36 shrink-0"
              />
            ))}
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-muted ring-1 ring-white/10 transition hover:bg-white/10 hover:text-text"
              onClick={() => {
                setFocusState((s) => reduceFocus(s, { type: 'grid' }));
              }}
            >
              Grid view
            </button>
          </div>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2 overflow-y-auto">
          {tiles.map((t) => (
            <VideoTile key={t.key} tile={t} focused={false} onSelect={select} className="min-h-32" />
          ))}
        </div>
      )}
    </section>
  );
}

function VideoTile({
  tile,
  focused,
  onSelect,
  className,
}: {
  tile: Tile;
  focused: boolean;
  onSelect: (key: string) => void;
  className: string;
}) {
  // Our own camera is mirrored, like a mirror; screens never are.
  const mirrored = tile.local && tile.source === 'camera';
  return (
    <button
      type="button"
      data-testid="video-tile"
      data-user-id={tile.userId}
      data-source={tile.source}
      data-focused={focused ? 'true' : 'false'}
      title={focused ? undefined : `Focus ${tile.label}`}
      className={`relative overflow-hidden rounded-lg bg-black text-left ring-1 transition focus-visible:outline-2 focus-visible:outline-accent ${
        focused ? 'ring-accent/60' : 'ring-white/10 hover:ring-white/30'
      } ${className}`}
      onClick={() => {
        onSelect(tile.key);
      }}
    >
      <VideoTrack
        trackRef={tile.trackRef}
        className={`absolute inset-0 size-full object-contain ${mirrored ? '-scale-x-100' : ''}`}
      />
      <span className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
        {tile.label}
      </span>
    </button>
  );
}
