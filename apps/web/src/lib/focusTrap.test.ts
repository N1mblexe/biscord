import { describe, expect, it } from 'vitest';
import { focusReturnTarget, trapTabTarget } from './focusTrap';

describe('trapTabTarget', () => {
  it('wraps Tab from the last element to the first, and Shift+Tab from the first to the last', () => {
    expect(trapTabTarget(3, 2, false)).toBe(0);
    expect(trapTabTarget(3, 0, true)).toBe(2);
  });

  it('lets the browser move focus between inner elements', () => {
    expect(trapTabTarget(3, 0, false)).toBeNull();
    expect(trapTabTarget(3, 1, false)).toBeNull();
    expect(trapTabTarget(3, 1, true)).toBeNull();
    expect(trapTabTarget(3, 2, true)).toBeNull();
  });

  it('pulls focus from outside (or the container) back in at the matching end', () => {
    expect(trapTabTarget(3, -1, false)).toBe(0);
    expect(trapTabTarget(3, -1, true)).toBe(2);
  });

  it('with a single element, both directions stay on it', () => {
    expect(trapTabTarget(1, 0, false)).toBe(0);
    expect(trapTabTarget(1, 0, true)).toBe(0);
  });

  it('with nothing focusable, keeps focus on the container', () => {
    expect(trapTabTarget(0, -1, false)).toBe(-1);
    expect(trapTabTarget(0, -1, true)).toBe(-1);
  });
});

describe('focusReturnTarget', () => {
  interface FakeElement {
    isConnected: boolean;
    visible: boolean;
  }
  const button = (isConnected: boolean, visible = true): FakeElement => ({ isConnected, visible });
  const isVisible = (el: FakeElement) => el.visible;
  const none: FakeElement | null = null;

  it('returns the opener while it is in the document and focusable', () => {
    const opener = button(true);
    expect(focusReturnTarget(opener, isVisible)).toBe(opener);
  });

  it('gives up when there was no opener, it was removed, or it is hidden', () => {
    expect(focusReturnTarget(none, isVisible)).toBeNull();
    expect(focusReturnTarget(button(false), isVisible)).toBeNull();
    expect(focusReturnTarget(button(true, false), isVisible)).toBeNull();
  });
});
