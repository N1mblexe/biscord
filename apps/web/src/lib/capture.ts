/**
 * Lifecycle helpers for Settings' media tests (mic test, test sound, camera preview): every stream
 * stops on unmount, when its toggle goes off and when the tab is hidden, and a capture that resolves
 * after it was stopped is released at once instead of leaking a live mic or camera.
 */

export interface Capture<T> {
  /**
   * Starts the capture; resolves its value, or `null` when it was stopped meanwhile (the late value
   * is then released) or a newer `run` replaced it. Rejects when `start` fails (unless stopped meanwhile).
   */
  run: () => Promise<T | null>;
  /** Releases the running value (if any) and voids any start in flight. Idempotent. */
  stop: () => void;
  /** The running value. */
  current: () => T | null;
}

export function createCapture<T>(start: () => Promise<T>, release: (value: T) => void): Capture<T> {
  let generation = 0;
  let value: T | null = null;
  const stop = () => {
    generation += 1;
    const running = value;
    value = null;
    if (running !== null) release(running);
  };
  return {
    run: async () => {
      stop();
      const mine = generation;
      let started: T;
      try {
        started = await start();
      } catch (err) {
        // A failure nobody waits for any more (stopped meanwhile) is not an error.
        if (mine !== generation) return null;
        throw err;
      }
      if (mine !== generation) {
        release(started);
        return null;
      }
      value = started;
      return started;
    },
    stop,
    current: () => value,
  };
}

type VisibilityTarget = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** Calls `onHide` whenever `doc` becomes hidden; returns the unbind function. */
export function onHidden(doc: VisibilityTarget, onHide: () => void): () => void {
  const listener = () => {
    if (doc.visibilityState === 'hidden') onHide();
  };
  doc.addEventListener('visibilitychange', listener);
  return () => {
    doc.removeEventListener('visibilitychange', listener);
  };
}

/** Stops every track of `stream`. */
export function stopStream(stream: Pick<MediaStream, 'getTracks'>): void {
  for (const track of stream.getTracks()) track.stop();
}
