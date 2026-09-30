import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Crockford base32 alphabet: no I, L, O or U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32 random bytes, base64url-encoded (43 chars). Used for session tokens. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** `length` random Crockford base32 characters. Unbiased: 256 is a multiple of 32. */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let code = '';
  for (const byte of bytes) code += CROCKFORD_ALPHABET.charAt(byte & 31);
  return code;
}

/**
 * Normalizes a user-typed code (invite or reset) before lookup (CONTRACTS B.9 rule 5): trimmed, upper case,
 * and the Crockford look-alikes mapped to the digits they stand for (`O` → `0`, `I`/`L` → `1`). Generated
 * codes never contain those letters, so this only ever turns a typo into the real code.
 */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Constant-time string comparison that does not leak the length of either input. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}
