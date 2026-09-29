const MAX_FILENAME_BYTES = 255;
const DEFAULT_FILENAME = 'file';

/**
 * C0/C1 control characters (includes NUL), plus the invisible bidi controls that can disguise an extension
 * (`evil\u202Etxt.exe`).
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * CONTRACTS B.7a rule 3: the basename only (after both `/` and `\`), no control characters, at most 255
 * UTF-8 bytes, and `file` when nothing usable is left. The result is display metadata only; it never
 * becomes part of a filesystem path.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const segments = (raw ?? '').split(/[/\\]/);
  const base = (segments[segments.length - 1] ?? '').normalize('NFC').replace(UNSAFE_CHARS, '').trim();
  const name = truncateUtf8(base, MAX_FILENAME_BYTES).trim();
  return name === '' || name === '.' || name === '..' ? DEFAULT_FILENAME : name;
}

/** RFC 5987 `value-chars`: `encodeURIComponent`, plus `'()*`, which it leaves alone but aren't `attr-char`. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A quoted-string-safe ASCII stand-in: printable ASCII except `"`, `\` and `%`, others become `_`. */
function asciiFallback(value: string): string {
  const ascii = value.replace(/[^\x20-\x7e]|["\\%]/gu, '_');
  return ascii.trim() === '' ? DEFAULT_FILENAME : ascii;
}

/**
 * `Content-Disposition` per RFC 6266 with an RFC 5987 `filename*` (B.7a rule 4), e.g.
 * `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  return `${type}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
