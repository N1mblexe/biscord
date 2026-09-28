import { E2E_BASE_URL, LIVEKIT_HTTP_URL } from './env.js';

const CHECK_TIMEOUT_MS = 5_000;

async function probe(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function checkLiveKit(): Promise<void> {
  let detail: string;
  try {
    const res = await probe(LIVEKIT_HTTP_URL);
    if (res.status === 200) return;
    detail = `HTTP ${res.status}`;
  } catch (error) {
    detail = reason(error);
  }
  throw new Error(
    `LiveKit is not reachable at ${LIVEKIT_HTTP_URL} (${detail}) — run \`pnpm infra:up\` first`,
  );
}

async function checkFullStackHealth(baseURL: string): Promise<void> {
  const url = `${baseURL}/api/health`;
  let detail: string;
  try {
    const res = await probe(url);
    const body: unknown = await res.json().catch(() => undefined);
    const ok =
      res.ok &&
      typeof body === 'object' &&
      body !== null &&
      'status' in body &&
      body.status === 'ok' &&
      'db' in body &&
      body.db === 'ok';
    if (ok) return;
    detail = `HTTP ${res.status}, body ${JSON.stringify(body)}`;
  } catch (error) {
    detail = reason(error);
  }
  throw new Error(
    `Full stack is not healthy at ${url} (${detail}) — run \`docker compose up --build -d --wait\` first`,
  );
}

export default async function globalSetup(): Promise<void> {
  await checkLiveKit();
  // In dev-server mode, Playwright's webServer already waits on the server's /api/health.
  if (E2E_BASE_URL !== undefined) {
    await checkFullStackHealth(E2E_BASE_URL);
  }
}
