import type { Page, Response } from '@playwright/test';
import type { ApiErrorBody, InvitesResponse } from '@hearth/shared';
import { api, displayNameFor, expect, NEEDS_TEST_MODE, passwordFor, test } from '../fixtures.js';
import { isFullStack } from '../env.js';

// Fixed UI strings the web app maps INVITE_INVALID and INVALID_CREDENTIALS (login form) to, shown in the form's
// role="alert" instead of the server's message (docs/plans/phase-2.md, "Web routes and UI contract").
const INVITE_INVALID_MESSAGE = 'This invite is invalid, expired, or already used.';
const INVALID_CREDENTIALS_MESSAGE = 'Wrong username or password.';

// ---- Selectors from docs/plans/phase-2.md "Web routes and UI contract" ----

function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true });
}

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function adminLink(page: Page) {
  return page.getByRole('link', { name: 'Admin', exact: true });
}

/** URL predicate: on `/login`, optionally with `?reason=<reason>` (other params such as `next` are ignored). */
function atLogin(reason?: string): (url: URL) => boolean {
  return (url) =>
    url.pathname === '/login' && (reason === undefined || url.searchParams.get('reason') === reason);
}

/** Response predicate for `page.waitForResponse`. */
function apiCall(method: string, path: string): (res: Response) => boolean {
  return (res) => res.request().method() === method && new URL(res.url()).pathname === path;
}

async function registerViaUi(page: Page, inviteCode: string, username: string): Promise<void> {
  await page.goto(`/register?invite=${encodeURIComponent(inviteCode)}`);
  await expect(field(page, 'Invite code')).toHaveValue(inviteCode);
  await field(page, 'Username').fill(username);
  await field(page, 'Display name').fill(displayNameFor(username));
  await field(page, 'Password').fill(passwordFor(username));
  await button(page, 'Create account').click();
}

/** Fills and submits the login form on the current page (must already be on `/login`). */
async function submitLogin(page: Page, username: string, password: string): Promise<void> {
  await field(page, 'Username').fill(username);
  await field(page, 'Password').fill(password);
  await button(page, 'Log in').click();
}

/** The protected layout + index: welcome text, current user, live socket. */
async function expectHome(page: Page, displayName: string): Promise<void> {
  await expect(page.getByTestId('home-welcome')).toHaveText(`Welcome, ${displayName}`);
  await expect(page.getByTestId('current-user')).toHaveText(displayName);
  await expect(page.getByTestId('socket-status')).toHaveText('connected');
}

/**
 * Creates a single-use invite on `/admin/invites` (page must be there) and returns its code as shown
 * in the table. `knownCodes` are every invite code that already exists, so the new row is the only
 * `invite-code` not matching one of them.
 */
async function createInviteViaUi(page: Page, knownCodes: readonly string[]): Promise<string> {
  await field(page, 'Max uses').fill('1');
  await button(page, 'Create invite').click();
  let newCode = page.getByTestId('invite-code');
  for (const code of knownCodes) newCode = newCode.filter({ hasNotText: code });
  await expect(newCode).toHaveCount(1);
  await expect(newCode).toHaveText(/\S/);
  return (await newCode.innerText()).trim();
}

test.describe('auth', { tag: '@auth' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);

  test('1. admin registers with the reset invite, logs out and logs back in', async ({
    page,
    adminInviteCode,
  }) => {
    await registerViaUi(page, adminInviteCode, 'alice');
    await expectHome(page, displayNameFor('alice'));

    await button(page, 'Log out').click();
    await expect(page).toHaveURL(atLogin());

    await submitLogin(page, 'alice', passwordFor('alice'));
    await expectHome(page, displayNameFor('alice'));
  });

  test('2. admin creates an invite in the UI; bob registers with it and is not an admin', async ({
    users,
    adminInviteCode,
    newPage,
  }) => {
    const { alice } = await users(['alice']);
    await alice.page.goto('/');
    await expect(adminLink(alice.page)).toBeVisible();

    await alice.page.goto('/admin/invites');
    const code = await createInviteViaUi(alice.page, [adminInviteCode]);

    const bobPage = await newPage();
    await registerViaUi(bobPage, code, 'bob');
    await expectHome(bobPage, displayNameFor('bob'));
    await expect(adminLink(bobPage)).toHaveCount(0);

    const res = await api(bobPage.request).get<ApiErrorBody>('/api/admin/invites');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('3. a used invite and a revoked invite are both rejected', async ({
    users,
    adminInviteCode,
    newPage,
  }) => {
    const { alice } = await users(['alice']);
    await alice.page.goto('/admin/invites');

    // Used: bob consumes the single-use invite, then carol tries it in a fresh context.
    const usedCode = await createInviteViaUi(alice.page, [adminInviteCode]);
    const bobPage = await newPage();
    const bob = await api(bobPage.request).post('/api/auth/register', {
      inviteCode: usedCode,
      username: 'bob',
      displayName: displayNameFor('bob'),
      password: passwordFor('bob'),
    });
    expect(bob.status).toBe(201);

    const carolPage = await newPage();
    await registerViaUi(carolPage, usedCode, 'carol');
    await expect(carolPage.getByRole('alert')).toHaveText(INVITE_INVALID_MESSAGE);
    await expect(carolPage).toHaveURL((url) => url.pathname === '/register');

    // Revoked: the admin revokes a fresh invite with its row's Revoke button.
    const revokedCode = await createInviteViaUi(alice.page, [adminInviteCode, usedCode]);
    // Accept a confirm() if the UI asks for one (Playwright dismisses dialogs by default).
    alice.page.on('dialog', (dialog) => void dialog.accept());
    await alice.page
      .getByTestId('invite-row')
      .filter({ has: alice.page.getByTestId('invite-code').filter({ hasText: revokedCode }) })
      .getByRole('button', { name: 'Revoke', exact: true })
      .click();
    await expect
      .poll(async () => {
        const res = await api(alice.request).get<InvitesResponse>('/api/admin/invites');
        return res.body.invites.find((invite) => invite.code === revokedCode)?.revokedAt ?? null;
      })
      .not.toBeNull();

    const davePage = await newPage();
    await registerViaUi(davePage, revokedCode, 'dave');
    await expect(davePage.getByRole('alert')).toHaveText(INVITE_INVALID_MESSAGE);
    await expect(davePage).toHaveURL((url) => url.pathname === '/register');
  });

  test('4. anonymous: GET /api/me is 401 and / redirects to /login', async ({ request, page }) => {
    const res = await api(request).get<ApiErrorBody>('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');

    await page.goto('/');
    await expect(page).toHaveURL(atLogin());
    await expect(button(page, 'Log in')).toBeVisible();
  });

  test('5. changing the password in one context logs out the other, not the current one', async ({
    users,
    newPage,
  }) => {
    const { alice } = await users(['alice']);
    const pageA = alice.page;
    await pageA.goto('/');
    await expectHome(pageA, alice.displayName);

    // Second session for the same user, in its own context.
    const pageB = await newPage();
    const login = await api(pageB.request).post('/api/auth/login', {
      username: alice.username,
      password: alice.password,
    });
    expect(login.status).toBe(200);
    await pageB.goto('/');
    await expectHome(pageB, alice.displayName);

    await pageA.goto('/settings');
    await field(pageA, 'Current password').fill(alice.password);
    await field(pageA, 'New password').fill(`${alice.password}-v2`);
    const changed = pageA.waitForResponse(apiCall('POST', '/api/me/password'));
    await button(pageA, 'Change password').click();
    expect((await changed).status()).toBe(204);

    await expect(pageB).toHaveURL(atLogin('password_changed'));
    await expect(pageB.getByTestId('auth-notice')).toBeVisible();

    await pageA.goto('/');
    await expectHome(pageA, alice.displayName);
  });

  test('6. admin issues a reset code; bob resets his password and logs in with the new one', async ({
    users,
    newPage,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const newPassword = `${bob.password}-v2`;

    // Bob is logged in and connected; the reset must revoke this session too.
    await bob.page.goto('/');
    await expectHome(bob.page, bob.displayName);

    await alice.page.goto('/admin/users/reset');
    await field(alice.page, 'User').selectOption({ label: bob.username });
    await button(alice.page, 'Generate reset code').click();
    const resetCode = alice.page.getByTestId('reset-code');
    await expect(resetCode).toHaveText(/\S/);
    const code = (await resetCode.innerText()).trim();

    // /reset-password is a public page (logged-in users are redirected to /), so bob uses it from
    // a fresh, logged-out context — like a second device.
    const resetPage = await newPage();
    await resetPage.goto('/reset-password');
    await field(resetPage, 'Username').fill(bob.username);
    await field(resetPage, 'Reset code').fill(code);
    await field(resetPage, 'New password').fill(newPassword);
    const reset = resetPage.waitForResponse(apiCall('POST', '/api/auth/reset-password'));
    await button(resetPage, 'Set new password').click();
    expect((await reset).status()).toBe(204);

    await expect(bob.page).toHaveURL(atLogin('password_reset'));

    await submitLogin(bob.page, bob.username, bob.password);
    await expect(bob.page.getByRole('alert')).toHaveText(INVALID_CREDENTIALS_MESSAGE);

    await submitLogin(bob.page, bob.username, newPassword);
    await expectHome(bob.page, bob.displayName);
  });
});
