import { describe, expect, it } from 'vitest';
import { fittedHeight } from './useAutoGrow';

describe('fittedHeight', () => {
  it('is the content height plus the borders', () => {
    // A 1px border on each side: offsetHeight - clientHeight = 2.
    expect(fittedHeight({ scrollHeight: 120, offsetHeight: 38, clientHeight: 36 })).toBe(122);
  });

  it('follows scrollHeight, so long wrapped lines grow the box like newlines do', () => {
    const oneLine = fittedHeight({ scrollHeight: 36, offsetHeight: 38, clientHeight: 36 });
    const wrapped = fittedHeight({ scrollHeight: 96, offsetHeight: 38, clientHeight: 36 });
    expect(wrapped).toBeGreaterThan(oneLine);
  });
});
