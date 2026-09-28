import { hash, verify } from '@node-rs/argon2';
import { randomToken } from '../lib/crypto.js';

// argon2id with the library defaults (m=19456 KiB, t=2, p=1): Argon2id is the default algorithm.

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Never throws: a malformed stored hash counts as a mismatch. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Computes the dummy hash once per process. Called eagerly when the app becomes ready (`onReady` in
 * `buildApp`), so even the first unknown-user login costs exactly one verify, like every other login.
 */
export async function warmUpDummyHash(): Promise<void> {
  dummyHash ??= hash(randomToken());
  await dummyHash;
}

/**
 * Runs one verify against a throwaway hash with the same parameters as real ones, so a login for an unknown
 * user takes as long as one with a wrong password. Always resolves `false`.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hash(randomToken()); // only if the warm-up was skipped (e.g. a service called without an app)
  await verifyPassword(await dummyHash, password);
  return false;
}
