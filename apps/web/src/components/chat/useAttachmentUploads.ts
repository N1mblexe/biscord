import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadAttachment } from '../../api/uploads';
import {
  attachmentUploadError,
  chipsReducer,
  selectFiles,
  type Chip,
  type ChipAction,
} from '../../lib/attachments';

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface AttachmentUploads {
  chips: readonly Chip[];
  /** Pre-checks and starts uploading `files` (from the picker, a drop or a paste). */
  addFiles: (files: readonly File[]) => void;
  /** Removes a chip, cancelling its upload if it is still running. */
  remove: (key: string) => void;
  /** Drops the chips whose uploads went out with a message. */
  markSent: (keys: readonly string[]) => void;
}

/**
 * The composer's pending attachments for one channel view. Each file uploads as soon as it is added
 * (POST /attachments); the chip turns `ready` with the attachment or `failed` with a page alert.
 * Leaving the view cancels uploads still in flight (the server discards partial uploads, and GC
 * removes finished ones that are never sent).
 */
export function useAttachmentUploads(onError: (message: string | null) => void): AttachmentUploads {
  // The ref mirrors the state so handlers always see the latest list (several drops or pastes can
  // happen before a re-render).
  const chipsRef = useRef<readonly Chip[]>([]);
  const controllersRef = useRef(new Map<string, AbortController>());
  const [chips, setChips] = useState<readonly Chip[]>([]);

  const apply = useCallback((action: ChipAction) => {
    const next = chipsReducer(chipsRef.current, action);
    if (next === chipsRef.current) return;
    chipsRef.current = next;
    setChips(next);
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const controllers = controllersRef.current;
      const { accepted, error } = selectFiles(chipsRef.current.length, files);
      onError(error);
      const added = accepted.map((file) => ({ file, key: crypto.randomUUID() }));
      apply({
        type: 'add',
        chips: added.map(({ file, key }) => ({ key, filename: file.name, sizeBytes: file.size })),
      });
      for (const { file, key } of added) {
        const controller = new AbortController();
        controllers.set(key, controller);
        uploadAttachment(file, { signal: controller.signal }).then(
          (attachment) => {
            controllers.delete(key);
            apply({ type: 'ready', key, attachment });
          },
          (err: unknown) => {
            controllers.delete(key);
            if (isAbortError(err)) return;
            apply({ type: 'failed', key });
            onError(attachmentUploadError(err));
          },
        );
      }
    },
    [apply, onError],
  );

  const remove = useCallback(
    (key: string) => {
      controllersRef.current.get(key)?.abort();
      controllersRef.current.delete(key);
      apply({ type: 'remove', key });
    },
    [apply],
  );

  const markSent = useCallback(
    (keys: readonly string[]) => {
      apply({ type: 'sent', keys });
    },
    [apply],
  );

  return { chips, addFiles, remove, markSent };
}
