import { describe, expect, it } from 'vitest';
import { stageGrid, tileFit } from './stageLayout';

describe('stageGrid', () => {
  it('keeps the wide grid close to square', () => {
    expect(stageGrid(1, false)).toEqual({ cols: 1, rows: 1 });
    expect(stageGrid(2, false)).toEqual({ cols: 2, rows: 1 });
    expect(stageGrid(3, false)).toEqual({ cols: 2, rows: 2 });
    expect(stageGrid(4, false)).toEqual({ cols: 2, rows: 2 });
    expect(stageGrid(5, false)).toEqual({ cols: 3, rows: 2 });
    expect(stageGrid(9, false)).toEqual({ cols: 3, rows: 3 });
    expect(stageGrid(10, false)).toEqual({ cols: 4, rows: 3 });
  });

  it('stacks up to two tiles on a phone and never uses more than two columns', () => {
    expect(stageGrid(1, true)).toEqual({ cols: 1, rows: 1 });
    expect(stageGrid(2, true)).toEqual({ cols: 1, rows: 2 });
    expect(stageGrid(3, true)).toEqual({ cols: 2, rows: 2 });
    expect(stageGrid(8, true)).toEqual({ cols: 2, rows: 4 });
  });

  it('treats an empty or odd count as one tile', () => {
    expect(stageGrid(0, false)).toEqual({ cols: 1, rows: 1 });
    expect(stageGrid(-3, true)).toEqual({ cols: 1, rows: 1 });
  });
});

describe('tileFit', () => {
  it('never crops a screen share', () => {
    expect(tileFit('screen_share', false)).toBe('contain');
    expect(tileFit('screen_share', true)).toBe('contain');
  });

  it('fills small camera tiles and shows the focused camera whole', () => {
    expect(tileFit('camera', false)).toBe('cover');
    expect(tileFit('camera', true)).toBe('contain');
  });
});
