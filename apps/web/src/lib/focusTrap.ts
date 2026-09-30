/** Elements a Tab press can land on (filtered further for visibility by the caller). */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where a Tab press inside a focus trap must go instead of the browser's default, as an index into
 * the trap's focusable elements; `null` lets the browser move focus (it stays inside).
 *
 * - `count`: how many focusable elements the trap has.
 * - `current`: the index of the focused one, or -1 when focus is outside the trap (or on its container).
 * - `backwards`: Shift+Tab.
 *
 * With nothing focusable, returns -1: keep focus where it is (the caller focuses the container).
 */
export function trapTabTarget(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return -1;
  const last = count - 1;
  if (current < 0) return backwards ? last : 0;
  if (backwards && current === 0) return last;
  if (!backwards && current === last) return 0;
  return null;
}

/**
 * The element to give focus back to when a drawer closes: the one focused before it opened, if it is
 * still in the document and focusable; otherwise `null` (focus is left alone).
 */
export function focusReturnTarget<T extends { isConnected: boolean }>(
  opener: T | null,
  isFocusable: (el: T) => boolean,
): T | null {
  if (opener === null || !opener.isConnected) return null;
  return isFocusable(opener) ? opener : null;
}
