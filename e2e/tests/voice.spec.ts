import type { Locator, Page } from '@playwright/test';
import {
  createVoiceChannel,
  expect,
  expectConnected,
  expectHearing,
  hearthEvents,
  joinVoice,
  leaveVoice,
  NEEDS_TEST_MODE,
  test,
  voiceChannel,
  voiceDebug,
  voiceParticipant,
  voiceParticipantIds,
  voicePanel,
  VOICE_MEDIA_TIMEOUT,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Selectors and debug hook: docs/plans/phase-6.md "Web UI contract" and "Key decisions → Debug hook".
// Rules: CONTRACTS B.6 / B.6a. Media runs through the real LiveKit container with Chromium's fake
// devices (the fake mic plays a periodic beep). Every media assertion polls; nothing sleeps.

/** "Carol sees them within 5 s" (plan, Playwright scenario 2). */
const VISIBLE_WITHIN = 5_000;

function panelButton(page: Page, name: string): Locator {
  return voicePanel(page).getByRole('button', { name, exact: true });
}

/** Loads the app and waits for a live socket. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expectConnected(page);
}

/** Polls until `channelName` lists exactly `userIds` on `page`. */
async function expectListed(
  page: Page,
  channelName: string,
  userIds: readonly string[],
  timeout = VOICE_MEDIA_TIMEOUT,
): Promise<void> {
  await expect
    .poll(() => voiceParticipantIds(page, channelName), {
      message: `voice participants under ${channelName}`,
      timeout,
    })
    .toEqual([...userIds].sort());
}

/**
 * Records, from now on, the largest number of `voice-panel` elements that were ever in the DOM at
 * once. A MutationObserver runs after every DOM change (before paint), so even a transient second
 * panel is caught. Read it with `maxVoicePanels`.
 */
async function trackVoicePanels(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Observer {
      observe(target: unknown, options: { childList: boolean; subtree: boolean; attributes: boolean }): void;
    }
    const g = globalThis as unknown as {
      document: { documentElement: unknown; querySelectorAll(selector: string): { length: number } };
      MutationObserver: new (callback: () => void) => Observer;
      __maxVoicePanels?: number;
    };
    const count = (): number => g.document.querySelectorAll('[data-testid="voice-panel"]').length;
    g.__maxVoicePanels = count();
    new g.MutationObserver(() => {
      g.__maxVoicePanels = Math.max(g.__maxVoicePanels ?? 0, count());
    }).observe(g.document.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

async function maxVoicePanels(page: Page): Promise<number> {
  const max = await page.evaluate(
    () => (globalThis as unknown as { __maxVoicePanels?: unknown }).__maxVoicePanels ?? null,
  );
  if (typeof max !== 'number') throw new Error('trackVoicePanels was not installed');
  return max;
}

test.describe('voice', { tag: '@voice' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);
  // Several LiveKit connects and media polls per test (each bounded by VOICE_MEDIA_TIMEOUT).
  test.describe.configure({ timeout: 120_000 });

  test('1. join and hear: both connected, both listed, each receives the other’s audio', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const lounge = await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await openApp(bob.page);

    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');

    for (const user of [alice, bob]) {
      await expect(voicePanel(user.page)).toHaveCount(1);
      await expect(voicePanel(user.page)).toHaveAttribute('data-state', 'connected');
      await expectListed(user.page, 'Lounge', [alice.id, bob.id]);
      const debug = await voiceDebug(user.page);
      expect(debug.state).toBe('connected');
      expect(debug.roomName).toBe(`voice_${lounge.id}`);
      expect(debug.localIdentity).toBe(user.id);
      expect(debug.playbackMuted).toBe(false);
    }

    await expectHearing(alice.page, bob.id, 'Bob');
    await expectHearing(bob.page, alice.id, 'Alice');
  });

  test('2. visible to non-members: Carol sees both within 5 s, then sees each Leave', async ({ users }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    const lounge = await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await expect(voiceChannel(carol.page, 'Lounge')).toBeVisible();
    await expectListed(carol.page, 'Lounge', [], VISIBLE_WITHIN);

    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expectListed(carol.page, 'Lounge', [alice.id, bob.id], VISIBLE_WITHIN);
    // Carol only watches: she has no voice panel.
    await expect(voicePanel(carol.page)).toHaveCount(0);

    await leaveVoice(alice.page);
    await expectListed(carol.page, 'Lounge', [bob.id]);
    await expectListed(bob.page, 'Lounge', [bob.id]);
    await expect(voiceParticipant(carol.page, alice.id)).toHaveCount(0);

    await leaveVoice(bob.page);
    await expectListed(carol.page, 'Lounge', []);
    expect(await hearthEvents(carol.page)).toContainEqual({ event: 'voice:left', channelId: lounge.id });
  });

  test('3. mute and deafen are seen by others; deafen mutes playback; undeafen restores mute', async ({
    users,
  }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expectHearing(alice.page, bob.id, 'Bob');

    const observers = [bob.page, carol.page];
    async function expectAliceSeenAs(muted: boolean, deafened: boolean): Promise<void> {
      for (const page of observers) {
        const entry = voiceParticipant(page, alice.id);
        await expect(entry).toHaveAttribute('data-muted', String(muted));
        await expect(entry).toHaveAttribute('data-deafened', String(deafened));
      }
    }
    async function expectPlaybackMuted(muted: boolean): Promise<void> {
      await expect
        .poll(async () => (await voiceDebug(alice.page)).playbackMuted, {
          message: 'Alice’s playbackMuted',
          timeout: VOICE_MEDIA_TIMEOUT,
        })
        .toBe(muted);
    }

    await expectAliceSeenAs(false, false);

    // Unmuted → Deafen → Undeafen: deafen self-mutes, undeafen brings the mic back.
    await panelButton(alice.page, 'Deafen').click();
    await expect(panelButton(alice.page, 'Undeafen')).toHaveAttribute('aria-pressed', 'true');
    await expectAliceSeenAs(true, true);
    await expectPlaybackMuted(true);
    // Deafen mutes playback only: Bob's track stays subscribed.
    const deafened = await voiceDebug(alice.page);
    expect(deafened.remotes.find((r) => r.identity === bob.id)?.audioSubscribed).toBe(true);

    await panelButton(alice.page, 'Undeafen').click();
    await expect(panelButton(alice.page, 'Deafen')).toHaveAttribute('aria-pressed', 'false');
    await expect(panelButton(alice.page, 'Mute')).toHaveAttribute('aria-pressed', 'false');
    await expectAliceSeenAs(false, false);
    await expectPlaybackMuted(false);

    // Muted → Deafen → Undeafen: the earlier mute survives the undeafen.
    await panelButton(alice.page, 'Mute').click();
    await expect(panelButton(alice.page, 'Unmute')).toHaveAttribute('aria-pressed', 'true');
    await expectAliceSeenAs(true, false);

    await panelButton(alice.page, 'Deafen').click();
    await expectAliceSeenAs(true, true);
    await expectPlaybackMuted(true);

    await panelButton(alice.page, 'Undeafen').click();
    await expect(panelButton(alice.page, 'Deafen')).toHaveAttribute('aria-pressed', 'false');
    await expect(panelButton(alice.page, 'Unmute')).toHaveAttribute('aria-pressed', 'true');
    await expectAliceSeenAs(true, false);
    await expectPlaybackMuted(false);
  });

  test('4. speaking ring: Alice sees Bob speaking while his fake mic beeps', async ({ users }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await openApp(bob.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');

    const bobEntry = voiceParticipant(alice.page, bob.id);
    await expect(bobEntry).toHaveAttribute('data-muted', 'false');
    await expectHearing(alice.page, bob.id, 'Bob');
    // The beep is intermittent, so the ring comes and goes: sample often until it is seen once.
    await expect
      .poll(() => bobEntry.getAttribute('data-speaking'), {
        message: 'Bob’s data-speaking as Alice sees it',
        timeout: VOICE_MEDIA_TIMEOUT,
        intervals: [100],
      })
      .toBe('true');
  });

  test('5. switching channels: Alice moves Lounge → Games; listed only under Games; one panel', async ({
    users,
  }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    await createVoiceChannel(alice.request, 'Lounge');
    const games = await createVoiceChannel(alice.request, 'Games');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    for (const user of [alice, bob, carol]) await expectListed(user.page, 'Lounge', [alice.id, bob.id]);

    await trackVoicePanels(alice.page);
    await joinVoice(alice.page, 'Games');

    for (const user of [alice, bob, carol]) {
      await expectListed(user.page, 'Games', [alice.id]);
      await expectListed(user.page, 'Lounge', [bob.id]);
      await expect(voiceParticipant(user.page, alice.id)).toHaveCount(1);
    }
    await expect(voicePanel(alice.page)).toHaveCount(1);
    expect(await maxVoicePanels(alice.page), 'voice-panels in the DOM at once').toBe(1);

    const debug = await voiceDebug(alice.page);
    expect(debug.state).toBe('connected');
    expect(debug.roomName).toBe(`voice_${games.id}`);
    expect(debug.remotes.map((r) => r.identity)).not.toContain(bob.id);
    // Bob's room no longer has Alice in it.
    await expect
      .poll(async () => (await voiceDebug(bob.page)).remotes.map((r) => r.identity), {
        message: 'Bob’s remotes',
        timeout: VOICE_MEDIA_TIMEOUT,
      })
      .not.toContain(alice.id);
  });

  test('6. resilience: Bob reloads, the others see him leave, and he rejoins', async ({ users }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    const lounge = await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expectHearing(alice.page, bob.id, 'Bob');

    await bob.page.reload();
    await expectConnected(bob.page);
    // A reload leaves voice: no panel, and the others see him go (webhook or the 5 s reconcile).
    await expect(voicePanel(bob.page)).toHaveCount(0);
    for (const page of [alice.page, carol.page, bob.page]) await expectListed(page, 'Lounge', [alice.id]);
    await expect
      .poll(async () => (await voiceDebug(alice.page)).remotes.map((r) => r.identity), {
        message: 'Alice’s remotes',
        timeout: VOICE_MEDIA_TIMEOUT,
      })
      .not.toContain(bob.id);
    expect(await hearthEvents(alice.page)).toContainEqual({ event: 'voice:left', channelId: lounge.id });

    await joinVoice(bob.page, 'Lounge');
    for (const page of [alice.page, carol.page, bob.page]) {
      await expectListed(page, 'Lounge', [alice.id, bob.id]);
    }
    await expectHearing(alice.page, bob.id, 'Bob');
    await expectHearing(bob.page, alice.id, 'Alice');
  });
});
