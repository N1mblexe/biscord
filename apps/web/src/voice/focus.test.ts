import { describe, expect, it } from 'vitest';
import { INITIAL_FOCUS, reduceFocus, tileKey, tilesChanged, type FocusState, type TileInfo } from './focus';

const ALICE = 'alice';
const BOB = 'bob';
const ME = 'me';

function tile(userId: string, source: TileInfo['source'], local = false): TileInfo {
  return { key: tileKey(userId, source), userId, source, local };
}

const aliceCam = tile(ALICE, 'camera');
const aliceScreen = tile(ALICE, 'screen_share');
const bobCam = tile(BOB, 'camera');
const bobScreen = tile(BOB, 'screen_share');
const myScreen = tile(ME, 'screen_share', true);

function run(tilesSeq: readonly (readonly TileInfo[])[], start: FocusState = INITIAL_FOCUS): FocusState {
  return tilesSeq.reduce((s, tiles) => reduceFocus(s, { type: 'tiles', tiles }), start);
}

describe('video stage focus', () => {
  it('cameras alone stay in the grid', () => {
    expect(run([[aliceCam], [aliceCam, bobCam]]).focused).toBeNull();
  });

  it('a remote screen share is focused when it starts', () => {
    const s = run([[aliceCam], [aliceCam, aliceScreen]]);
    expect(s).toMatchObject({ focused: aliceScreen.key, pinned: false });
  });

  it('a screen already shared when we arrive is focused too', () => {
    expect(run([[bobCam, aliceScreen]]).focused).toBe(aliceScreen.key);
  });

  it('our own screen share is not auto-focused', () => {
    expect(run([[aliceCam], [aliceCam, myScreen]]).focused).toBeNull();
  });

  it('a newer screen share takes over an auto-focused one', () => {
    expect(run([[aliceScreen], [aliceScreen, bobScreen]]).focused).toBe(bobScreen.key);
  });

  it('a pinned tile is not taken over by a screen share that starts', () => {
    let s = run([[aliceCam, bobCam]]);
    s = reduceFocus(s, { type: 'select', key: bobCam.key });
    expect(s).toMatchObject({ focused: bobCam.key, pinned: true });
    s = run([[aliceCam, bobCam, aliceScreen]], s);
    expect(s).toMatchObject({ focused: bobCam.key, pinned: true });
  });

  it('the pin survives the other source stopping (camera pinned, screen stops)', () => {
    let s = run([[aliceCam, aliceScreen]]);
    expect(s.focused).toBe(aliceScreen.key);
    s = reduceFocus(s, { type: 'select', key: aliceCam.key });
    s = run([[aliceCam]], s);
    expect(s).toMatchObject({ focused: aliceCam.key, pinned: true });
  });

  it('when the focused tile goes away: fall back to a remote screen, else the grid; the pin is dropped', () => {
    let s = run([[aliceScreen, bobScreen, aliceCam]]);
    s = reduceFocus(s, { type: 'select', key: aliceCam.key });
    s = run([[aliceScreen, bobScreen]], s);
    expect(s).toMatchObject({ focused: bobScreen.key, pinned: false });
    s = run([[aliceScreen]], s);
    expect(s).toMatchObject({ focused: aliceScreen.key, pinned: false });
    s = run([[bobCam]], s);
    expect(s).toMatchObject({ focused: null, pinned: false });
  });

  it('grid view unfocuses and unpins; select pins the tile already focused', () => {
    let s = run([[aliceScreen]]);
    s = reduceFocus(s, { type: 'select', key: aliceScreen.key });
    expect(s.pinned).toBe(true);
    s = reduceFocus(s, { type: 'grid' });
    expect(s).toMatchObject({ focused: null, pinned: false });
    // Still shown, not new: stays in the grid.
    s = run([[aliceScreen, aliceCam]], s);
    expect(s.focused).toBeNull();
  });

  it('tilesChanged compares keys in order', () => {
    const s = run([[aliceCam, bobCam]]);
    expect(tilesChanged(s, [aliceCam, bobCam])).toBe(false);
    expect(tilesChanged(s, [bobCam, aliceCam])).toBe(true);
    expect(tilesChanged(s, [aliceCam])).toBe(true);
  });
});
