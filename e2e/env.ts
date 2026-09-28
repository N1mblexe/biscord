import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env (if present). Node's loadEnvFile never overrides variables that are
// already set, so anything exported in the shell or CI wins over the file.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Repo root (absolute). Web servers are launched from here. */
export const REPO_ROOT: string = fileURLToPath(new URL('..', import.meta.url));

/** When set (e.g. http://localhost:8080), tests run against an already-running full stack. */
export const E2E_BASE_URL: string | undefined = optional('E2E_BASE_URL')?.replace(/\/+$/, '');
export const isFullStack: boolean = E2E_BASE_URL !== undefined;

export const WEB_PORT = 5273;
export const API_PORT = 3100;
export const TEST_TOKEN = 'e2e';

/** Postgres database used by the dev-server-mode e2e server. */
export const DATABASE_URL_E2E: string =
  optional('DATABASE_URL_E2E') ?? 'postgres://hearth:hearth@localhost:5432/hearth_e2e';

/** LiveKit HTTP endpoint (server→LiveKit URL); a ws(s):// value is mapped to http(s)://. */
export const LIVEKIT_HTTP_URL: string = (optional('LIVEKIT_URL') ?? 'http://localhost:7880')
  .replace(/^ws(s?):\/\//, 'http$1://')
  .replace(/\/+$/, '');
