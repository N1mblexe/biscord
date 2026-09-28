import * as argon2 from '@node-rs/argon2';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers/app.js';
import { api, expectError } from './helpers/auth.js';
import { closeTestDb, truncateAll } from './helpers/db.js';

// Pass-through spies on argon2. Vitest isolates modules per file, so the dummy hash starts uncomputed here.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof argon2>();
  return { ...actual, hash: vi.fn(actual.hash), verify: vi.fn(actual.verify) };
});
const hashSpy = vi.mocked(argon2.hash);
const verifySpy = vi.mocked(argon2.verify);

afterAll(closeTestDb);

describe('login dummy hash', () => {
  it('is computed when the app becomes ready, so the first unknown-user login costs one verify', async () => {
    await truncateAll();
    const app = makeApp();
    try {
      expect(hashSpy).not.toHaveBeenCalled();
      await app.ready();
      expect(hashSpy).toHaveBeenCalledTimes(1);

      hashSpy.mockClear();
      verifySpy.mockClear();
      const res = await api(app, 'POST', '/api/auth/login', {
        body: { username: 'nobody', password: 'whatever it is' },
      });
      expectError(res, 401, 'INVALID_CREDENTIALS');
      expect(hashSpy).not.toHaveBeenCalled();
      expect(verifySpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('is computed once per process, not once per app', async () => {
    hashSpy.mockClear();
    const app = makeApp();
    try {
      await app.ready();
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
