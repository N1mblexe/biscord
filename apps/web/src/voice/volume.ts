import { create } from 'zustand';

/**
 * Per-user local playback volume (docs/plans/phase-6.md, "Key decisions → Web"): 0–1, applied with
 * `RemoteParticipant.setVolume`, saved in localStorage by user id so it survives reloads and rooms.
 * Storage can be unavailable (private mode, blocked): volumes then just don't persist.
 */

/** localStorage key holding `{ [userId]: volume }` as JSON. */
export const VOLUME_STORAGE_KEY = 'hearth:voice-volumes';

export const DEFAULT_VOLUME = 1;

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, v));
}

/** The saved volumes; anything malformed is ignored. */
export function readVolumes(): Record<string, number> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(VOLUME_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const volumes: Record<string, number> = {};
  for (const [userId, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isFinite(value)) volumes[userId] = clampVolume(value);
  }
  return volumes;
}

export function writeVolumes(volumes: Record<string, number>): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(volumes));
  } catch {
    // Storage unavailable: the volume applies for this page only.
  }
}

interface VolumeState {
  /** User id → volume (0–1); missing = `DEFAULT_VOLUME`. Loaded from storage on first use. */
  volumes: Record<string, number>;
  /** Sets and saves a volume; returns the clamped value. */
  setVolume: (userId: string, volume: number) => number;
  /** Re-reads storage (e.g. in tests). */
  reload: () => void;
}

export const useVolumeStore = create<VolumeState>()((set, get) => ({
  volumes: readVolumes(),
  setVolume: (userId, volume) => {
    const v = clampVolume(volume);
    const volumes = { ...get().volumes };
    if (v === DEFAULT_VOLUME) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by user id
      delete volumes[userId];
    } else {
      volumes[userId] = v;
    }
    set({ volumes });
    writeVolumes(volumes);
    return v;
  },
  reload: () => {
    set({ volumes: readVolumes() });
  },
}));

/** The saved volume for `userId` (0–1). */
export function volumeFor(userId: string): number {
  return useVolumeStore.getState().volumes[userId] ?? DEFAULT_VOLUME;
}

/** The saved volume for `userId` (a hook). */
export function useVolume(userId: string): number {
  return useVolumeStore((s) => s.volumes[userId] ?? DEFAULT_VOLUME);
}
