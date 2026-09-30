import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  normalizeCode,
  randomCode,
  randomToken,
  safeEqual,
  sha256Hex,
} from '../src/lib/crypto.js';

describe('crypto helpers', () => {
  it('randomToken is 32 bytes of base64url', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(token);
  });

  it('sha256Hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('randomCode uses Crockford base32 without I, L, O, U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    const codes = Array.from({ length: 200 }, () => randomCode(16));
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    const seen = new Set(codes.join(''));
    expect(seen.size).toBe(32);
    expect(randomCode(12)).toHaveLength(12);
  });

  it('normalizeCode: trimmed, upper case, Crockford look-alikes mapped (B.9 rule 5)', () => {
    expect(normalizeCode('  abc0123  ')).toBe('ABC0123');
    expect(normalizeCode('oOiIlL')).toBe('001111');
    expect(normalizeCode('ab-c')).toBe('AB-C');
    // Every generated code is a fixed point.
    for (let i = 0; i < 50; i += 1) {
      const code = randomCode(16);
      expect(normalizeCode(code)).toBe(code);
    }
  });

  it('safeEqual', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret2')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
