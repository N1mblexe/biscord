/**
 * Which video tile the stage focuses (docs/plans/phase-7.md, "Key decisions → Web"). Pure, so the
 * rules are unit-tested:
 *
 * - No focus = grid. Clicking a tile focuses and pins it; **Grid view** unfocuses.
 * - A remote screen share that starts is focused automatically, unless the viewer pinned a tile.
 *   Our own screen share is not (it would just show us our own screen).
 * - A pinned tile stays focused while other videos come and go.
 * - When the focused tile goes away, focus falls back to a remote screen share if there is one,
 *   else to the grid, and the pin is dropped.
 */

export type TileSource = 'camera' | 'screen_share';

export interface TileInfo {
  /** `tileKey(userId, source)`. */
  key: string;
  userId: string;
  source: TileSource;
  /** Our own camera or screen. */
  local: boolean;
}

export interface FocusState {
  focused: string | null;
  /** The viewer chose `focused` (a click), so screen shares don't take it over. */
  pinned: boolean;
  /** The tile keys this state was computed for (to spot new ones). */
  known: readonly string[];
}

export type FocusAction =
  { type: 'tiles'; tiles: readonly TileInfo[] } | { type: 'select'; key: string } | { type: 'grid' };

export const INITIAL_FOCUS: FocusState = { focused: null, pinned: false, known: [] };

export function tileKey(userId: string, source: TileSource): string {
  return `${userId}:${source}`;
}

/** The tile list changed (by key, in order) since `state` was computed. */
export function tilesChanged(state: FocusState, tiles: readonly TileInfo[]): boolean {
  return state.known.length !== tiles.length || tiles.some((t, i) => state.known[i] !== t.key);
}

const autoFocusable = (t: TileInfo) => t.source === 'screen_share' && !t.local;

export function reduceFocus(state: FocusState, action: FocusAction): FocusState {
  switch (action.type) {
    case 'select':
      return { ...state, focused: action.key, pinned: true };
    case 'grid':
      return { ...state, focused: null, pinned: false };
    case 'tiles': {
      const { tiles } = action;
      const known = tiles.map((t) => t.key);
      const present = (key: string | null) => key !== null && known.includes(key);
      const started = tiles.filter((t) => autoFocusable(t) && !state.known.includes(t.key)).at(-1);

      if (state.pinned && present(state.focused)) return { ...state, known };
      if (started) {
        return { focused: started.key, pinned: false, known };
      }
      if (present(state.focused)) return { ...state, known };
      if (state.focused === null) return { focused: null, pinned: false, known };
      // The focused tile went away.
      const fallback = tiles.filter(autoFocusable).at(-1);
      return { focused: fallback?.key ?? null, pinned: false, known };
    }
  }
}
