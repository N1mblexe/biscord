import type { Locator, Page } from '@playwright/test';
import {
  createVoiceChannel,
  displayMediaCalls,
  expect,
  expectConnected,
  expectNoVideo,
  expectVideo,
  forceDisplayMediaReject,
  joinVoice,
  NEEDS_TEST_MODE,
  test,
  videoTiles,
  voiceDebug,
  voiceParticipant,
  voiceParticipantIds,
  voicePanel,
  VOICE_MEDIA_TIMEOUT,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Selectors and debug hook: docs/plans/phase-7.md "Web UI contract" and "Key decisions → Debug hook".
// Rules: CONTRACTS B.6b (camera/screen flags are cosmetic; the reconcile clears stale ones) and B.6a.
// Media runs through the real LiveKit container with Chromium's fake camera and fake "Entire screen"
// capture (headless works with the CLAUDE.md flags, per the Phase 7 spike). Every media assertion
// polls; nothing sleeps.

const SCREEN_SHARE_FAILED = 'Screen share was cancelled or blocked';

/**
 * Scenario 5: after a crash the badge clears with `voice:left`, which comes from LiveKit's
 * `participant_left` webhook only after its departure timeout (`room.departure_timeout`, default
 * 20 s: LiveKit keeps an abruptly closed participant that long in case it reconnects). Until then
 * LiveKit still lists the participant and its screen track, so the reconcile (5 s in e2e,
 * VOICE_RECONCILE_MS) rightly keeps the flag and can't clear it earlier. 20 s plus the webhook, the
 * reconcile tick and slack.
 */
const STALE_BADGE_CLEARED_WITHIN = 45_000;

function panelButton(page: Page, name: string): Locator {
  return voicePanel(page).getByRole('button', { name, exact: true });
}

/** Loads the app and waits for a live socket. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expectConnected(page);
}

/** Presses `from` in the voice panel and waits for it to become `to` with `aria-pressed=pressed`. */
async function toggle(page: Page, from: string, to: string, pressed: boolean): Promise<void> {
  await panelButton(page, from).click();
  await expect(panelButton(page, to)).toHaveAttribute('aria-pressed', String(pressed), {
    timeout: VOICE_MEDIA_TIMEOUT,
  });
  await expect(panelButton(page, from)).toHaveCount(0);
}

/** Polls `page`'s own `local` publish state in the debug hook. */
async function expectLocal(page: Page, local: { camera: boolean; screen: boolean }): Promise<void> {
  await expect
    .poll(async () => (await voiceDebug(page)).local, {
      message: 'local camera/screen publish state',
      timeout: VOICE_MEDIA_TIMEOUT,
    })
    .toEqual(local);
}

/** `userId`'s sidebar camera flag as `observer` sees it (`data-camera="true"` when on). */
async function expectCameraFlag(observer: Page, userId: string, on: boolean): Promise<void> {
  const entry = voiceParticipant(observer, userId);
  if (on) await expect(entry).toHaveAttribute('data-camera', 'true');
  else await expect(entry).not.toHaveAttribute('data-camera', 'true');
}

/** `userId`'s sidebar LIVE badge as `observer` sees it (`data-live="screen"`, text "LIVE"). */
async function expectLiveBadge(observer: Page, userId: string, on: boolean): Promise<void> {
  const entry = voiceParticipant(observer, userId);
  if (on) {
    await expect(entry).toHaveAttribute('data-live', 'screen');
    await expect(entry).toContainText('LIVE');
  } else {
    await expect(entry).not.toHaveAttribute('data-live', 'screen');
    await expect(entry).not.toContainText('LIVE');
  }
}

test.describe('video', { tag: '@video' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);
  // Several LiveKit connects, publishes and media polls per test (each bounded by VOICE_MEDIA_TIMEOUT).
  test.describe.configure({ timeout: 120_000 });

  test('1. camera: Bob plays Alice’s camera; Carol, outside, sees data-camera; Stop camera clears both', async ({
    users,
  }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expect(voiceParticipant(carol.page, alice.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(voicePanel(carol.page)).toHaveCount(0);
    await expectCameraFlag(carol.page, alice.id, false);

    await expect(panelButton(alice.page, 'Camera')).toHaveAttribute('aria-pressed', 'false');
    await toggle(alice.page, 'Camera', 'Stop camera', true);
    await expectLocal(alice.page, { camera: true, screen: false });

    await expectVideo(bob.page, alice.id, 'camera', 'Alice');
    const tile = videoTiles(bob.page, { userId: alice.id, source: 'camera' });
    await expect(tile).toContainText('Alice');
    await expect(tile).not.toContainText('(screen)');
    await expect(videoTiles(bob.page, { userId: alice.id, source: 'screen_share' })).toHaveCount(0);
    await expectCameraFlag(carol.page, alice.id, true);
    await expectCameraFlag(bob.page, alice.id, true);
    // A camera is not a screen share: no LIVE badge.
    await expectLiveBadge(carol.page, alice.id, false);

    await toggle(alice.page, 'Stop camera', 'Camera', false);
    await expectLocal(alice.page, { camera: false, screen: false });
    await expectNoVideo(bob.page, alice.id, 'camera', 'Alice');
    await expectCameraFlag(carol.page, alice.id, false);
    await expectCameraFlag(bob.page, alice.id, false);
    // Stopping the camera does not leave voice.
    await expect(voiceParticipant(carol.page, alice.id)).toHaveCount(1);
  });

  test('2. screen share: Bob gets an auto-focused screen tile; Carol sees LIVE; Stop sharing clears both', async ({
    users,
  }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expect(voiceParticipant(carol.page, alice.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
    await expectLiveBadge(carol.page, alice.id, false);

    await expect(voicePanel(alice.page).getByRole('checkbox', { name: 'Share tab audio' })).toBeChecked();
    await expect(panelButton(alice.page, 'Share screen')).toHaveAttribute('aria-pressed', 'false');
    await toggle(alice.page, 'Share screen', 'Stop sharing', true);
    await expectLocal(alice.page, { camera: false, screen: true });

    await expectVideo(bob.page, alice.id, 'screen_share', 'Alice');
    const tile = videoTiles(bob.page, { userId: alice.id, source: 'screen_share' });
    await expect(tile).toContainText('Alice (screen)');
    // Bob pinned nothing, so the new screen share takes the focus.
    await expect(tile).toHaveAttribute('data-focused', 'true');
    await expect(videoTiles(bob.page).and(bob.page.locator('[data-focused="true"]'))).toHaveCount(1);
    await expectLiveBadge(carol.page, alice.id, true);
    await expectLiveBadge(bob.page, alice.id, true);
    // A screen share is not a camera.
    await expectCameraFlag(carol.page, alice.id, false);

    await toggle(alice.page, 'Stop sharing', 'Share screen', false);
    await expectLocal(alice.page, { camera: false, screen: false });
    await expectNoVideo(bob.page, alice.id, 'screen_share', 'Alice');
    await expectLiveBadge(carol.page, alice.id, false);
    await expectLiveBadge(bob.page, alice.id, false);
    await expect(voiceParticipant(carol.page, alice.id)).toHaveCount(1);
  });

  test('3. camera and screen at once: Bob pins the camera tile, and the pin survives Stop sharing', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, bob]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');

    await toggle(alice.page, 'Camera', 'Stop camera', true);
    await expectVideo(bob.page, alice.id, 'camera', 'Alice');
    await toggle(alice.page, 'Share screen', 'Stop sharing', true);
    await expectLocal(alice.page, { camera: true, screen: true });
    await expectVideo(bob.page, alice.id, 'screen_share', 'Alice');
    await expectVideo(bob.page, alice.id, 'camera', 'Alice');
    // Both buttons stay pressed together.
    await expect(panelButton(alice.page, 'Stop camera')).toHaveAttribute('aria-pressed', 'true');
    await expect(panelButton(alice.page, 'Stop sharing')).toHaveAttribute('aria-pressed', 'true');

    const camera = videoTiles(bob.page, { userId: alice.id, source: 'camera' });
    const screen = videoTiles(bob.page, { userId: alice.id, source: 'screen_share' });
    const focused = videoTiles(bob.page).and(bob.page.locator('[data-focused="true"]'));
    // The screen share started last and Bob had pinned nothing: it is focused.
    await expect(screen).toHaveAttribute('data-focused', 'true');
    await expect(focused).toHaveCount(1);

    await camera.click();
    await expect(camera).toHaveAttribute('data-focused', 'true');
    await expect(screen).not.toHaveAttribute('data-focused', 'true');
    await expect(focused).toHaveCount(1);

    await toggle(alice.page, 'Stop sharing', 'Share screen', false);
    await expectLocal(alice.page, { camera: true, screen: false });
    await expectNoVideo(bob.page, alice.id, 'screen_share', 'Alice');
    // Bob's pin is kept, and the camera still plays.
    await expect(camera).toHaveAttribute('data-focused', 'true');
    await expect(focused).toHaveCount(1);
    await expectVideo(bob.page, alice.id, 'camera', 'Alice');
    await expect(panelButton(alice.page, 'Stop camera')).toHaveAttribute('aria-pressed', 'true');
  });

  test('4. cancelled or denied picker: alert shown, button stays Share screen, nothing published', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createVoiceChannel(alice.request, 'Lounge');
    // Before the app loads: every getDisplayMedia in Alice's context rejects with NotAllowedError.
    await forceDisplayMediaReject(alice.context);
    for (const user of [alice, bob]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');
    await expect(alice.page.getByRole('alert')).toHaveCount(0);

    await panelButton(alice.page, 'Share screen').click();

    const alert = alice.page.getByRole('alert');
    await expect(alert).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(alert).toContainText(SCREEN_SHARE_FAILED);
    expect(await displayMediaCalls(alice.page), 'getDisplayMedia calls').toBeGreaterThanOrEqual(1);
    // The state stays consistent: not sharing, still connected, no LIVE badge anywhere.
    await expect(panelButton(alice.page, 'Share screen')).toHaveAttribute('aria-pressed', 'false');
    await expect(panelButton(alice.page, 'Stop sharing')).toHaveCount(0);
    await expect(voicePanel(alice.page)).toHaveAttribute('data-state', 'connected');
    await expectLocal(alice.page, { camera: false, screen: false });
    await expectLiveBadge(alice.page, alice.id, false);
    await expectLiveBadge(bob.page, alice.id, false);
    await expect(videoTiles(bob.page, { userId: alice.id })).toHaveCount(0);
  });

  test('4b. one alert per page: a media error on Settings shares the form alert slot', async ({ users }) => {
    const { alice } = await users(['alice']);
    await createVoiceChannel(alice.request, 'Lounge');
    await forceDisplayMediaReject(alice.context);
    await openApp(alice.page);
    await joinVoice(alice.page, 'Lounge');
    await alice.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(alice.page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    // A form error first (a blank display name is refused by the server)…
    await alice.page.getByLabel('Display name').fill(' ');
    await alice.page.getByRole('button', { name: 'Save profile' }).click();
    const alerts = alice.page.getByRole('alert');
    await expect(alerts).toHaveCount(1);
    await expect(alerts).not.toContainText(SCREEN_SHARE_FAILED);

    // …then a screen share error: still one alert, now the newer message.
    await panelButton(alice.page, 'Share screen').click();
    await expect(alerts).toContainText(SCREEN_SHARE_FAILED, { timeout: VOICE_MEDIA_TIMEOUT });
    await expect(alerts).toHaveCount(1);

    // Moving to another page leaves the media error behind.
    await alice.page.getByRole('link', { name: 'Admin', exact: true }).click();
    await expect(alice.page.getByRole('heading', { name: 'Invites', exact: true, level: 1 })).toBeVisible();
    await expect(alerts).toHaveCount(0);
  });

  test('5. stale flag after a crash: Alice’s context closes while sharing, Carol’s LIVE badge clears', async ({
    users,
  }) => {
    const { alice, carol } = await users(['alice', 'carol']);
    await createVoiceChannel(alice.request, 'Lounge');
    for (const user of [alice, carol]) await openApp(user.page);
    await joinVoice(alice.page, 'Lounge');
    await toggle(alice.page, 'Share screen', 'Stop sharing', true);
    await expectLocal(alice.page, { camera: false, screen: true });
    await expectLiveBadge(carol.page, alice.id, true);

    // A crash, not a Leave: no voice:state, no LiveKit disconnect message from the app. (The users
    // fixture closes it again on teardown, which is a no-op.)
    await alice.context.close();

    // Cleared through voice:left after LiveKit's departure timeout (see STALE_BADGE_CLEARED_WITHIN).
    await expect(
      voiceParticipant(carol.page, alice.id).and(carol.page.locator('[data-live="screen"]')),
    ).toHaveCount(0, { timeout: STALE_BADGE_CLEARED_WITHIN });
    await expect
      .poll(() => voiceParticipantIds(carol.page, 'Lounge'), {
        message: 'voice participants under Lounge',
        timeout: VOICE_MEDIA_TIMEOUT,
      })
      .toEqual([]);
  });
});
