import type { BootstrapResponse } from '@hearth/shared';
import { usePresenceStore } from '../stores/presence';
import { useReadsStore } from '../stores/reads';
import { useTypingStore } from '../stores/typing';
import { useVoiceStore } from '../stores/voice';

/**
 * The socket-fed stores beyond messages: presence, typing, read states (docs/plans/phase-4.md,
 * "Key decisions → Web") and voice participants (phase-6.md). Bootstrap seeds presence, read states
 * and voice; socket events keep them live.
 */

/** Bumped when a session ends, so a bootstrap still in flight can't repopulate the stores. */
let generation = 0;

export interface LiveSnapshotMark {
  generation: number;
  presenceSeq: number;
  readsSeq: number;
  voiceSeq: number;
}

/** Call right before requesting `/bootstrap`. */
export function beginLiveSnapshot(): LiveSnapshotMark {
  return {
    generation,
    presenceSeq: usePresenceStore.getState().seq,
    readsSeq: useReadsStore.getState().seq,
    voiceSeq: useVoiceStore.getState().seq,
  };
}

/** Seeds the stores from a bootstrap response requested at `mark` (events since then win). */
export function applyLiveSnapshot(boot: BootstrapResponse, mark: LiveSnapshotMark): void {
  if (mark.generation !== generation) return;
  usePresenceStore.getState().applySnapshot(boot.onlineUserIds, mark.presenceSeq);
  useReadsStore.getState().applySnapshot(boot.readStates, mark.readsSeq);
  useVoiceStore.getState().applySnapshot(boot.voice, mark.voiceSeq);
}

/** Drops all live state (logout, revoked or dead session). */
export function resetLiveState(): void {
  generation += 1;
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useReadsStore.getState().reset();
  useVoiceStore.getState().reset();
}
