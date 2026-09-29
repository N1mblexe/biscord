import type { FastifyBaseLogger } from 'fastify';
import { loggableError } from '../lib/errors.js';
import { withTimeout, type VoiceBackend } from './client.js';

export type LiveKitStatus = 'ok' | 'down';

/** B.6a rule 1: reachability = `listRooms` with a 2 s timeout, cached for 10 s. */
export const LIVEKIT_PROBE_TIMEOUT_MS = 2_000;
export const LIVEKIT_HEALTH_CACHE_MS = 10_000;

export interface LiveKitHealth {
  /** The cached status if fresh, otherwise a new probe (one at a time; concurrent callers share it). */
  check(): Promise<LiveKitStatus>;
  /** The cached status if it is younger than 10 s, else `null`. Never probes. */
  cached(): LiveKitStatus | null;
  /** Records an outcome observed elsewhere (a reconcile `listRooms`). */
  record(status: LiveKitStatus): void;
}

export function createLiveKitHealth(
  backend: VoiceBackend,
  log: FastifyBaseLogger,
  { now = () => Date.now() }: { now?: () => number } = {},
): LiveKitHealth {
  let last: { status: LiveKitStatus; at: number } | null = null;
  let inFlight: Promise<LiveKitStatus> | null = null;

  const record = (status: LiveKitStatus): void => {
    last = { status, at: now() };
  };
  const cached = (): LiveKitStatus | null =>
    last !== null && now() - last.at < LIVEKIT_HEALTH_CACHE_MS ? last.status : null;

  const probe = async (): Promise<LiveKitStatus> => {
    try {
      await withTimeout(backend.listRooms(), LIVEKIT_PROBE_TIMEOUT_MS, 'LiveKit listRooms');
      record('ok');
      return 'ok';
    } catch (err) {
      log.warn({ err: loggableError(err) }, 'health check: LiveKit unreachable');
      record('down');
      return 'down';
    }
  };

  return {
    check() {
      const fresh = cached();
      if (fresh !== null) return Promise.resolve(fresh);
      inFlight ??= probe().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    cached,
    record,
  };
}
