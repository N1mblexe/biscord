import type { Page } from '@playwright/test';
import {
  api,
  expect,
  expectConnected,
  joinVoice,
  leaveVoice,
  test,
  tinyPng,
  uploadAttachmentOk,
} from '../fixtures.js';
import { E2E_LIVEKIT_ORIGINS, E2E_PASSWORD, E2E_USERNAME, E2E_VOICE_CHANNEL, isFullStack } from '../env.js';

// Phase 8 scenario 6 (docs/plans/phase-8.md "Key decisions → Security headers", CONTRACTS B.7a rule 4,
// B.7b). Full-stack mode only: Caddy (infra/caddy/Caddyfile) sets these headers, and the Vite dev
// server serves no CSP. The logged-in checks also need E2E_USERNAME / E2E_PASSWORD (an existing
// account on the full stack), because the full stack has no test mode to create one.

const FULL_STACK_ONLY = 'full-stack only (E2E_BASE_URL): Caddy sets these headers, Vite serves no CSP';

/** `Content-Security-Policy` parsed into directive → source list (names lowercased). */
function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * Records CSP violations in `page` from now on: `securitypolicyviolation` events (init script, every
 * document) and console messages that mention the Content Security Policy. Returns a reader.
 */
async function recordCspViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleHits: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) consoleHits.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    // e2e has no DOM lib: reach the page globals through a typed view of globalThis.
    const g = globalThis as unknown as {
      addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
      __cspViolations?: string[];
    };
    const recorded: string[] = [];
    g.__cspViolations = recorded;
    g.addEventListener(
      'securitypolicyviolation',
      (event) => {
        const v = event as { violatedDirective?: string; blockedURI?: string };
        recorded.push(`event: ${v.violatedDirective ?? '?'} blocked ${v.blockedURI ?? '?'}`);
      },
      true,
    );
  });
  return async () => {
    const raw = await page.evaluate(
      () => (globalThis as unknown as { __cspViolations?: unknown }).__cspViolations ?? null,
    );
    if (!Array.isArray(raw)) throw new Error('the CSP violation recorder is not installed');
    const events: unknown[] = raw;
    return [...events.map(String), ...consoleHits];
  };
}

test.describe('security headers', { tag: ['@smoke', '@headers'] }, () => {
  test.skip(!isFullStack, FULL_STACK_ONLY);

  for (const path of ['/', '/login']) {
    test(`GET ${path} carries the CSP and the security headers, and no Server header`, async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/html');
      const headers = res.headers();

      const cspHeader = headers['content-security-policy'];
      expect(cspHeader, 'Content-Security-Policy').toBeDefined();
      const csp = parseCsp(cspHeader ?? '');
      expect(csp.get('default-src')).toEqual(["'self'"]);
      expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
      expect(csp.get('connect-src')).toContain("'self'");
      // The LiveKit signalling origin(s): E2E_LIVEKIT_ORIGIN, default ws://localhost:7880 (local full stack).
      for (const origin of E2E_LIVEKIT_ORIGINS) {
        expect(csp.get('connect-src')).toContain(origin);
      }
      // No inline or eval'd script is allowed anywhere.
      for (const directive of ['script-src', 'default-src']) {
        expect(csp.get(directive) ?? []).not.toContain("'unsafe-inline'");
        expect(csp.get(directive) ?? []).not.toContain("'unsafe-eval'");
      }

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['permissions-policy']).toBeDefined();
      for (const feature of ['camera=(self)', 'microphone=(self)', 'display-capture=(self)']) {
        expect(headers['permissions-policy']).toContain(feature);
      }
      expect(headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(headers).not.toHaveProperty('server');
    });
  }

  test('API responses carry no Server header', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(res.headers()).not.toHaveProperty('server');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('the login page loads under the CSP with no violations', async ({ page }) => {
    const violations = await recordCspViolations(page);
    await page.goto('/login');
    await expect(page.getByTestId('app-title')).toHaveText('Hearth');
    // The health fetch went through connect-src 'self'.
    await expect(page.getByTestId('server-status')).toHaveText('Server: ok');
    await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    expect(await violations()).toEqual([]);
  });

  test('logged in: the socket connects with no CSP violations; attachments keep the sandbox CSP', async ({
    page,
  }) => {
    test.skip(
      E2E_USERNAME === undefined || E2E_PASSWORD === undefined,
      'set E2E_USERNAME and E2E_PASSWORD to an existing full-stack account',
    );
    const violations = await recordCspViolations(page);
    const login = await api(page.request).post('/api/auth/login', {
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
    });
    expect(login.status, 'POST /api/auth/login').toBe(200);

    await page.goto('/');
    // The Socket.IO WebSocket is same-origin: allowed by connect-src 'self'.
    await expectConnected(page);
    expect(await violations()).toEqual([]);

    // The server's per-file CSP wins over Caddy's (`?` in the Caddyfile only fills a missing header).
    const attachment = await uploadAttachmentOk(page.request, tinyPng('headers-check.png'));
    const res = await page.request.get(attachment.url);
    expect(res.status()).toBe(200);
    const csp = parseCsp(res.headers()['content-security-policy'] ?? '');
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.has('sandbox')).toBe(true);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()).not.toHaveProperty('server');
  });

  test('logged in: joining voice (LiveKit signaling + media) raises no CSP violation', async ({ page }) => {
    test.skip(
      E2E_USERNAME === undefined || E2E_PASSWORD === undefined,
      'set E2E_USERNAME and E2E_PASSWORD to an existing full-stack account',
    );
    test.skip(E2E_VOICE_CHANNEL === undefined, 'set E2E_VOICE_CHANNEL to an existing voice channel name');
    const channel = E2E_VOICE_CHANNEL ?? '';
    const violations = await recordCspViolations(page);
    const login = await api(page.request).post('/api/auth/login', {
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
    });
    expect(login.status, 'POST /api/auth/login').toBe(200);

    await page.goto('/');
    await expectConnected(page);
    // Waits for voice-panel[data-state="connected"]: the LiveKit WebSocket (connect-src) and the
    // lazily loaded LiveKit chunk (script-src 'self') both went through.
    await joinVoice(page, channel);
    expect(await violations()).toEqual([]);
    await leaveVoice(page);
  });
});
