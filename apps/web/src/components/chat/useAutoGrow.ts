import { useEffect, useLayoutEffect, type RefObject } from 'react';

/** The border-box height that shows all of a textarea's content (its CSS max-height still caps it). */
export function fittedHeight(box: {
  scrollHeight: number;
  offsetHeight: number;
  clientHeight: number;
}): number {
  // scrollHeight covers content + padding; offsetHeight - clientHeight adds the borders.
  return box.scrollHeight + box.offsetHeight - box.clientHeight;
}

function fit(textarea: HTMLTextAreaElement): void {
  // Shrink first, so scrollHeight measures the content rather than the current height.
  textarea.style.height = 'auto';
  textarea.style.height = `${fittedHeight(textarea)}px`;
}

/**
 * Grows a textarea with its content — hard newlines and long wrapped lines alike — up to its CSS
 * `max-height`, after which it scrolls. Refits when the value changes and when its width does.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [ref, value]);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      // Our own height changes also land here; only a new width can change the wrapping.
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      fit(textarea);
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
}
