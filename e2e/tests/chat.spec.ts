import type { Locator, Page } from '@playwright/test';
import type { ApiErrorBody, ListMessagesResponse } from '@hearth/shared';
import {
  api,
  channelLink,
  channelLinkText,
  createChannel,
  expect,
  expectConnected,
  gotoChannel,
  hearthEvents,
  NEEDS_TEST_MODE,
  openDm,
  seedMessages,
  sendMessage,
  socketSwitch,
  test,
  type TestUser,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Selectors: docs/plans/phase-3.md "Web UI contract".

const CHANNEL_DELETED_NOTICE = 'This channel was deleted.';

function messageItems(page: Page): Locator {
  return page.getByTestId('message-item');
}

/** The `message-item` whose `message-content` is exactly `text`. */
function messageByText(page: Page, text: string): Locator {
  return messageItems(page).filter({
    has: page.getByTestId('message-content').getByText(text, { exact: true }),
  });
}

function messageById(page: Page, id: string): Locator {
  return page.locator(`[data-testid="message-item"][data-message-id="${id}"]`);
}

function composer(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Message', exact: true });
}

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** Types `text` into the composer, presses Enter and waits for the server-confirmed item; returns its id. */
async function sendViaComposer(page: Page, text: string): Promise<string> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  const item = messageByText(page, text);
  await expect(item).toBeVisible();
  await expect(item).not.toHaveAttribute('data-pending', 'true');
  await expect(item).toHaveAttribute('data-message-id', /^[1-9]\d*$/);
  const id = await item.getAttribute('data-message-id');
  if (id === null) throw new Error('confirmed message-item has no data-message-id');
  return id;
}

async function messageIds(items: Locator): Promise<string[]> {
  const ids = await Promise.all((await items.all()).map((item) => item.getAttribute('data-message-id')));
  return ids.map((id) => id ?? '<missing>');
}

/** Opens the app on `#name` and waits for a live socket. */
async function openChannel(user: TestUser, name: string): Promise<void> {
  await user.page.goto('/');
  await expectConnected(user.page);
  await gotoChannel(user.page, name);
}

test.describe('chat', { tag: '@chat' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);

  test('1. realtime: B sees A’s message within 1 s, then the edit and the delete', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');

    const text = 'hello from alice';
    const id = await sendViaComposer(alice.page, text);
    // Measured from A's own item being confirmed (no longer pending).
    await expect(messageByText(bob.page, text)).toBeVisible({ timeout: 1000 });

    const edited = 'hello from alice, edited';
    const aliceItem = messageById(alice.page, id);
    await aliceItem.hover();
    await button(aliceItem, 'Edit').click();
    await alice.page.getByRole('textbox', { name: 'Edit message', exact: true }).fill(edited);
    await button(aliceItem, 'Save').click();

    const bobItem = messageById(bob.page, id);
    await expect(bobItem.getByTestId('message-content')).toHaveText(edited);
    await expect(bobItem.getByTestId('message-edited')).toBeVisible();

    alice.page.once('dialog', (dialog) => void dialog.accept());
    await aliceItem.hover();
    await button(aliceItem, 'Delete').click();
    await expect(messageById(alice.page, id)).toHaveCount(0);
    await expect(bobItem).toHaveCount(0);
  });

  test('2. DM privacy: only the two members see the DM or any event for it', async ({ users }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');
    await openChannel(carol, 'general');

    await button(
      alice.page.getByTestId('member-item').filter({ hasText: bob.displayName }),
      'Message',
    ).click();
    await expect(alice.page.getByTestId('channel-title')).toHaveText(bob.displayName);
    // Alice was on /channels/<general>, so require a different channel id.
    await expect(alice.page).toHaveURL(
      (url) => /^\/channels\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(general.id),
    );
    const dmId = new URL(alice.page.url()).pathname.split('/').pop() ?? '';
    // Cross-check: get-or-create returns the same DM (200, no new event).
    expect((await openDm(alice.request, bob.id)).id).toBe(dmId);

    const secret = 'secret for bob';
    await sendViaComposer(alice.page, secret);

    // Bob: the DM shows up under Direct messages (named after Alice) and holds the message.
    await expect(bob.page.getByText('Direct messages', { exact: true }).first()).toBeVisible();
    const bobDmLink = bob.page
      .getByTestId('channel-link')
      .and(bob.page.locator(`[href="/channels/${dmId}"]`));
    await expect(bobDmLink).toHaveText(channelLinkText(alice.displayName));
    await bobDmLink.click();
    await expect(bob.page.getByTestId('channel-title')).toHaveText(alice.displayName);
    await expect(messageByText(bob.page, secret)).toBeVisible();

    // Carol: no access over REST, no sidebar entry.
    const res = await api(carol.request).get<ApiErrorBody>(`/api/channels/${dmId}/messages`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await expect(carol.page.locator(`[href="/channels/${dmId}"]`)).toHaveCount(0);

    // Positive control: a later #general message does reach Carol's event log...
    await sendMessage(alice.request, general.id, 'public after the dm');
    await expect
      .poll(async () =>
        (await hearthEvents(carol.page)).some(
          (e) => e.event === 'message:created' && e.channelId === general.id,
        ),
      )
      .toBe(true);
    // ...so by now anything sent to the DM would have arrived too.
    const leaked = (await hearthEvents(carol.page)).filter((e) => e.channelId === dmId);
    expect(leaked).toEqual([]);
  });

  test('3. scrollback: newest 50 first, Load older twice gives 1–120 in order', async ({ users }) => {
    const { alice } = await users(['alice']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await seedMessages(alice.request, {
      channelId: general.id,
      authorId: alice.id,
      count: 120,
      prefix: 'seed',
    });
    await openChannel(alice, 'general');

    const items = messageItems(alice.page);
    const contents = items.getByTestId('message-content');
    await expect(items).toHaveCount(50);
    await expect(contents.first()).toHaveText('seed 71');
    await expect(contents.last()).toHaveText('seed 120');

    const loadOlder = button(alice.page, 'Load older messages');
    await loadOlder.click();
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(100);
    // Scrolling to the top also loads older pages, so the second page may already be in, and the
    // button can vanish between a check and a click: retry the whole step until all 120 are in.
    await expect(async () => {
      if (await loadOlder.isVisible()) await loadOlder.click({ timeout: 1000 });
      await expect(items).toHaveCount(120, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    await expect(items).toHaveCount(120);
    await expect(loadOlder).toHaveCount(0);
    await expect(contents).toHaveText(Array.from({ length: 120 }, (_, i) => `seed ${i + 1}`));
    const ids = await messageIds(items);
    expect(new Set(ids).size, `duplicate ids in ${ids.join()}`).toBe(120);
  });

  test('4. offline catch-up: B reconnects and shows the 3 missed messages without a reload', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await sendMessage(alice.request, general.id, 'before offline');
    const network = await socketSwitch(bob.context);
    await openChannel(bob, 'general');
    await expect(messageByText(bob.page, 'before offline')).toBeVisible();
    // A reload would drop this marker.
    await bob.page.evaluate(() => {
      (globalThis as unknown as { __e2eNoReload?: boolean }).__e2eNoReload = true;
    });

    await network.goOffline();
    await expect(bob.page.getByTestId('socket-status')).toHaveText('disconnected');

    const missed = ['missed 1', 'missed 2', 'missed 3'];
    for (const content of missed) await sendMessage(alice.request, general.id, content);

    await network.goOnline();
    const contents = messageItems(bob.page).getByTestId('message-content');
    await expect(contents).toHaveText(['before offline', ...missed], { timeout: 10_000 });
    await expectConnected(bob.page);

    const ids = await messageIds(messageItems(bob.page));
    expect(new Set(ids).size, `duplicate ids in ${ids.join()}`).toBe(ids.length);
    const marker = await bob.page.evaluate(
      () => (globalThis as unknown as { __e2eNoReload?: boolean }).__e2eNoReload ?? false,
    );
    expect(marker, 'page was reloaded').toBe(true);
  });

  test('5. admin creates, renames, moves and deletes a channel while B watches', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(bob, 'general');
    const bobTextLinks = bob.page.getByTestId('channel-link');

    await alice.page.goto('/admin/channels');
    await alice.page.getByLabel('Name', { exact: true }).fill('random');
    await alice.page.getByLabel('Type', { exact: true }).selectOption({ label: 'Text' });
    await button(alice.page, 'Create channel').click();
    await expect(bobTextLinks).toHaveText([channelLinkText('general'), channelLinkText('random')]);

    // The row's text changes once the inline editor opens, so the editor is found page-wide.
    await button(alice.page.getByTestId('channel-row').filter({ hasText: 'random' }), 'Rename').click();
    await alice.page.getByRole('textbox', { name: 'New name', exact: true }).fill('chitchat');
    await button(alice.page, 'Save').click();
    await expect(bobTextLinks).toHaveText([channelLinkText('general'), channelLinkText('chitchat')]);

    await button(alice.page.getByTestId('channel-row').filter({ hasText: 'chitchat' }), 'Move up').click();
    await expect(bobTextLinks).toHaveText([channelLinkText('chitchat'), channelLinkText('general')]);
    // Events without a channel are logged with `channelId: null`, which hearthEvents() must accept.
    expect(await hearthEvents(bob.page)).toContainEqual({ event: 'channels:reordered', channelId: null });

    await gotoChannel(bob.page, 'chitchat');

    await button(alice.page.getByTestId('channel-row').filter({ hasText: 'chitchat' }), 'Delete').click();
    const dialog = alice.page.getByRole('dialog');
    const confirmDelete = button(dialog, 'Delete channel');
    await expect(confirmDelete).toBeDisabled();
    await dialog
      .getByRole('textbox', { name: 'Type the channel name to confirm', exact: true })
      .fill('chitchat');
    await expect(confirmDelete).toBeEnabled();
    await confirmDelete.click();

    await expect(bob.page).toHaveURL(
      (url) => url.pathname === '/' || url.pathname === `/channels/${general.id}`,
    );
    await expect(bob.page.getByTestId('app-notice')).toContainText(CHANNEL_DELETED_NOTICE);
    await expect(channelLink(bob.page, 'chitchat')).toHaveCount(0);
  });

  test('6. markdown safety: bold renders, raw HTML stays text, javascript: links are stripped', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(bob, 'general');
    const dialogs: string[] = [];
    bob.page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    const bold = await sendMessage(alice.request, general.id, '**bold**');
    const boldContent = messageById(bob.page, bold.id).getByTestId('message-content');
    await expect(boldContent.locator('strong')).toHaveText('bold');

    const html = '<img src=x onerror=alert(1)>';
    const img = await sendMessage(alice.request, general.id, html);
    const imgContent = messageById(bob.page, img.id).getByTestId('message-content');
    await expect(imgContent).toHaveText(html);
    await expect(imgContent.locator('img')).toHaveCount(0);

    const link = await sendMessage(alice.request, general.id, '[x](javascript:alert(1))');
    await expect(messageById(bob.page, link.id).getByTestId('message-content')).toContainText('x');
    await expect(bob.page.locator('a[href^="javascript:" i]')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('7. member permissions: no Delete on others’ messages, no Admin link, API says 403', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    const fromAlice = await sendMessage(alice.request, general.id, 'alice’s message');
    const fromBob = await sendMessage(bob.request, general.id, 'bob’s message');
    await openChannel(bob, 'general');

    // Positive control: Bob does get Delete on his own message.
    const ownItem = messageById(bob.page, fromBob.id);
    await ownItem.hover();
    await expect(button(ownItem, 'Delete')).toBeVisible();

    const aliceItem = messageById(bob.page, fromAlice.id);
    await aliceItem.hover();
    await expect(
      aliceItem.getByRole('button', { name: 'Delete', exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await expect(
      aliceItem.getByRole('button', { name: 'Edit', exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await expect(bob.page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);

    const res = await api(bob.request).delete<ApiErrorBody>(`/api/messages/${fromAlice.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const history = await api(bob.request).get<ListMessagesResponse>(`/api/channels/${general.id}/messages`);
    expect(history.body.messages.map((m) => m.id)).toContain(fromAlice.id);
  });

  test('8. a channel deleted while B is offline sends B to / with the notice on reconnect', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    const doomed = await createChannel(alice.request, { name: 'doomed', type: 'text' });
    const network = await socketSwitch(bob.context);
    await openChannel(bob, 'doomed');

    await network.goOffline();
    await expect(bob.page.getByTestId('socket-status')).toHaveText('disconnected');
    // B never sees channel:deleted; only the bootstrap refetch on reconnect tells it.
    expect((await api(alice.request).delete(`/api/channels/${doomed.id}`)).status).toBe(204);
    await network.goOnline();

    await expect(bob.page).toHaveURL(
      (url) => url.pathname === '/' || url.pathname === `/channels/${general.id}`,
      { timeout: 10_000 },
    );
    await expect(bob.page.getByTestId('app-notice')).toContainText(CHANNEL_DELETED_NOTICE);
    await expect(channelLink(bob.page, 'doomed')).toHaveCount(0);
  });

  test('9. a failed first load shows Retry instead of loading forever', async ({ users }) => {
    const { alice } = await users(['alice']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await sendMessage(alice.request, general.id, 'hello');
    let failHistory = true;
    await alice.page.route(
      (url) => url.pathname === `/api/channels/${general.id}/messages`,
      (route) =>
        failHistory && route.request().method() === 'GET'
          ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Server hiccup' } } })
          : route.continue(),
    );
    await openChannel(alice, 'general');

    const retry = button(alice.page, 'Retry');
    await expect(retry).toBeVisible();
    await expect(alice.page.getByText('Loading messages…')).toHaveCount(0);
    await expect(alice.page.getByRole('alert')).toHaveCount(0);

    failHistory = false;
    await retry.click();
    await expect(messageByText(alice.page, 'hello')).toBeVisible();
    await expect(retry).toHaveCount(0);
  });
});
