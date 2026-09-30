import { VideoTrack, useTracks, type TrackReference } from '@livekit/components-react';
import { useQuery } from '@tanstack/react-query';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { useState, type CSSProperties } from 'react';
import { bootstrapQuery } from '../api/chat';
import { useVoiceRoom } from './context';
import { INITIAL_FOCUS, reduceFocus, tileKey, tilesChanged, type TileInfo, type TileSource } from './focus';
import { useIsSpeakingInMyRoom, useVoiceSession } from './session';
import { stageGrid, tileFit } from './stageLayout';

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

  const wide = stageGrid(tiles.length, false);
  const narrow = stageGrid(tiles.length, true);
  const gridVars = {
    '--stage-cols': `repeat(${narrow.cols}, minmax(0, 1fr))`,
    '--stage-rows': `repeat(${narrow.rows}, minmax(6rem, 1fr))`,
    '--stage-cols-sm': `repeat(${wide.cols}, minmax(0, 1fr))`,
    '--stage-rows-sm': `repeat(${wide.rows}, minmax(7rem, 1fr))`,
  } as CSSProperties;

  return (
    <section
      data-testid="video-stage"
      aria-label="Video"
      className="flex h-[40vh] min-h-56 shrink-0 flex-col gap-2 border-b border-line bg-black/40 p-2 sm:h-[45vh]"
    >
      {focused ? (
        <>
          <div className="flex min-h-0 flex-1">
            <VideoTile tile={focused} focused onSelect={select} className="min-h-0 flex-1" />
          </div>
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto p-0.5">
            {others.map((t) => (
              <VideoTile
                key={t.key}
                tile={t}
                focused={false}
                onSelect={select}
                className="aspect-video h-16 shrink-0 sm:h-20"
              />
            ))}
            <button
              type="button"
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-control bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-text ring-1 ring-line transition hover:bg-white/10"
              onClick={() => {
                setFocusState((s) => reduceFocus(s, { type: 'grid' }));
              }}
            >
              <GridIcon />
              Grid view
            </button>
          </div>
        </>
      ) : (
        <div
          style={gridVars}
          className="grid min-h-0 flex-1 grid-cols-(--stage-cols) grid-rows-(--stage-rows) gap-2 overflow-y-auto p-0.5 sm:grid-cols-(--stage-cols-sm) sm:grid-rows-(--stage-rows-sm)"
        >
          {tiles.map((t) => (
            <VideoTile key={t.key} tile={t} focused={false} onSelect={select} className="min-h-0" />
          ))}
        </div>
      )}
    </section>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

function SourceIcon({ source }: { source: TileSource }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {source === 'screen_share' ? (
        <>
          <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
          <path d="M5.5 14h5M8 11.5V14" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect x="1.5" y="4" width="9" height="8" rx="1.5" />
          <path d="m10.5 7 4-2.5v7l-4-2.5" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

/**
 * One `video-tile` (`data-user-id`, `data-source`, `data-focused`): the video, a name chip with the
 * source icon (and "You" on our own tiles), and a green ring while that camera's person speaks.
 * Small camera tiles are cropped to fill; screens and the focused tile are shown whole.
 */
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
  const speaking = useIsSpeakingInMyRoom(tile.userId) && tile.source === 'camera';
  const fit = tileFit(tile.source, focused) === 'cover' ? 'object-cover' : 'object-contain';
  const ring = speaking
    ? 'ring-2 ring-success'
    : focused
      ? 'ring-1 ring-accent/60'
      : 'ring-1 ring-white/10 hover:ring-white/30';
  return (
    <button
      type="button"
      data-testid="video-tile"
      data-user-id={tile.userId}
      data-source={tile.source}
      data-focused={focused ? 'true' : 'false'}
      title={focused ? undefined : `Focus ${tile.label}`}
      className={`relative overflow-hidden rounded-xl bg-black text-left transition ${ring} ${className}`}
      onClick={() => {
        onSelect(tile.key);
      }}
    >
      <VideoTrack
        trackRef={tile.trackRef}
        className={`absolute inset-0 size-full ${fit} ${mirrored ? '-scale-x-100' : ''}`}
      />
      <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
        <SourceIcon source={tile.source} />
        <span className="truncate">{tile.label}</span>
        {tile.local && (
          <span className="ml-0.5 shrink-0 rounded bg-white/20 px-1 text-2xs font-semibold">You</span>
        )}
      </span>
    </button>
  );
}
