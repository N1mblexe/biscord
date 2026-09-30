import { describe, expect, it, vi } from 'vitest';
import { guardFileDrag, installFileDropGuard, type DragEventLike } from './fileDropGuard';

function drag(type: string, types: string[], defaultPrevented = false) {
  const event = {
    type,
    defaultPrevented,
    dataTransfer: { types, dropEffect: 'copy' },
    preventDefault: vi.fn(),
  } satisfies DragEventLike;
  return event;
}

describe('guardFileDrag', () => {
  it('cancels a file drop outside any drop zone, so the browser never opens the file', () => {
    const event = drag('drop', ['Files']);
    guardFileDrag(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('shows "not allowed" while a file is dragged outside a drop zone', () => {
    const event = drag('dragover', ['Files']);
    guardFileDrag(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.dataTransfer.dropEffect).toBe('none');
  });

  it('leaves events a drop zone already handled alone (keeps its "copy" effect)', () => {
    const event = drag('dragover', ['Files'], true);
    guardFileDrag(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.dataTransfer.dropEffect).toBe('copy');
  });

  it('ignores drags without files (text, links)', () => {
    const event = drag('drop', ['text/plain']);
    guardFileDrag(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('installFileDropGuard', () => {
  it('listens for dragover and drop, and uninstalls', () => {
    const target = {
      addEventListener: vi.fn<(type: string) => void>(),
      removeEventListener: vi.fn<(type: string) => void>(),
    };
    const uninstall = installFileDropGuard(target);
    expect(target.addEventListener.mock.calls.map((c) => c[0])).toEqual(['dragover', 'drop']);
    uninstall();
    expect(target.removeEventListener.mock.calls.map((c) => c[0])).toEqual(['dragover', 'drop']);
  });
});
