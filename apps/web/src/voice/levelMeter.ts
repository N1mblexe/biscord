/**
 * A microphone level meter (docs/plans/devices.md): the voice-activity gate in the engine and the
 * mic test in Settings. It measures a **clone** of the track, so muting, gating or stopping the
 * original never silences the meter, and `stop()` only ever stops the clone. Levels come from an
 * AudioWorklet (voice/levelWorklet.js, a same-origin file, so CSP `script-src 'self'` allows it)
 * about every 20 ms; where AudioWorklet is missing or fails, an AnalyserNode polled on a timer.
 */

export interface LevelMeter {
  /** `cb` gets each level in dBFS (−100…0); returns the unsubscribe function. */
  subscribe: (cb: (db: number) => void) => () => void;
  /** Stops the clone and closes the audio graph. Idempotent. */
  stop: () => void;
}

export const LEVEL_FLOOR_DB = -100;
const FALLBACK_INTERVAL_MS = 20;

/** RMS (0–1) → dBFS, floored at −100 and capped at 0. */
export function rmsToDb(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return LEVEL_FLOOR_DB;
  return Math.min(0, Math.max(LEVEL_FLOOR_DB, 20 * Math.log10(rms)));
}

/** dBFS (−100…0) → 0…1 for a meter bar. */
export function dbToFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

/** The worklet's URL: Vite emits levelWorklet.js as a file next to the bundle (see vite.config.ts). */
const WORKLET_URL = new URL('./levelWorklet.js', import.meta.url);

export async function createLevelMeter(track: MediaStreamTrack): Promise<LevelMeter> {
  const clone = track.clone();
  // A gated or muted original is disabled; the clone must still hear the mic.
  clone.enabled = true;
  const listeners = new Set<(db: number) => void>();
  const emit = (rms: number) => {
    const db = rmsToDb(rms);
    for (const cb of listeners) cb(db);
  };

  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch (err) {
    clone.stop();
    throw err;
  }
  let stopped = false;
  /** Read through a function: `stop()` may run while `addModule` is pending. */
  const isStopped = () => stopped;
  let timer: ReturnType<typeof setInterval> | null = null;
  const nodes: AudioNode[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    for (const node of nodes) node.disconnect();
    clone.stop();
    listeners.clear();
    void ctx.close().catch(() => undefined);
  };

  try {
    const source = ctx.createMediaStreamSource(new MediaStream([clone]));
    nodes.push(source);
    let worklet: AudioWorkletNode | null = null;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      worklet = new AudioWorkletNode(ctx, 'hearth-level', { numberOfOutputs: 0 });
    } catch {
      worklet = null;
    }
    if (isStopped()) return { subscribe: () => () => undefined, stop };
    if (worklet !== null) {
      worklet.port.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data === 'number') emit(e.data);
      };
      source.connect(worklet);
      nodes.push(worklet);
    } else {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      nodes.push(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) sum += v * v;
        emit(Math.sqrt(sum / buffer.length));
      }, FALLBACK_INTERVAL_MS);
    }
    // Created after a user gesture (join, Test microphone), so this normally runs at once.
    void ctx.resume().catch(() => undefined);
  } catch (err) {
    stop();
    throw err;
  }

  return {
    subscribe: (cb) => {
      if (stopped) return () => undefined;
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    stop,
  };
}
