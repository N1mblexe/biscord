import type { Attachment } from '@hearth/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Chip } from '../../lib/attachments';
import { AttachmentUploadSession, type UploadRequests } from './useAttachmentUploads';

interface PendingUpload {
  file: File;
  signal: AbortSignal;
  resolve: (attachment: Attachment) => void;
  reject: (err: unknown) => void;
}

function attachmentFor(name: string): Attachment {
  const id = crypto.randomUUID();
  return {
    id,
    filename: name,
    mimeType: 'text/plain',
    sizeBytes: 5,
    url: `/api/attachments/${id}/${name}`,
    inline: false,
  };
}

/** A session whose uploads stay pending until the test settles them. */
function setup(discardImpl: (id: string) => Promise<void> = () => Promise.resolve()) {
  const uploads: PendingUpload[] = [];
  const discard = vi.fn(discardImpl);
  const requests: UploadRequests = {
    upload: (file, { signal }) =>
      new Promise<Attachment>((resolve, reject) => {
        uploads.push({ file, signal, resolve, reject });
        signal.addEventListener('abort', () => {
          reject(new DOMException('The upload was aborted.', 'AbortError'));
        });
      }),
    discard,
  };
  const changes: (readonly Chip[])[] = [];
  const errors: (string | null)[] = [];
  const session = new AttachmentUploadSession(
    { onChange: (chips) => changes.push(chips), onError: (message) => errors.push(message) },
    requests,
  );
  const upload = (index: number): PendingUpload => {
    const pending = uploads[index];
    if (!pending) throw new Error(`no upload #${index}`);
    return pending;
  };
  /** Finishes upload `index` and lets its handler run; returns the attachment. */
  const finish = async (index: number): Promise<Attachment> => {
    const attachment = attachmentFor(upload(index).file.name);
    upload(index).resolve(attachment);
    await flush();
    return attachment;
  };
  return { session, discard, upload, finish, changes, errors };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const file = (name: string) => new File(['hello'], name, { type: 'text/plain' });
const keyOf = (session: AttachmentUploadSession, filename: string): string => {
  const chip = session.chips.find((c) => c.filename === filename);
  if (!chip) throw new Error(`no chip ${filename}`);
  return chip.key;
};

describe('AttachmentUploadSession (CONTRACTS B.9 rule 7, row 28b)', () => {
  it('removing a ready chip deletes its upload on the server', async () => {
    const { session, discard, finish } = setup();
    session.addFiles([file('a.txt'), file('b.txt')]);
    const a = await finish(0);
    await finish(1);
    expect(session.chips.map((c) => c.state)).toEqual(['ready', 'ready']);

    session.remove(keyOf(session, 'a.txt'));
    expect(discard).toHaveBeenCalledExactlyOnceWith(a.id);
    expect(session.chips.map((c) => c.filename)).toEqual(['b.txt']);
  });

  it('removing an uploading chip aborts it; an upload that still finishes is deleted', async () => {
    const { session, discard, upload } = setup();
    session.addFiles([file('a.txt')]);
    const pending = upload(0);
    // The response is already on its way when the user removes the chip: the abort comes too late.
    const late = attachmentFor('a.txt');
    pending.resolve(late);
    session.remove(keyOf(session, 'a.txt'));
    expect(pending.signal.aborted).toBe(true);
    await flush();
    expect(discard).toHaveBeenCalledExactlyOnceWith(late.id);
    expect(session.chips).toEqual([]);
  });

  it('an aborted upload is not deleted (nothing was stored) and a failed chip needs no delete', async () => {
    const { session, discard, upload } = setup();
    session.addFiles([file('a.txt'), file('b.txt')]);
    upload(1).reject(new Error('boom'));
    await flush();
    session.remove(keyOf(session, 'a.txt'));
    session.remove(keyOf(session, 'b.txt'));
    await flush();
    expect(discard).not.toHaveBeenCalled();
  });

  it('dispose (composer unmount / channel switch) deletes ready unsent uploads, not sent ones', async () => {
    const { session, discard, finish, upload, changes } = setup();
    session.addFiles([file('sent.txt'), file('ready.txt'), file('inflight.txt')]);
    await finish(0);
    const ready = await finish(1);
    session.markSent([keyOf(session, 'sent.txt')]);
    const changesBefore = changes.length;

    session.dispose();
    expect(upload(2).signal.aborted).toBe(true);
    await flush();
    expect(discard).toHaveBeenCalledExactlyOnceWith(ready.id);
    expect(changes.length).toBe(changesBefore); // no state updates after unmount

    // Idempotent.
    session.dispose();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('an upload finishing after dispose is deleted', async () => {
    const { session, discard, upload } = setup();
    session.addFiles([file('a.txt')]);
    const pending = upload(0);
    const late = attachmentFor('a.txt');
    pending.resolve(late);
    session.dispose();
    await flush();
    expect(discard).toHaveBeenCalledExactlyOnceWith(late.id);
  });

  it('a failed delete is swallowed (best effort, never blocks the UI)', async () => {
    const { session, discard, finish } = setup(() => Promise.reject(new Error('offline')));
    session.addFiles([file('a.txt')]);
    await finish(0);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      session.remove(keyOf(session, 'a.txt'));
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(discard).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
    expect(session.chips).toEqual([]);
  });

  it('files over the per-message cap are not uploaded', () => {
    const { session, upload } = setup();
    session.addFiles(Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`)));
    expect(session.chips).toHaveLength(10);
    expect(() => upload(9)).not.toThrow();
    expect(() => upload(10)).toThrow();
  });
});
