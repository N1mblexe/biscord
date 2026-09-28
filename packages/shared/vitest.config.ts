import { defineConfig } from 'vitest/config';

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
  },
});
