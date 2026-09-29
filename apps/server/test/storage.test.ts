import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { contentDisposition, sanitizeFilename } from '../src/storage/filenames.js';
import {
  createStorage,
  newAttachmentKey,
  newAvatarKey,
  newTmpKey,
  REPO_ROOT,
  resolveUploadDir,
  STORAGE_KEY_RE,
} from '../src/storage/paths.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const silent = { error: () => undefined } as unknown as FastifyBaseLogger;

describe('UPLOAD_DIR resolution', () => {
  it('a relative path resolves against the repo root, not the working directory', () => {
    expect(path.resolve(REPO_ROOT)).toBe(path.resolve(repoRoot));
    expect(resolveUploadDir('./data/uploads')).toBe(path.join(path.resolve(repoRoot), 'data', 'uploads'));
    expect(resolveUploadDir('data/uploads-e2e')).toBe(
      path.join(path.resolve(repoRoot), 'data', 'uploads-e2e'),
    );
    expect(process.cwd()).not.toBe(path.resolve(repoRoot)); // vitest runs in apps/server
  });

  it('an absolute path is kept', () => {
    expect(resolveUploadDir('/data/uploads')).toBe('/data/uploads');
  });
});

describe('storage keys', () => {
  it('generated keys match the layout', () => {
    expect(newAttachmentKey(new Date(Date.UTC(2026, 0, 5)))).toMatch(/^2026\/01\/[0-9a-f-]{36}$/);
    for (const key of [newAttachmentKey(), newAvatarKey(), newTmpKey()]) expect(key).toMatch(STORAGE_KEY_RE);
  });

  it('resolve() refuses anything that is not a server-generated key, and stays inside the root', () => {
    const storage = createStorage('/srv/uploads', silent);
    const good = newAttachmentKey();
    expect(storage.resolve(good)).toBe(path.join('/srv/uploads', good));
    for (const bad of [
      '../etc/passwd',
      '2026/09/../../../etc/passwd',
      '/etc/passwd',
      'avatars/../../x',
      `avatars/${'a'.repeat(36)}`,
      'avatars\\00000000-0000-4000-8000-000000000000',
      '2026/09/00000000-0000-4000-8000-000000000000/..',
      '2026/09/00000000-0000-4000-8000-000000000000\u0000',
      '',
    ]) {
      expect(() => storage.resolve(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['a\\b.txt', 'b.txt'],
    ['..\\x', 'x'],
    ['C:\\Users\\me\\photo.png', 'photo.png'],
    ['evil\u0000.txt', 'evil.txt'],
    ['tab\there\r\n.txt', 'tabhere.txt'],
    ['\u0085nel\u009f.txt', 'nel.txt'],
    ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['  spaced  ', 'spaced'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    [undefined, 'file'],
    ['\u0000\u0001', 'file'],
    ['dir/', 'file'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });

  it('caps at 255 UTF-8 bytes without splitting a code point', () => {
    const name = sanitizeFilename(`${'€'.repeat(100)}.txt`); // 3 bytes each
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).toBe('€'.repeat(85));
    const emoji = sanitizeFilename('📄'.repeat(70)); // 4 bytes each, surrogate pairs
    expect(emoji).toBe('📄'.repeat(63));
    expect(sanitizeFilename('a'.repeat(300))).toHaveLength(255);
  });
});

describe('contentDisposition', () => {
  it('ASCII names pass through', () => {
    expect(contentDisposition('inline', 'cat.png')).toBe(
      `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
    );
  });

  it('quotes, backslashes, percent and non-ASCII get an ASCII fallback and an RFC 5987 value', () => {
    const header = contentDisposition('attachment', `a"b\\c%d é (1)*'.txt`);
    expect(header).toBe(
      `attachment; filename="a_b_c_d _ (1)*'.txt"; filename*=UTF-8''a%22b%5Cc%25d%20%C3%A9%20%281%29%2A%27.txt`,
    );
    const encoded = header.split("filename*=UTF-8''")[1] ?? '';
    expect(encoded).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(encoded)).toBe(`a"b\\c%d é (1)*'.txt`);
  });

  it('an all-non-ASCII name still has a usable fallback', () => {
    expect(contentDisposition('attachment', '日本')).toBe(
      `attachment; filename="__"; filename*=UTF-8''%E6%97%A5%E6%9C%AC`,
    );
  });
});
