/**
 * Grid shape for the video stage's grid view: as square as possible, so 16:9 tiles fill the stage
 * without long scrolls. `narrow` is a phone-width stage, where tiles stack in one column up to two
 * and never go past two columns.
 */
export function stageGrid(count: number, narrow: boolean): { cols: number; rows: number } {
  const n = Math.max(1, Math.floor(count));
  const cols = narrow ? (n <= 2 ? 1 : 2) : Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

/**
 * How a tile's video fits its box: screens are always shown whole (`contain`, text must stay
 * readable); cameras fill small grid and strip tiles (`cover`) but are shown whole when focused.
 */
export function tileFit(source: 'camera' | 'screen_share', focused: boolean): 'contain' | 'cover' {
  return source === 'screen_share' || focused ? 'contain' : 'cover';
}
