import type { Locator, Page } from '@playwright/test';
import {
  channelLink,
  createChannel,
  expect,
  expectConnected,
  gotoChannel,
  NEEDS_TEST_MODE,
  notifications,
  openDm,
  openSecondTab,
  sendMessage,
  setHidden,
  stubNotifications,
  test,
  type TestUser,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Selectors: docs/plans/phase-4.md "Web UI contract" (plus phase-3's message/composer selectors).
// Timing rules: CONTRACTS B.5a (presence grace 3 s, typing throttle 2 s / expiry 5 s).

const THUMBS_UP = '👍';

function composer(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Message', exact: true });
}

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

function messageById(page: Page, id: string): Locator {
  return page.locator(`[data-testid="message-item"][data-message-id="${id}"]`);
}

function memberItem(page: Page, displayName: string): Locator {
  return page.getByTestId('member-item').filter({ hasText: displayName });
}

function typingIndicator(page: Page): Locator {
  return page.getByTestId('typing-indicator');
}

function mentionBadge(page: Page, channelName: string): Locator {
  return channelLink(page, channelName).getByTestId('mention-badge');
}

function reaction(page: Page, messageId: string, emoji: string): Locator {
  return messageById(page, messageId).getByTestId('reaction').filter({ hasText: emoji });
}

/** Loads the app and waits for a live socket. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expectConnected(page);
}

/** Opens the app on `#name` and waits for a live socket. */
async function openChannel(user: TestUser, name: string): Promise<void> {
  await openApp(user.page);
  await gotoChannel(user.page, name);
}

test.describe('realtime', { tag: '@realtime' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);

  test('1. presence: A sees B come online, then go offline within 5 s of B leaving', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    // A DM so the sidebar DM link (which carries data-online too) exists on first load.
    const dm = await openDm(alice.request, bob.id);
    await openApp(alice.page);

    const bobMember = memberItem(alice.page, bob.displayName);
    const bobDmLink = alice.page
      .getByTestId('channel-link')
      .and(alice.page.locator(`[href="/channels/${dm.id}"]`));
    // Control: B has not connected yet.
    await expect(bobMember).toHaveAttribute('data-online', 'false');
    await expect(bobDmLink).toHaveAttribute('data-online', 'false');
    await expect(memberItem(alice.page, alice.displayName)).toHaveAttribute('data-online', 'true');

    await openApp(bob.page);
    await expect(bobMember).toHaveAttribute('data-online', 'true');
    await expect(bobDmLink).toHaveAttribute('data-online', 'true');

    // Closing the context drops B's only socket; offline follows the 3 s grace period.
    await bob.context.close();
    await expect(bobMember).toHaveAttribute('data-online', 'false', { timeout: 5000 });
    await expect(bobDmLink).toHaveAttribute('data-online', 'false');
  });

  test('2. typing: B sees "Alice is typing…", which expires, and clears at once on send', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');

    const indicator = typingIndicator(bob.page);
    await expect(indicator).toHaveCount(0);

    await composer(alice.page).pressSequentially('hello there', { delay: 30 });
    await expect(indicator).toHaveText('Alice is typing…');
    // The sender never sees their own indicator.
    await expect(typingIndicator(alice.page)).toHaveCount(0);

    // A stops typing: the indicator expires 5 s after the last `typing` event.
    await expect(indicator).toBeHidden({ timeout: 8000 });

    // A types again (the 2 s throttle window has long passed) and sends: B's `message:created`
    // clears the indicator straight away rather than at expiry.
    await composer(alice.page).pressSequentially('!');
    await expect(indicator).toHaveText('Alice is typing…');
    await composer(alice.page).press('Enter');
    await expect(indicator).toBeHidden({ timeout: 2000 });
    await expect(
      bob.page.getByTestId('message-content').getByText('hello there!', { exact: true }),
    ).toBeVisible();
  });

  test('3. unread and mention badge sync across B’s two tabs and clear on read', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await createChannel(alice.request, { name: 'random', type: 'text' });

    const tab1 = bob.page;
    const tab2 = await openSecondTab(bob);
    const tabs = [tab1, tab2];
    for (const tab of tabs) {
      await tab.bringToFront();
      await openApp(tab);
      await gotoChannel(tab, 'random');
    }

    for (const tab of tabs) {
      await expect(channelLink(tab, 'general')).toHaveAttribute('data-unread', 'false');
      await expect(mentionBadge(tab, 'general')).toHaveCount(0);
    }

    await sendMessage(alice.request, general.id, 'plain hello');
    for (const tab of tabs) {
      await expect(channelLink(tab, 'general')).toHaveAttribute('data-unread', 'true');
      await expect(mentionBadge(tab, 'general')).toHaveCount(0);
      await expect(channelLink(tab, 'random')).toHaveAttribute('data-unread', 'false');
    }

    await sendMessage(alice.request, general.id, '@bob hi');
    for (const tab of tabs) {
      await expect(mentionBadge(tab, 'general')).toHaveText('1');
    }

    // Reading in tab 1 POSTs the read state, which only happens in the visible tab, so bring it to
    // the front rather than rely on how the browser shows two tabs. Tab 2 follows via `readstate:updated`.
    await tab1.bringToFront();
    await gotoChannel(tab1, 'general');
    for (const tab of tabs) {
      await expect(channelLink(tab, 'general')).toHaveAttribute('data-unread', 'false');
      await expect(mentionBadge(tab, 'general')).toHaveCount(0);
    }
    await expect(tab2.getByTestId('channel-title')).toHaveText(/^#?random$/);
  });

  test('4. reactions: add through the palette, toggle from both sides, survive a reload', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    const message = await sendMessage(alice.request, general.id, 'react to me');
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');

    const aliceItem = messageById(alice.page, message.id);
    await aliceItem.hover();
    await button(aliceItem, 'Add reaction').click();
    const palette = alice.page.getByRole('dialog', { name: 'Add reaction', exact: true });
    await expect(palette).toBeVisible();
    await button(palette, THUMBS_UP).click();
    await expect(palette).toBeHidden();

    const aliceThumbs = reaction(alice.page, message.id, THUMBS_UP);
    const bobThumbs = reaction(bob.page, message.id, THUMBS_UP);
    await expect(bobThumbs).toHaveText(`${THUMBS_UP} 1`);
    await expect(bobThumbs).toHaveAttribute('aria-pressed', 'false');
    await expect(aliceThumbs).toHaveText(`${THUMBS_UP} 1`);
    await expect(aliceThumbs).toHaveAttribute('aria-pressed', 'true');

    await bobThumbs.click();
    await expect(bobThumbs).toHaveText(`${THUMBS_UP} 2`);
    await expect(bobThumbs).toHaveAttribute('aria-pressed', 'true');
    await expect(aliceThumbs).toHaveText(`${THUMBS_UP} 2`);
    await expect(aliceThumbs).toHaveAttribute('aria-pressed', 'true');

    await aliceThumbs.click();
    await expect(aliceThumbs).toHaveText(`${THUMBS_UP} 1`);
    await expect(aliceThumbs).toHaveAttribute('aria-pressed', 'false');
    await expect(bobThumbs).toHaveText(`${THUMBS_UP} 1`);
    await expect(bobThumbs).toHaveAttribute('aria-pressed', 'true');

    await bob.page.reload();
    await expectConnected(bob.page);
    await expect(messageById(bob.page, message.id).getByTestId('reaction')).toHaveCount(1);
    await expect(bobThumbs).toHaveText(`${THUMBS_UP} 1`);
    await expect(bobThumbs).toHaveAttribute('aria-pressed', 'true');
  });

  test('5. mentions notify a hidden tab (channel and DM), plain messages do not; mention is highlighted', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    await createChannel(alice.request, { name: 'random', type: 'text' });
    await stubNotifications(bob.context);

    await openApp(bob.page);
    await bob.page.getByRole('link', { name: 'Settings', exact: true }).click();
    const toggle = bob.page.getByRole('checkbox', { name: 'Desktop notifications', exact: true });
    // click(), not check(): the app may flip the box only after requestPermission() resolves.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await gotoChannel(bob.page, 'random');
    await setHidden(bob.page, true);
    expect(await notifications(bob.page)).toEqual([]);

    const mention = await sendMessage(alice.request, general.id, '@bob look');
    await expect
      .poll(() => notifications(bob.page))
      .toEqual([{ title: 'Alice in #general', body: expect.stringContaining('look') }]);

    const dm = await openDm(alice.request, bob.id);
    await sendMessage(alice.request, dm.id, 'psst in private');
    await expect.poll(() => notifications(bob.page)).toHaveLength(2);
    expect((await notifications(bob.page))[1]).toEqual({
      title: 'Alice',
      body: expect.stringContaining('psst'),
    });

    // No mention → no notification. Rather than waiting for nothing, send a DM sentinel after it:
    // events arrive in order, so once the sentinel's notification is in, the plain message's
    // would have been too.
    const plain = await sendMessage(alice.request, general.id, 'nobody in particular');
    await sendMessage(alice.request, dm.id, 'sentinel');
    await expect.poll(() => notifications(bob.page)).toHaveLength(3);
    expect((await notifications(bob.page)).map((n) => n.title)).toEqual([
      'Alice in #general',
      'Alice',
      'Alice',
    ]);
    expect((await notifications(bob.page))[2]?.body).toContain('sentinel');

    await setHidden(bob.page, false);
    await gotoChannel(bob.page, 'general');
    const mentionItem = messageById(bob.page, mention.id);
    await expect(mentionItem).toHaveAttribute('data-mentions-me', 'true');
    await expect(
      mentionItem.getByTestId('message-content').locator('span[data-testid="mention"][data-self="true"]'),
    ).toHaveText('@bob');
    await expect(messageById(bob.page, plain.id)).toBeVisible();
    await expect(messageById(bob.page, plain.id)).not.toHaveAttribute('data-mentions-me', 'true');
  });
});
