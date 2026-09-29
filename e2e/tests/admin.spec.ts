import type { Locator, Page } from '@playwright/test';
import type { ApiErrorBody, InviteResponse, UserResponse } from '@hearth/shared';
import {
  api,
  createChannel,
  createVoiceChannel,
  displayNameFor,
  expect,
  escapeRegExp,
  expectConnected,
  gotoChannel,
  joinVoice,
  NEEDS_TEST_MODE,
  openDm,
  passwordFor,
  sendMessage,
  test,
  voiceChannel,
  voiceDebug,
  voicePanel,
  voiceParticipant,
  VOICE_MEDIA_TIMEOUT,
  type TestUser,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Phase 8 admin and moderation (docs/plans/phase-8.md "Web UI contract" and "Acceptance tests →
// Playwright" 1–5; CONTRACTS B.4 rows 18, 31, 35–38, B.5 `voice:kicked`, B.7b). The e2e server runs
// with MAX_USERS=5 (playwright.config.ts) so the account cap is reachable. Nothing sleeps.

const LAST_ADMIN_ALERT = "You can't remove the last admin.";
const USER_LIMIT_ALERT = 'The account limit has been reached.';
const DELETED_USER = 'Deleted user';
const READ_ONLY_DM = 'This conversation is read-only.';
const KICKED_BY_ADMIN_NOTICE = 'You were disconnected from voice by an admin.';
const VOICE_CHANNEL_DELETED_NOTICE = 'This voice channel was deleted.';
// Phase 2 login-form mapping of INVALID_CREDENTIALS (docs/plans/phase-2.md).
const INVALID_CREDENTIALS_MESSAGE = 'Wrong username or password.';

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** `/admin/users` row of `username` (`data-testid="user-row"` with `data-username`). */
function userRow(page: Page, username: string): Locator {
  return page.locator(`[data-testid="user-row"][data-username="${username}"]`);
}

/** The `message-author` of the message `id` (Phase 3 `message-item` with `data-message-id`). */
function messageAuthorOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="message-item"][data-message-id="${id}"]`).getByTestId('message-author');
}

/** An alert (`role="alert"`) carrying `text`; other alerts may exist next to it. */
function alertWith(page: Page, text: string): Locator {
  return page.getByRole('alert').filter({ hasText: text });
}

/** URL predicate: on `/login`, optionally with `?reason=<reason>`. */
function atLogin(reason?: string): (url: URL) => boolean {
  return (url) =>
    url.pathname === '/login' && (reason === undefined || url.searchParams.get('reason') === reason);
}

/** Loads the app and waits for a live socket. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expectConnected(page);
}

/**
 * Opens `/admin/users` in a second tab of the admin's context, so the admin's first tab keeps its
 * voice connection (a full navigation would drop it). Waits until the admin's own row is listed.
 */
async function openAdminUsers(admin: TestUser): Promise<Page> {
  const page = await admin.context.newPage();
  acceptNativeDialogs(page);
  await page.goto('/admin/users');
  await expect(userRow(page, admin.username)).toBeVisible();
  return page;
}

/** Safety net: accept a native confirm() if the UI uses one (Playwright dismisses them by default). */
function acceptNativeDialogs(page: Page): void {
  page.on('dialog', (dialog) => void dialog.accept());
}

/**
 * Clicks `action` in `username`'s row. The contract gives only **Deactivate** a confirm dialog; the
 * plan's key decisions mention one for Reactivate too, so any other action also confirms a dialog if
 * one shows up: whichever of the dialog's `action` button and `outcome` appears first decides.
 */
async function rowAction(page: Page, username: string, action: string, outcome: Locator): Promise<void> {
  await button(userRow(page, username), action).click();
  const confirm = button(page.getByRole('dialog'), action);
  await expect(confirm.or(outcome).first()).toBeVisible();
  if (await confirm.isVisible()) await confirm.click();
  await expect(outcome).toBeVisible();
}

/** Deactivates `username` through the row's **Deactivate** and the **Deactivate user** dialog. */
async function deactivateViaUi(page: Page, username: string): Promise<void> {
  await button(userRow(page, username), 'Deactivate').click();
  const dialog = page.getByRole('dialog', { name: 'Deactivate user' });
  await button(dialog, 'Deactivate').click();
  await expect(dialog).toHaveCount(0);
  await expect(userRow(page, username).getByTestId('user-status')).toHaveText('deactivated');
}

/** Deactivates through the API (row 36): 204 (teardown, B.7). */
async function deactivateViaApi(admin: TestUser, userId: string): Promise<void> {
  const res = await api(admin.request).post(`/api/admin/users/${userId}/deactivate`);
  expect(res.status, `POST /api/admin/users/${userId}/deactivate`).toBe(204);
}

/** Fills and submits the login form (the page must be on `/login`). */
async function submitLogin(page: Page, username: string): Promise<void> {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(passwordFor(username));
  await button(page, 'Log in').click();
}

/**
 * Opens `target`'s participant menu on `page` through its context button **Volume**
 * (docs/plans/phase-6.md) and waits for the menu (its **Volume for <name>** slider) to show.
 */
async function openParticipantMenu(page: Page, target: TestUser): Promise<void> {
  await button(voiceParticipant(page, target.id), 'Volume').click();
  await expect(
    page.getByRole('slider', { name: `Volume for ${target.displayName}`, exact: true }),
  ).toBeVisible();
}

/** The admin-only **Disconnect** item of an open participant menu (a button or a menuitem). */
function disconnectItem(page: Page): Locator {
  return button(page, 'Disconnect').or(page.getByRole('menuitem', { name: 'Disconnect', exact: true }));
}

/** Deletes channel `name` on `/admin/channels` (the page must be there) through its confirm dialog. */
async function deleteChannelViaUi(page: Page, name: string): Promise<void> {
  const exactName = new RegExp(`^${escapeRegExp(name)}$`);
  const row = page
    .getByTestId('channel-row')
    .filter({ has: page.getByTestId('channel-row-name').filter({ hasText: exactName }) });
  await button(row, 'Delete').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Type the channel name to confirm', exact: true }).fill(name);
  await button(dialog, 'Delete channel').click();
  await expect(row).toHaveCount(0);
}

/** Polls `page`'s LiveKit remotes until `userId` is gone from them. */
async function expectNotRemote(page: Page, userId: string, who: string): Promise<void> {
  await expect
    .poll(async () => (await voiceDebug(page)).remotes.map((r) => r.identity), {
      message: `${who} is gone from the LiveKit room`,
      timeout: VOICE_MEDIA_TIMEOUT,
    })
    .not.toContain(userId);
}

test.describe('admin', { tag: '@admin' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);
  // Voice scenarios connect to LiveKit several times (each bounded by VOICE_MEDIA_TIMEOUT).
  test.describe.configure({ timeout: 120_000 });

  test('1. deactivating a user in voice: kicked to login, gone from voice, "Deleted user", read-only DM', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await createVoiceChannel(alice.request, 'Lounge');
    const dm = await openDm(alice.request, bob.id);
    const channelMessage = await sendMessage(bob.request, general.id, 'hello from bob');
    const dmMessage = await sendMessage(bob.request, dm.id, 'a dm from bob');

    await openApp(alice.page);
    await openApp(bob.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expect(voiceParticipant(alice.page, bob.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });

    const admin = await openAdminUsers(alice);
    await expect(userRow(admin, 'bob').getByTestId('user-status')).toHaveText('active');
    await deactivateViaUi(admin, 'bob');

    // Bob: the session:revoked {reason:'deactivated'} redirect (Phase 2), which also ends his voice.
    await expect(bob.page).toHaveURL(atLogin('deactivated'));
    await expect(voicePanel(bob.page)).toHaveCount(0);

    // Alice: Bob is gone from the sidebar list and from her LiveKit room; she is still connected.
    await expect(voiceParticipant(alice.page, bob.id)).toHaveCount(0, { timeout: VOICE_MEDIA_TIMEOUT });
    await expectNotRemote(alice.page, bob.id, 'Bob');
    await expect(voicePanel(alice.page)).toHaveAttribute('data-state', 'connected');

    // Bob can no longer log in, in the UI or through the API.
    await submitLogin(bob.page, bob.username);
    await expect(alertWith(bob.page, INVALID_CREDENTIALS_MESSAGE)).toBeVisible();
    await expect(bob.page).toHaveURL(atLogin());
    const login = await api(bob.request).post<ApiErrorBody>('/api/auth/login', {
      username: bob.username,
      password: bob.password,
    });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');

    // Alice sees his old messages authored by "Deleted user" (B.7b rule 5).
    await gotoChannel(alice.page, 'general');
    await expect(messageAuthorOf(alice.page, channelMessage.id)).toHaveText(DELETED_USER);
    await expect(alice.page.getByTestId('message-author').filter({ hasText: bob.displayName })).toHaveCount(
      0,
    );

    // The DM is titled "Deleted user" and read-only.
    await gotoChannel(alice.page, DELETED_USER);
    await expect(messageAuthorOf(alice.page, dmMessage.id)).toHaveText(DELETED_USER);
    const composer = alice.page
      .getByRole('textbox', { name: 'Message', exact: true })
      .or(alice.page.getByRole('textbox', { name: READ_ONLY_DM, exact: true }));
    await expect(composer).toBeDisabled();
    // "Labelled": as its accessible name, its placeholder or a visible caption.
    await expect(
      alice.page
        .getByLabel(READ_ONLY_DM, { exact: true })
        .or(alice.page.getByPlaceholder(READ_ONLY_DM, { exact: true }))
        .or(alice.page.getByText(READ_ONLY_DM, { exact: true }))
        .first(),
    ).toBeVisible();
    // The server agrees (Phase 3): sending to the DM is forbidden.
    const send = await api(alice.request).post<ApiErrorBody>(`/api/channels/${dm.id}/messages`, {
      content: 'anyone there?',
    });
    expect(send.status).toBe(403);
  });

  test('2. last admin: Remove admin on herself shows the LAST_ADMIN alert and keeps her role', async ({
    users,
  }) => {
    const { alice } = await users(['alice', 'bob']);
    await alice.page.goto('/admin/users');
    acceptNativeDialogs(alice.page);
    const aliceRole = userRow(alice.page, 'alice').getByTestId('user-role');
    await expect(aliceRole).toHaveText('admin');
    await expect(userRow(alice.page, 'bob').getByTestId('user-role')).toHaveText('member');

    await rowAction(alice.page, 'alice', 'Remove admin', alertWith(alice.page, LAST_ADMIN_ALERT));

    await expect(aliceRole).toHaveText('admin');
    const me = await api(alice.request).get<UserResponse>('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('admin');
    // Still an admin in the UI too: the page stays usable.
    await alice.page.reload();
    await expect(userRow(alice.page, 'alice').getByTestId('user-role')).toHaveText('admin');
  });

  test('3. deleting a voice channel with 2 occupants disconnects both with a notice', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await openApp(bob.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    for (const user of [alice, bob]) {
      await expect(voiceParticipant(user.page, alice.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
      await expect(voiceParticipant(user.page, bob.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
    }

    // Alice deletes it from a second tab, so her first tab stays in the room until the kick.
    const admin = await alice.context.newPage();
    acceptNativeDialogs(admin);
    await admin.goto('/admin/channels');
    await deleteChannelViaUi(admin, 'Lounge');

    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('app-notice')).toContainText(VOICE_CHANNEL_DELETED_NOTICE);
      await expect(voicePanel(user.page)).toHaveCount(0, { timeout: VOICE_MEDIA_TIMEOUT });
      await expect(voiceChannel(user.page, 'Lounge')).toHaveCount(0);
      await expect(voiceParticipant(user.page, alice.id)).toHaveCount(0);
      await expect(voiceParticipant(user.page, bob.id)).toHaveCount(0);
    }
  });

  test('4. admin Disconnect on bob: bob leaves voice and sees the notice', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await openApp(bob.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expect(voiceParticipant(alice.page, bob.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(voiceParticipant(bob.page, alice.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });

    // A member's participant menu has no Disconnect.
    await openParticipantMenu(bob.page, alice);
    await expect(disconnectItem(bob.page)).toHaveCount(0);

    await openParticipantMenu(alice.page, bob);
    await disconnectItem(alice.page).click();

    await expect(voicePanel(bob.page)).toHaveCount(0, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(bob.page.getByTestId('app-notice')).toContainText(KICKED_BY_ADMIN_NOTICE);
    await expect(voiceParticipant(alice.page, bob.id)).toHaveCount(0, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(voiceParticipant(bob.page, bob.id)).toHaveCount(0);
    await expectNotRemote(alice.page, bob.id, 'Bob');
    // Only Bob was removed: Alice is still connected and still listed.
    await expect(voicePanel(alice.page)).toHaveAttribute('data-state', 'connected');
    await expect(voiceParticipant(bob.page, alice.id)).toHaveCount(1);
    // Bob's session is untouched: he is still logged in with a live socket.
    await expectConnected(bob.page);
  });

  test('5. reactivate: USER_LIMIT at the cap; below it bob is back and can log in', async ({
    users,
    newPage,
  }) => {
    // MAX_USERS=5 on the e2e server; the cap counts active users (Phase 2 register guard).
    const { alice, bob } = await users(['alice', 'bob', 'carol', 'dave', 'erin']);
    await deactivateViaApi(alice, bob.id);

    // Frank takes the freed seat, so the server is at the cap again.
    const invite = await api(alice.request).post<InviteResponse>('/api/admin/invites', { maxUses: 1 });
    expect(invite.status).toBe(201);
    const frankPage = await newPage();
    const frank = await api(frankPage.request).post<UserResponse>('/api/auth/register', {
      inviteCode: invite.body.invite.code,
      username: 'frank',
      displayName: displayNameFor('frank'),
      password: passwordFor('frank'),
    });
    expect(frank.status, 'register frank').toBe(201);

    await alice.page.goto('/admin/users');
    acceptNativeDialogs(alice.page);
    const bobStatus = userRow(alice.page, 'bob').getByTestId('user-status');
    await expect(bobStatus).toHaveText('deactivated');

    await rowAction(alice.page, 'bob', 'Reactivate', alertWith(alice.page, USER_LIMIT_ALERT));
    await expect(bobStatus).toHaveText('deactivated');

    // Below the cap: deactivate frank, then bob's reactivation goes through.
    await deactivateViaUi(alice.page, 'frank');
    await rowAction(
      alice.page,
      'bob',
      'Reactivate',
      userRow(alice.page, 'bob')
        .getByTestId('user-status')
        .filter({ hasText: /^active$/ }),
    );
    await expect(bobStatus).toHaveText('active');

    // Reactivation restores the account but not its sessions (B.7b rule 3): bob logs in again.
    await bob.page.goto('/');
    await expect(bob.page).toHaveURL(atLogin());
    await submitLogin(bob.page, bob.username);
    await expect(bob.page.getByTestId('current-user')).toHaveText(bob.displayName);
    await expectConnected(bob.page);
  });
});
