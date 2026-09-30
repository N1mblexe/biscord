/** The parts of a DragEvent the guard reads (so it can be tested without a DOM). */
export interface DragEventLike {
  type: string;
  defaultPrevented: boolean;
  dataTransfer: { types: ArrayLike<string>; dropEffect: string } | null;
  preventDefault: () => void;
}

/**
 * A file dragged over or dropped anywhere that isn't a drop zone: cancel the browser's default,
 * which is to open the file in place of the app. A drop zone (the channel view) handles the event
 * first and cancels it itself, so an already-cancelled event is left alone. Dragging over shows
 * the "not allowed" cursor.
 */
export function guardFileDrag(event: DragEventLike): void {
  if (event.defaultPrevented || !event.dataTransfer) return;
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
}

/**
 * Installs the guard on `window` (bubble phase, so React's handlers on the root run first).
 * Returns the uninstaller.
 */
export function installFileDropGuard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
) {
  target.addEventListener('dragover', guardFileDrag);
  target.addEventListener('drop', guardFileDrag);
  return () => {
    target.removeEventListener('dragover', guardFileDrag);
    target.removeEventListener('drop', guardFileDrag);
  };
}
