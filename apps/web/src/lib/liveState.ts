import type { BootstrapResponse } from '@hearth/shared';
import { usePresenceStore } from '../stores/presence';
import { useReadsStore } from '../stores/reads';
import { useTypingStore } from '../stores/typing';
import { useVoiceStore } from '../stores/voice';

/**
 * The socket-fed stores beyond messages: presence, typing, read states (docs/plans/phase-4.md,
 * "Key decisions → Web") and voice participants (phase-6.md). Bootstrap seeds presence, read states
 * and voice; socket events keep them live.
 *
 * The cached `['bootstrap']` itself (channels, DMs, users) gets the same snapshot treatment: socket
 * events patch it (socket/chatEvents.ts) and record the patch here, and a bootstrap response is
 * applied with every patch recorded after its request started replayed on top. Otherwise a
 * response requested before, say, `channel:deleted` but answered after it would bring the channel
 * back.
 */

/** Bumped when a session ends, so a bootstrap still in flight can't repopulate the stores. */
let generation = 0;

/** A socket event's change to the cached bootstrap (pure and idempotent, lib/bootstrapPatch.ts). */
export type BootstrapPatch = (boot: BootstrapResponse) => BootstrapResponse;

/** Sequence number of the last recorded bootstrap patch. */
let bootstrapSeq = 0;
/** Patches recorded while a bootstrap request was in flight (the only time they're needed). */
let patchLog: { seq: number; patch: BootstrapPatch }[] = [];
/** Bootstrap requests in flight. */
const openMarks = new Set<LiveSnapshotMark>();

export interface LiveSnapshotMark {
  generation: number;
  presenceSeq: number;
  readsSeq: number;
  voiceSeq: number;
  bootstrapSeq: number;
}

/** Call right before requesting `/bootstrap`; pair with `endLiveSnapshot`. */
export function beginLiveSnapshot(): LiveSnapshotMark {
  const mark = {
    generation,
    presenceSeq: usePresenceStore.getState().seq,
    readsSeq: useReadsStore.getState().seq,
    voiceSeq: useVoiceStore.getState().seq,
    bootstrapSeq,
  };
  openMarks.add(mark);
  return mark;
}

/**
 * Seeds the stores from a bootstrap response requested at `mark` (events since then win) and
 * returns the response with the bootstrap patches recorded since then replayed on top.
 */
export function applyLiveSnapshot(boot: BootstrapResponse, mark: LiveSnapshotMark): BootstrapResponse {
  if (mark.generation !== generation) return boot;
  usePresenceStore.getState().applySnapshot(boot.onlineUserIds, mark.presenceSeq);
  useReadsStore.getState().applySnapshot(boot.readStates, mark.readsSeq);
  useVoiceStore.getState().applySnapshot(boot.voice, mark.voiceSeq);
  let result = boot;
  for (const { seq, patch } of patchLog) {
    if (seq > mark.bootstrapSeq) result = patch(result);
  }
  return result;
}

/** The request of `mark` settled (answered, failed or aborted). */
export function endLiveSnapshot(mark: LiveSnapshotMark): void {
  openMarks.delete(mark);
  let oldest = Infinity;
  for (const open of openMarks) oldest = Math.min(oldest, open.bootstrapSeq);
  patchLog = patchLog.filter((entry) => entry.seq > oldest);
}

/** A socket event patched the cached bootstrap with `patch`. */
export function recordBootstrapPatch(patch: BootstrapPatch): void {
  bootstrapSeq += 1;
  if (openMarks.size > 0) patchLog.push({ seq: bootstrapSeq, patch });
}

/** Drops all live state (logout, revoked or dead session). */
export function resetLiveState(): void {
  generation += 1;
  patchLog = [];
  openMarks.clear();
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useReadsStore.getState().reset();
  useVoiceStore.getState().reset();
}
