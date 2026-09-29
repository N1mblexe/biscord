import { describe, expect, it } from 'vitest';
import { energySample, rmsBetween, SpeakingMeter } from './speakingMeter';

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((e, i) => [String(i), e]));
}

/** A sample after `seconds` of audio at a constant RMS `level`, on top of `prev`. */
function after(prev: { energy: number; duration: number }, seconds: number, level: number) {
  return { energy: prev.energy + level * level * seconds, duration: prev.duration + seconds };
}

describe('speaking meter', () => {
  it('reads the audio energy counters of the requested stat type', () => {
    const r = report([
      { type: 'inbound-rtp', kind: 'video', totalAudioEnergy: 9, totalSamplesDuration: 9 },
      { type: 'media-source', kind: 'audio', totalAudioEnergy: 1, totalSamplesDuration: 2 },
      { type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 0.5, totalSamplesDuration: 3 },
    ]);
    expect(energySample(r, 'inbound-rtp')).toEqual({ energy: 0.5, duration: 3 });
    expect(energySample(r, 'media-source')).toEqual({ energy: 1, duration: 2 });
    expect(energySample(report([{ type: 'inbound-rtp', kind: 'audio' }]), 'inbound-rtp')).toBeNull();
    expect(energySample(undefined, 'inbound-rtp')).toBeNull();
  });

  it('computes the RMS level between two samples', () => {
    const a = { energy: 0, duration: 0 };
    expect(rmsBetween(a, after(a, 0.25, 0.1))).toBeCloseTo(0.1);
    expect(rmsBetween(a, a)).toBeNull();
  });

  it('flags loud intervals, holds them briefly, and ignores quiet ones', () => {
    const meter = new SpeakingMeter(0.02, 800);
    let s = { energy: 0, duration: 0 };
    meter.update('bob', s, 0);
    s = after(s, 0.25, 0.005); // background noise
    meter.update('bob', s, 250);
    expect(meter.speaking(250)).toEqual([]);
    s = after(s, 0.25, 0.2); // speech
    meter.update('bob', s, 500);
    expect(meter.speaking(500)).toEqual(['bob']);
    s = after(s, 0.25, 0.001);
    meter.update('bob', s, 750);
    expect(meter.speaking(1300)).toEqual(['bob']);
    expect(meter.speaking(1301)).toEqual([]);
  });

  it('catches a short burst between two polls', () => {
    const meter = new SpeakingMeter(0.02, 800);
    const start = { energy: 0, duration: 0 };
    meter.update('bob', start, 0);
    // A 20 ms beep at 0.5 inside a 250 ms interval of silence: RMS ≈ 0.14.
    meter.update('bob', { energy: 0.5 * 0.5 * 0.02, duration: 0.25 }, 250);
    expect(meter.speaking(250)).toEqual(['bob']);
  });

  it('forgets participants without a track or who left', () => {
    const meter = new SpeakingMeter(0.02, 800);
    const s = { energy: 0, duration: 0 };
    for (const id of ['a', 'b']) {
      meter.update(id, s, 0);
      meter.update(id, after(s, 0.25, 0.3), 250);
    }
    meter.update('a', null, 300);
    expect(meter.speaking(300)).toEqual(['b']);
    meter.retain(new Set(['a']));
    expect(meter.speaking(300)).toEqual([]);
  });
});
