import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Load the repo-root .env (DATABASE_URL_UNIT) into this process; test workers and globalSetup inherit it.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  // Vitest runs node tests in Vite's SSR environment, which ignores top-level `resolve.conditions`;
  // set both so `@hearth/shared` always resolves to its TS source, never a stale dist/.
  resolve: {
    conditions: ['hearth-src'],
  },
  ssr: {
    resolve: {
      conditions: ['hearth-src'],
      externalConditions: ['hearth-src'],
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
