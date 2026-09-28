/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `'true'` only in the Playwright dev-server build (e2e/playwright.config.ts); enables the event log. */
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** One server→client socket event, as recorded by the e2e-only event log (src/lib/eventLog.ts). */
interface HearthEventLogEntry {
  event: string;
  /** The channel the event is about, or `null` for events without one (e.g. `channels:reordered`). */
  channelId: string | null;
}

interface Window {
  /** Present only when `VITE_E2E === 'true'`. */
  __hearthEvents?: HearthEventLogEntry[];
}
