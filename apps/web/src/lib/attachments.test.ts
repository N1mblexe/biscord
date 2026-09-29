import { LIMITS, type Attachment } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import {
  attachmentView,
  chipsReducer,
  FILE_TOO_LARGE_MESSAGE,
  fileLabel,
  formatBytes,
  isAttachmentUrl,
  isUploading,
  readyAttachments,
  selectFiles,
  TOO_MANY_FILES_MESSAGE,
  type Chip,
} from './attachments';

const MB = 1024 * 1024;

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: '6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a',
    filename: 'cat.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    url: '/api/attachments/6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a/cat.png',
    inline: true,
    ...overrides,
  };
}

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024 + 400, '10 KB'],
    [1024 * 1024 - 1, '1 MB'],
    [MB, '1 MB'],
    [2.25 * MB, '2.3 MB'],
    [25 * MB, '25 MB'],
    [1024 * MB, '1 GB'],
  ])('%d bytes → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('treats invalid input as 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('attachment rendering', () => {
  it('shows allowlisted images inline', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(attachmentView({ inline: true, mimeType })).toBe('image');
    }
  });

  it('shows everything else as a download link', () => {
    expect(attachmentView({ inline: false, mimeType: 'application/pdf' })).toBe('file');
    expect(attachmentView({ inline: false, mimeType: 'image/png' })).toBe('file');
    // Never inline off the allowlist, even if the server said so.
    expect(attachmentView({ inline: true, mimeType: 'image/svg+xml' })).toBe('file');
    expect(attachmentView({ inline: true, mimeType: 'text/html' })).toBe('file');
  });

  it('labels a file with its name and size', () => {
    expect(fileLabel(attachment({ filename: 'report.pdf', sizeBytes: 2048 }))).toBe('report.pdf (2 KB)');
  });

  it('only links same-origin attachment URLs', () => {
    expect(isAttachmentUrl(attachment().url)).toBe(true);
    expect(isAttachmentUrl('javascript:alert(1)')).toBe(false);
    expect(isAttachmentUrl('https://evil.example/api/attachments/x/y')).toBe(false);
    expect(isAttachmentUrl('/api/avatars/x')).toBe(false);
  });
});

describe('chipsReducer', () => {
  const add = (chips: readonly Chip[], ...keys: string[]) =>
    chipsReducer(chips, {
      type: 'add',
      chips: keys.map((key) => ({ key, filename: `${key}.txt`, sizeBytes: 10 })),
    });

  it('adds chips as uploading', () => {
    const chips = add([], 'a', 'b');
    expect(chips.map((c) => [c.key, c.filename, c.state])).toEqual([
      ['a', 'a.txt', 'uploading'],
      ['b', 'b.txt', 'uploading'],
    ]);
    expect(isUploading(chips)).toBe(true);
  });

  it('marks chips ready or failed', () => {
    let chips = add([], 'a', 'b');
    const att = attachment();
    chips = chipsReducer(chips, { type: 'ready', key: 'a', attachment: att });
    expect(isUploading(chips)).toBe(true);
    chips = chipsReducer(chips, { type: 'failed', key: 'b' });
    expect(chips.map((c) => c.state)).toEqual(['ready', 'failed']);
    expect(isUploading(chips)).toBe(false);
    expect(readyAttachments(chips)).toEqual([att]);
  });

  it('removes chips (including failed ones) and ignores unknown keys', () => {
    let chips = add([], 'a', 'b');
    chips = chipsReducer(chips, { type: 'failed', key: 'b' });
    chips = chipsReducer(chips, { type: 'remove', key: 'b' });
    expect(chips.map((c) => c.key)).toEqual(['a']);
    expect(chipsReducer(chips, { type: 'remove', key: 'zzz' })).toBe(chips);
    // An upload finishing after its chip was removed changes nothing.
    expect(chipsReducer(chips, { type: 'ready', key: 'b', attachment: attachment() })).toEqual(chips);
  });

  it('only settles uploading chips', () => {
    let chips = add([], 'a');
    chips = chipsReducer(chips, { type: 'failed', key: 'a' });
    chips = chipsReducer(chips, { type: 'ready', key: 'a', attachment: attachment() });
    expect(chips[0]?.state).toBe('failed');
  });

  it('drops sent chips and keeps the rest', () => {
    let chips = add([], 'a', 'b', 'c');
    chips = chipsReducer(chips, { type: 'ready', key: 'a', attachment: attachment() });
    chips = chipsReducer(chips, { type: 'failed', key: 'c' });
    chips = chipsReducer(chips, { type: 'sent', keys: ['a'] });
    expect(chips.map((c) => c.key)).toEqual(['b', 'c']);
  });

  it(`caps a message at ${LIMITS.attachmentsPerMessage} chips`, () => {
    const keys = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const chips = add([], ...keys);
    expect(chips).toHaveLength(LIMITS.attachmentsPerMessage);
    expect(add(chips, 'more')).toBe(chips);
  });
});

describe('selectFiles', () => {
  const file = (name: string, size = 10) => ({ name, size });

  it('accepts files up to 25 MB', () => {
    const files = [file('a'), file('b', LIMITS.uploadMaxBytes)];
    expect(selectFiles(0, files)).toEqual({ accepted: files, error: null });
  });

  it('rejects a file over 25 MB with the page alert, keeping the others', () => {
    const ok = file('ok');
    const res = selectFiles(0, [file('huge', LIMITS.uploadMaxBytes + 1), ok]);
    expect(res.accepted).toEqual([ok]);
    expect(res.error).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(FILE_TOO_LARGE_MESSAGE).toBe('File is too large (max 25 MB).');
  });

  it('accepts only as many files as still fit', () => {
    const files = Array.from({ length: 4 }, (_, i) => file(`f${i}`));
    const res = selectFiles(8, files);
    expect(res.accepted.map((f) => f.name)).toEqual(['f0', 'f1']);
    expect(res.error).toBe(TOO_MANY_FILES_MESSAGE);
    expect(selectFiles(10, [file('x')])).toEqual({ accepted: [], error: TOO_MANY_FILES_MESSAGE });
  });
});
