import { expect, test } from '../fixtures.js';
import { LIVEKIT_HTTP_URL } from '../env.js';

test.describe('smoke @smoke', () => {
  // Phase 2: anonymous `/` redirects to `/login`, which keeps the Phase 1 title and server status.
  test('login page shows the app title and server status', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('app-title')).toHaveText('Hearth');
    await expect(page.getByTestId('server-status')).toHaveText('Server: ok');
  });

  test('GET /api/health reports ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  test('LiveKit answers 200', async ({ request }) => {
    const res = await request.get(LIVEKIT_HTTP_URL);
    expect(res.status()).toBe(200);
  });
});
