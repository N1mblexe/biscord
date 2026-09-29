/**
 * Client-side speaking detection, complementing LiveKit's server-side active speakers (which need
 * sustained sound and miss short bursts). Each poll reads an audio track's cumulative
 * `totalAudioEnergy` / `totalSamplesDuration` (WebRTC stats, via LiveKit's
 * `track.getRTCStatsReport()`: `inbound-rtp` for remote tracks, `media-source` for our mic); the
 * energy gained over the duration gained is the mean square level since the previous poll, so even
 * a short sound between two polls counts. A participant stays "speaking" for `holdMs` after their
 * last loud interval, so the ring doesn't flicker between words.
 */

export interface EnergySample {
  /** Cumulative `totalAudioEnergy`. */
  energy: number;
  /** Cumulative `totalSamplesDuration` (s). */
  duration: number;
}

/** RMS level (0–1) above which an interval counts as speech (about −36 dBov). */
export const SPEAKING_RMS_THRESHOLD = 0.016;
export const SPEAKING_HOLD_MS = 800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The audio energy counters of a stats report: the first `statType` (`inbound-rtp` or
 * `media-source`) audio entry that has them, or `null`.
 */
export function energySample(
  report: RTCStatsReport | undefined,
  statType: 'inbound-rtp' | 'media-source',
): EnergySample | null {
  let sample: EnergySample | null = null;
  report?.forEach((stat: unknown) => {
    if (sample !== null || !isRecord(stat) || stat.type !== statType) return;
    if (stat.kind !== undefined && stat.kind !== 'audio') return;
    const { totalAudioEnergy, totalSamplesDuration } = stat;
    if (typeof totalAudioEnergy === 'number' && typeof totalSamplesDuration === 'number') {
      sample = { energy: totalAudioEnergy, duration: totalSamplesDuration };
    }
  });
  return sample;
}

/** RMS level between two samples of the same track, or `null` when no audio time passed. */
export function rmsBetween(prev: EnergySample, next: EnergySample): number | null {
  const duration = next.duration - prev.duration;
  const energy = next.energy - prev.energy;
  if (duration <= 0 || energy < 0) return null;
  return Math.sqrt(energy / duration);
}

export class SpeakingMeter {
  private readonly last = new Map<string, EnergySample>();
  private readonly loudAt = new Map<string, number>();

  constructor(
    private readonly threshold = SPEAKING_RMS_THRESHOLD,
    private readonly holdMs = SPEAKING_HOLD_MS,
  ) {}

  /** Feeds a new sample for `identity` (a `null` sample = no audio track: forget them). */
  update(identity: string, sample: EnergySample | null, now: number): void {
    if (sample === null) {
      this.last.delete(identity);
      this.loudAt.delete(identity);
      return;
    }
    const prev = this.last.get(identity);
    this.last.set(identity, sample);
    if (prev === undefined) return;
    const rms = rmsBetween(prev, sample);
    if (rms === null) return;
    if (rms >= this.threshold) this.loudAt.set(identity, now);
  }

  /** Forgets everyone not in `identities` (left the room). */
  retain(identities: ReadonlySet<string>): void {
    for (const id of [...this.last.keys(), ...this.loudAt.keys()]) {
      if (!identities.has(id)) {
        this.last.delete(id);
        this.loudAt.delete(id);
      }
    }
  }

  /** Identities that were loud within the hold time, sorted. */
  speaking(now: number): string[] {
    return [...this.loudAt]
      .filter(([, at]) => now - at <= this.holdMs)
      .map(([id]) => id)
      .sort();
  }

  clear(): void {
    this.last.clear();
    this.loudAt.clear();
  }
}
