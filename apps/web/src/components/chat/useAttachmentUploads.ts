import type { Attachment } from '@hearth/shared';
import { useCallback, useEffect, useState } from 'react';
import { deleteAttachment, uploadAttachment } from '../../api/uploads';
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
  /** Removes a chip, cancelling its upload if it is still running, or deleting it if it finished. */
  remove: (key: string) => void;
  /** Drops the chips whose uploads went out with a message. */
  markSent: (keys: readonly string[]) => void;
}

/** The requests an upload session makes (injectable for tests). */
export interface UploadRequests {
  upload: (file: File, options: { signal: AbortSignal }) => Promise<Attachment>;
  /** DELETE /attachments/:id (row 28b). */
  discard: (attachmentId: string) => Promise<void>;
}

export interface UploadSessionListener {
  onChange: (chips: readonly Chip[]) => void;
  onError: (message: string | null) => void;
}

const DEFAULT_REQUESTS: UploadRequests = { upload: uploadAttachment, discard: deleteAttachment };

/**
 * The composer's pending attachments for one channel view, outside React. Each file uploads as soon as
 * it is added (POST /attachments); the chip turns `ready` with the attachment or `failed` with a page
 * alert. An upload the user gives up on is deleted on the server (row 28b, CONTRACTS B.9 rule 7), so it
 * stops counting toward the upload quota: a ready chip that is removed, every ready chip still unsent
 * when the view goes away (`dispose`), and an upload that finishes after its chip is gone. Deletes are
 * best effort and never block the UI; whatever they miss, the server's 24 h GC removes.
 */
export class AttachmentUploadSession {
  private current: readonly Chip[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private active = true;

  constructor(
    private listener: UploadSessionListener,
    private readonly requests: UploadRequests = DEFAULT_REQUESTS,
  ) {}

  get chips(): readonly Chip[] {
    return this.current;
  }

  /** Follows the view's latest page-alert callback. */
  setOnError(onError: UploadSessionListener['onError']): void {
    this.listener = { ...this.listener, onError };
  }

  /** (Re)starts the session when the view mounts (React may unmount and remount it in development). */
  activate(): void {
    this.active = true;
  }

  addFiles(files: readonly File[]): void {
    if (files.length === 0 || !this.active) return;
    const { accepted, error } = selectFiles(this.current.length, files);
    this.listener.onError(error);
    const added = accepted.map((file) => ({ file, key: crypto.randomUUID() }));
    this.apply({
      type: 'add',
      chips: added.map(({ file, key }) => ({ key, filename: file.name, sizeBytes: file.size })),
    });
    for (const { file, key } of added) {
      // The reducer may have dropped chips over the per-message cap; don't upload those.
      if (!this.current.some((c) => c.key === key)) continue;
      const controller = new AbortController();
      this.controllers.set(key, controller);
      this.requests.upload(file, { signal: controller.signal }).then(
        (attachment) => {
          this.controllers.delete(key);
          const chip = this.current.find((c) => c.key === key);
          if (!this.active || chip?.state !== 'uploading') {
            // Removed (or the view left) while the response was on its way: nobody will send it.
            this.discard(attachment.id);
            return;
          }
          this.apply({ type: 'ready', key, attachment });
        },
        (err: unknown) => {
          this.controllers.delete(key);
          if (isAbortError(err) || !this.active) return;
          this.apply({ type: 'failed', key });
          this.listener.onError(attachmentUploadError(err));
        },
      );
    }
  }

  remove(key: string): void {
    const chip = this.current.find((c) => c.key === key);
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.apply({ type: 'remove', key });
    if (chip?.state === 'ready' && chip.attachment) this.discard(chip.attachment.id);
  }

  markSent(keys: readonly string[]): void {
    this.apply({ type: 'sent', keys });
  }

  /** The view goes away: cancel uploads in flight and delete the finished ones that were never sent. */
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const chip of this.current) {
      if (chip.state === 'ready' && chip.attachment) this.discard(chip.attachment.id);
    }
    this.current = [];
  }

  private apply(action: ChipAction): void {
    const next = chipsReducer(this.current, action);
    if (next === this.current) return;
    this.current = next;
    if (this.active) this.listener.onChange(next);
  }

  private discard(attachmentId: string): void {
    this.requests.discard(attachmentId).catch(() => {
      // Best effort: the upload GC removes it within 24 h anyway.
    });
  }
}

/**
 * The composer's pending attachments for one channel view (see `AttachmentUploadSession`). The channel
 * page is keyed by channel id, so switching channels unmounts the view and disposes its session.
 */
export function useAttachmentUploads(onError: (message: string | null) => void): AttachmentUploads {
  const [chips, setChips] = useState<readonly Chip[]>([]);
  const [session] = useState(() => new AttachmentUploadSession({ onChange: setChips, onError }));
  useEffect(() => {
    session.setOnError(onError);
  }, [session, onError]);

  useEffect(() => {
    session.activate();
    return () => {
      session.dispose();
    };
  }, [session]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      session.addFiles(files);
    },
    [session],
  );
  const remove = useCallback(
    (key: string) => {
      session.remove(key);
    },
    [session],
  );
  const markSent = useCallback(
    (keys: readonly string[]) => {
      session.markSent(keys);
    },
    [session],
  );

  return { chips, addFiles, remove, markSent };
}
