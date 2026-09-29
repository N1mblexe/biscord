import type { BootstrapResponse } from '@hearth/shared';
import { usePresenceStore } from '../stores/presence';
import { useReadsStore } from '../stores/reads';
import { useTypingStore } from '../stores/typing';

/**
 * The socket-fed stores beyond messages: presence, typing and read states (docs/plans/phase-4.md,
 * "Key decisions → Web"). Bootstrap seeds presence and read states; socket events keep them live.
 */

/** Bumped when a session ends, so a bootstrap still in flight can't repopulate the stores. */
let generation = 0;

export interface LiveSnapshotMark {
  generation: number;
  presenceSeq: number;
  readsSeq: number;
}

/** Call right before requesting `/bootstrap`. */
export function beginLiveSnapshot(): LiveSnapshotMark {
  return {
    generation,
    presenceSeq: usePresenceStore.getState().seq,
    readsSeq: useReadsStore.getState().seq,
  };
}

/** Seeds the stores from a bootstrap response requested at `mark` (events since then win). */
export function applyLiveSnapshot(boot: BootstrapResponse, mark: LiveSnapshotMark): void {
  if (mark.generation !== generation) return;
  usePresenceStore.getState().applySnapshot(boot.onlineUserIds, mark.presenceSeq);
  useReadsStore.getState().applySnapshot(boot.readStates, mark.readsSeq);
}

/** Drops all live state (logout, revoked or dead session). */
export function resetLiveState(): void {
  generation += 1;
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useReadsStore.getState().reset();
}
