import { describe, expect, it } from 'vitest';
import { dbToFraction, rmsToDb } from './levelMeter';

describe('rmsToDb', () => {
  it.each([
    [1, 0],
    [0.1, -20],
    [0.01, -40],
    [0.001, -60],
  ])('%s → %s dB', (rms, db) => {
    expect(rmsToDb(rms)).toBeCloseTo(db, 6);
  });

  it('floors at −100 (silence, tiny, invalid) and caps at 0', () => {
    expect(rmsToDb(0)).toBe(-100);
    expect(rmsToDb(1e-9)).toBe(-100);
    expect(rmsToDb(-1)).toBe(-100);
    expect(rmsToDb(Number.NaN)).toBe(-100);
    expect(rmsToDb(2)).toBe(0);
  });
});

describe('dbToFraction', () => {
  it.each([
    [-100, 0],
    [-50, 0.5],
    [0, 1],
    [-150, 0],
    [6, 1],
    [Number.NaN, 0],
  ])('%s dB → %s', (db, fraction) => {
    expect(dbToFraction(db)).toBeCloseTo(fraction, 9);
  });
});
