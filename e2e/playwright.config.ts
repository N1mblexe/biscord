import { defineConfig, devices } from '@playwright/test';
import {
  API_PORT,
  DATABASE_URL_E2E,
  E2E_BASE_URL,
  isFullStack,
  REPO_ROOT,
  TEST_TOKEN,
  UPLOAD_DIR_E2E,
  WEB_PORT,
} from './env.js';

const webURL = `http://localhost:${WEB_PORT}`;
const WEB_SERVER_TIMEOUT = 60_000;

/** process.env merged with overrides, minus undefined values (webServer.env wants Record<string, string>). */
function envWith(overrides: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...overrides };
}

export default defineConfig({
  testDir: 'tests',
  // Keep artifacts at the repo root, where .gitignore / .prettierignore / eslint ignores cover them.
  outputDir: '../test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL ?? webURL,
    // The suite asserts the English (default) copy; language-specific checks live in tests/i18n.spec.ts (B.11).
    locale: 'en-US',
    trace: 'retain-on-failure',
    permissions: ['microphone', 'camera', 'notifications'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  // Full-stack mode (E2E_BASE_URL set): the stack is already running, start nothing.
  webServer: isFullStack
    ? undefined
    : [
        {
          name: 'server',
          // Run the binaries directly (not via `pnpm exec`): Playwright stops the process it spawned,
          // and a pnpm wrapper would leave tsx/vite orphaned and holding the ports.
          command: 'node_modules/.bin/tsx --conditions=hearth-src src/index.ts',
          cwd: `${REPO_ROOT}/apps/server`,
          url: `http://localhost:${API_PORT}/api/health`,
          reuseExistingServer: false,
          timeout: WEB_SERVER_TIMEOUT,
          stdout: 'pipe',
          env: envWith({
            NODE_ENV: 'test',
            PORT: String(API_PORT),
            DATABASE_URL: DATABASE_URL_E2E,
            MIGRATE_ON_START: 'true',
            HEARTH_TEST_MODE: 'true',
            HEARTH_TEST_TOKEN: TEST_TOKEN,
            APP_ORIGIN: webURL,
            COOKIE_SECURE: 'false',
            UPLOAD_DIR: UPLOAD_DIR_E2E,
            // Fast voice reconcile with LiveKit (CONTRACTS B.8): the safety net behind the webhooks.
            VOICE_RECONCILE_MS: '5000',
            // A reachable account cap for the USER_LIMIT scenario (admin.spec.ts, scenario 5). No other
            // spec registers more than 3 users.
            MAX_USERS: '5',
          }),
        },
        {
          name: 'web',
          command: 'node_modules/.bin/vite',
          cwd: `${REPO_ROOT}/apps/web`,
          url: webURL,
          reuseExistingServer: false,
          timeout: WEB_SERVER_TIMEOUT,
          env: envWith({
            WEB_PORT: String(WEB_PORT),
            HEARTH_API_PORT: String(API_PORT),
            VITE_E2E: 'true',
          }),
        },
      ],
});
