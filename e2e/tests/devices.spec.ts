import type { Locator, Page } from '@playwright/test';
import {
  changeVoicePrefs,
  createChannel,
  createVoiceChannel,
  expect,
  expectConnected,
  expectHearing,
  gotoChannel,
  joinVoice,
  mediaDevices,
  NEEDS_TEST_MODE,
  seedVoicePrefs,
  test,
  voiceDebug,
  voiceParticipant,
  voicePanel,
  VOICE_MEDIA_TIMEOUT,
  VOICE_PREFS_KEY,
  type MediaDeviceView,
  type TestUser,
  type VoiceDebug,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Voice and video devices (docs/plans/devices.md "Verification → e2e" and "UI contract", CONTRACTS
// B.12). Scenarios 1–6 are engine-level: they drive the prefs directly (localStorage
// `hearth:voice-prefs`), seeded before the app loads or changed live with the `storage` event another
// tab would send. Scenarios 7–10 go through Settings and the voice panel. Media runs through the real LiveKit container with Chromium's fake devices (several
// fake mics and outputs, a fake camera, a mic that beeps periodically). Every assertion polls;
// nothing sleeps.

const MESSAGE_BOX = { name: 'Message', exact: true } as const;

/** How many consecutive samples (`STAY_INTERVAL_MS` apart) a "stays" check needs: ~2.5 s, past several beeps. */
const STAY_SAMPLES = 10;
const STAY_INTERVAL_MS = 250;

function panelButton(page: Page, name: string): Locator {
  return voicePanel(page).getByRole('button', { name, exact: true });
}

/** Loads the app and waits for a live socket. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expectConnected(page);
}

/** Polls one value derived from `page`'s voice debug report. */
function pollDebug<T>(page: Page, pick: (d: VoiceDebug) => T, message: string) {
  return expect.poll(async () => pick(await voiceDebug(page)), { message, timeout: VOICE_MEDIA_TIMEOUT });
}

/**
 * Asserts that `read()` equals `expected` on `STAY_SAMPLES` consecutive samples. A single different
 * sample fails the check (it never recovers), so a transient blip is caught, not averaged away.
 */
async function expectStays<T>(read: () => Promise<T>, expected: T, message: string): Promise<void> {
  let seen = 0;
  let violation: string | null = null;
  await expect
    .poll(
      async () => {
        if (violation !== null) return violation;
        const value = await read();
        if (JSON.stringify(value) !== JSON.stringify(expected)) {
          violation = `changed to ${JSON.stringify(value)} after ${seen} samples`;
          return violation;
        }
        seen += 1;
        return seen >= STAY_SAMPLES ? 'stayed' : `${seen} samples so far`;
      },
      {
        message: `${message} stays ${JSON.stringify(expected)}`,
        timeout: STAY_SAMPLES * STAY_INTERVAL_MS + VOICE_MEDIA_TIMEOUT,
        intervals: [STAY_INTERVAL_MS],
      },
    )
    .toBe('stayed');
}

/** `who`'s mic as `observer` receives it: `remoteMicMuted` of that remote (`null` until it is listed). */
async function remoteMicMuted(observer: Page, userId: string): Promise<boolean | null> {
  const remote = (await voiceDebug(observer)).remotes.find((r) => r.identity === userId);
  return remote?.remoteMicMuted ?? null;
}

/** `userId`'s sidebar `data-speaking` as `observer` sees it, polled until it is `"true"`. */
async function expectSeenSpeaking(observer: Page, userId: string, who: string): Promise<void> {
  // The fake mic beeps intermittently, so the ring comes and goes: sample often until seen once.
  await expect
    .poll(() => voiceParticipant(observer, userId).getAttribute('data-speaking'), {
      message: `${who}'s data-speaking`,
      timeout: VOICE_MEDIA_TIMEOUT,
      intervals: [100],
    })
    .toBe('true');
}

/** Real (non-`default`, non-`communications`) devices of `kind`, as the page enumerates them. */
async function realDevices(page: Page, kind: MediaDeviceView['kind']): Promise<MediaDeviceView[]> {
  return (await mediaDevices(page)).filter(
    (d) =>
      d.kind === kind && d.deviceId !== '' && d.deviceId !== 'default' && d.deviceId !== 'communications',
  );
}

/** The voice prefs as stored in `page`'s localStorage, or `null` when none are. */
async function storedPrefs(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(
    (key) =>
      (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(
        key,
      ),
    VOICE_PREFS_KEY,
  );
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`stored voice prefs: ${raw}`);
  return parsed as Record<string, unknown>;
}

/**
 * Polls until the debug hook's `transmitting` is `on`, then checks that the voice panel's
 * `data-transmitting` says the same.
 */
async function expectPanelTransmitting(page: Page, on: boolean): Promise<void> {
  await pollDebug(page, (d) => d.transmitting, 'transmitting').toBe(on);
  await expect(voicePanel(page)).toHaveAttribute('data-transmitting', String(on));
}

/**
 * Alice and Bob in the voice channel Lounge. Alice's `prefs` are seeded before the app loads;
 * `beforeJoin` runs on her loaded page before she joins.
 */
async function aliceAndBobInLounge(
  users: (names: readonly ['alice', 'bob']) => Promise<Record<'alice' | 'bob', TestUser>>,
  opts: { prefs?: Parameters<typeof seedVoicePrefs>[1]; beforeJoin?: (page: Page) => Promise<void> } = {},
): Promise<{ alice: TestUser; bob: TestUser }> {
  const { alice, bob } = await users(['alice', 'bob']);
  if (opts.prefs !== undefined) await seedVoicePrefs(alice.context, opts.prefs);
  await createVoiceChannel(alice.request, 'Lounge');
  await openApp(alice.page);
  await openApp(bob.page);
  await opts.beforeJoin?.(alice.page);
  await joinVoice(alice.page, 'Lounge');
  await joinVoice(bob.page, 'Lounge');
  await expect(voiceParticipant(bob.page, alice.id)).toHaveCount(1, { timeout: VOICE_MEDIA_TIMEOUT });
  return { alice, bob };
}

test.describe('devices', { tag: '@voice' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);
  // Several LiveKit connects, publishes and media polls per test (each bounded by VOICE_MEDIA_TIMEOUT).
  test.describe.configure({ timeout: 120_000 });

  test('1. mic switch: the chosen fake mic is used on join and switching mid-call changes localMic.deviceId; Bob still hears Alice', async ({
    users,
  }) => {
    // Device ids are salted per browser context, so Alice's are discovered in her own page.
    let mics: MediaDeviceView[] = [];
    const { alice, bob } = await aliceAndBobInLounge(users, {
      beforeJoin: async (page) => {
        mics = await realDevices(page, 'audioinput');
        const first = mics[0];
        if (first !== undefined) await changeVoicePrefs(page, { audioInputId: first.deviceId });
      },
    });
    const [first, target] = mics;
    expect(target, `two fake mics besides the default (have ${JSON.stringify(mics)})`).toBeDefined();
    if (first === undefined || target === undefined) return;

    // Chosen before joining: the first publish captures it.
    await pollDebug(alice.page, (d) => d.localMic?.deviceId ?? null, 'Alice’s mic device on join').toBe(
      first.deviceId,
    );
    await expectHearing(bob.page, alice.id, 'Alice');

    await changeVoicePrefs(alice.page, { audioInputId: target.deviceId });
    await pollDebug(alice.page, (d) => d.localMic?.deviceId ?? null, 'Alice’s mic device').toBe(
      target.deviceId,
    );
    // Still voice activity with no gate: the switched mic transmits.
    await pollDebug(alice.page, (d) => [d.transmitting, d.localMic?.muted], 'Alice transmits').toEqual([
      true,
      false,
    ]);
    await expectHearing(bob.page, alice.id, 'Alice');
    await expect(voiceParticipant(bob.page, alice.id)).toHaveAttribute('data-muted', 'false');
  });

  test('2. output switch: choosing another fake output changes audioSinkId', async ({ users }) => {
    const { alice, bob } = await aliceAndBobInLounge(users);
    // Bob's audio plays through an element in Alice's page, on the system default ('').
    await expectHearing(alice.page, bob.id, 'Bob');
    await pollDebug(alice.page, (d) => d.audioSinkId, 'Alice’s output').toBe('');

    const outputs = await realDevices(alice.page, 'audiooutput');
    const target = outputs[0];
    expect(target, `a fake output device (have ${JSON.stringify(outputs)})`).toBeDefined();
    if (target === undefined) return;

    await changeVoicePrefs(alice.page, { audioOutputId: target.deviceId });
    await pollDebug(alice.page, (d) => d.audioSinkId, 'Alice’s output').toBe(target.deviceId);
    await expectHearing(alice.page, bob.id, 'Bob');

    // Back to the system default.
    await changeVoicePrefs(alice.page, { audioOutputId: 'default' });
    await pollDebug(alice.page, (d) => d.audioSinkId, 'Alice’s output').not.toBe(target.deviceId);
  });

  test('3. push-to-talk: silent until Backquote is held, closes after the release delay, ignores typing; never "muted"', async ({
    users,
  }) => {
    const RELEASE_MS = 600;
    const { alice, bob } = await users(['alice', 'bob']);
    await seedVoicePrefs(alice.context, { inputMode: 'ptt', pttReleaseMs: RELEASE_MS });
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await openApp(bob.page);
    await gotoChannel(alice.page, 'general');
    await joinVoice(alice.page, 'Lounge');
    await joinVoice(bob.page, 'Lounge');

    const aliceSeenByBob = voiceParticipant(bob.page, alice.id);
    const aliceSeenByAlice = voiceParticipant(alice.page, alice.id);
    // PTT is local (B.12 rule 2): the user's own mute flag never changes.
    const expectNotMuted = async () => {
      await expect(aliceSeenByBob).toHaveAttribute('data-muted', 'false');
      await expect(aliceSeenByAlice).toHaveAttribute('data-muted', 'false');
    };
    const aliceGate = (d: VoiceDebug) => ({
      transmitting: d.transmitting,
      pttActive: d.pttActive,
      micMuted: d.localMic?.muted ?? null,
    });
    const closed = { transmitting: false, pttActive: false, micMuted: true };
    const open = { transmitting: true, pttActive: true, micMuted: false };

    // After joining: published but gated; Bob sees a muted mic and no speaking ring.
    await pollDebug(alice.page, aliceGate, 'Alice’s gate after joining').toEqual(closed);
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(true);
    await expectNotMuted();
    await expectStays(
      async () => (await aliceSeenByBob.getAttribute('data-speaking')) === 'true',
      false,
      'Alice speaking (gated) as Bob sees it',
    );

    // Hold the key (focus is on the voice channel button, not a text field).
    await alice.page.keyboard.down('Backquote');
    await pollDebug(alice.page, aliceGate, 'Alice’s gate while holding `').toEqual(open);
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(false);
    await expectSeenSpeaking(bob.page, alice.id, 'Alice');
    await expectHearing(bob.page, alice.id, 'Alice');
    await expectNotMuted();

    // Release: still open during the delay, closed after it.
    const releasedAt = Date.now();
    await alice.page.keyboard.up('Backquote');
    await pollDebug(alice.page, (d) => d.pttActive, 'Alice’s pttActive after release').toBe(false);
    expect(Date.now() - releasedAt, 'pttActive stayed on for the release delay').toBeGreaterThanOrEqual(
      RELEASE_MS,
    );
    await pollDebug(alice.page, aliceGate, 'Alice’s gate after release').toEqual(closed);
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(true);
    await expectNotMuted();

    // Typing ` in the composer types it and never transmits.
    const composer = alice.page.getByRole('textbox', MESSAGE_BOX);
    await composer.click();
    await alice.page.keyboard.down('Backquote');
    await expect(composer).toHaveValue('`');
    expect(aliceGate(await voiceDebug(alice.page)), 'Alice’s gate while typing `').toEqual(closed);
    await expectStays(
      async () => aliceGate(await voiceDebug(alice.page)),
      closed,
      'Alice’s gate while typing `',
    );
    await alice.page.keyboard.up('Backquote');
    await expectNotMuted();
  });

  test('4. voice activity: with the gate on, 0 dB never transmits and −100 dB always does', async ({
    users,
  }) => {
    const { alice, bob } = await aliceAndBobInLounge(users, { prefs: { vadGate: true, vadThresholdDb: 0 } });
    const aliceGate = async () => {
      const d = await voiceDebug(alice.page);
      return { transmitting: d.transmitting, micMuted: d.localMic?.muted ?? null };
    };
    const closed = { transmitting: false, micMuted: true };

    await pollDebug(alice.page, (d) => d.localMic !== null, 'Alice publishes a mic').toBe(true);
    await expectStays(aliceGate, closed, 'Alice’s gate at 0 dB');
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(true);

    await changeVoicePrefs(alice.page, { vadThresholdDb: -100 });
    await expect
      .poll(aliceGate, { message: 'Alice’s gate at −100 dB', timeout: VOICE_MEDIA_TIMEOUT })
      .toEqual({ transmitting: true, micMuted: false });
    await expectHearing(bob.page, alice.id, 'Alice');
    await expectStays(aliceGate, { transmitting: true, micMuted: false }, 'Alice’s gate at −100 dB');

    await changeVoicePrefs(alice.page, { vadThresholdDb: 0 });
    await expect
      .poll(aliceGate, { message: 'Alice’s gate back at 0 dB', timeout: VOICE_MEDIA_TIMEOUT })
      .toEqual(closed);
    await expectStays(aliceGate, closed, 'Alice’s gate back at 0 dB');
    await expect(voiceParticipant(bob.page, alice.id)).toHaveAttribute('data-muted', 'false');
  });

  test('5. camera quality: 360p captures narrower than 720p (switched live)', async ({ users }) => {
    const { alice } = await users(['alice']);
    await seedVoicePrefs(alice.context, { cameraQuality: '360p' });
    await createVoiceChannel(alice.request, 'Lounge');
    await openApp(alice.page);
    await joinVoice(alice.page, 'Lounge');

    await panelButton(alice.page, 'Camera').click();
    await expect(panelButton(alice.page, 'Stop camera')).toBeVisible({ timeout: VOICE_MEDIA_TIMEOUT });
    await pollDebug(alice.page, (d) => d.camera?.width ?? 0, 'Alice’s camera width at 360p').toBeGreaterThan(
      0,
    );
    const width360 = (await voiceDebug(alice.page)).camera?.width ?? 0;
    expect(width360, 'camera width at 360p').toBeLessThanOrEqual(640);

    await changeVoicePrefs(alice.page, { cameraQuality: '720p' });
    await pollDebug(alice.page, (d) => d.camera?.width ?? 0, 'Alice’s camera width at 720p').toBeGreaterThan(
      width360,
    );
    const width720 = (await voiceDebug(alice.page)).camera?.width ?? 0;
    expect(width720, 'camera width at 720p').toBeLessThanOrEqual(1280);
  });

  test('6. defaults: with no prefs stored Alice always transmits, ` does nothing, and the camera is 720p', async ({
    users,
  }) => {
    const { alice, bob } = await aliceAndBobInLounge(users);
    expect(await storedPrefs(alice.page), 'no voice prefs stored').toBeNull();

    await pollDebug(
      alice.page,
      (d) => [d.transmitting, d.pttActive, d.localMic?.muted],
      'Alice transmits',
    ).toEqual([true, false, false]);
    await expectPanelTransmitting(alice.page, true);
    await expect(alice.page.getByTestId('ptt-button')).toHaveCount(0);
    await expectHearing(bob.page, alice.id, 'Alice');
    await expectSeenSpeaking(bob.page, alice.id, 'Alice');
    const mic = (await voiceDebug(alice.page)).localMic;
    // Browser processing on, as before (B.12 rule 1 defaults).
    expect(mic?.constraints, 'Alice’s mic constraints').toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    // The PTT key is inert in voice-activity mode.
    await alice.page.keyboard.down('Backquote');
    expect((await voiceDebug(alice.page)).pttActive, 'pttActive in voice mode').toBe(false);
    await alice.page.keyboard.up('Backquote');
    await expectStays(async () => (await voiceDebug(alice.page)).transmitting, true, 'Alice transmitting');

    await panelButton(alice.page, 'Camera').click();
    await expect(panelButton(alice.page, 'Stop camera')).toBeVisible({ timeout: VOICE_MEDIA_TIMEOUT });
    await pollDebug(alice.page, (d) => d.camera?.width ?? 0, 'Alice’s camera width').toBe(1280);
  });

  // ---- UI scenarios (docs/plans/devices.md "UI contract") ----

  test('7. Settings lists the fake devices; the mic test meter rises; the camera preview plays; a choice is saved', async ({
    users,
  }) => {
    const { alice } = await users(['alice']);
    const page = alice.page;
    await page.goto('/settings#voice');
    await expectConnected(page);
    await expect(page.getByTestId('settings-voice-heading')).toHaveText('Voice & video');
    // The context already has the mic/camera permission, so labels are visible: no Allow access.
    await expect(page.getByTestId('device-access')).toHaveCount(0);

    const micSelect = page.getByTestId('mic-select');
    await expect(micSelect).toContainText('Fake Audio Input 1');
    await expect(micSelect).toContainText('Fake Audio Input 2');
    await expect(page.getByTestId('speaker-select')).toContainText('Fake Audio Output 1');
    await expect(page.getByTestId('camera-select')).toContainText('fake_device_0');

    // Choosing a mic saves it (B.12 rule 1).
    const mic = (await realDevices(page, 'audioinput'))[1];
    expect(mic, 'a second fake mic').toBeDefined();
    if (mic === undefined) return;
    await micSelect.selectOption(mic.deviceId);
    await expect.poll(async () => (await storedPrefs(page))?.audioInputId).toBe(mic.deviceId);

    // Mic test: the level leaves the floor (the fake mic beeps).
    const meterToggle = page.getByTestId('mic-meter-toggle');
    await expect(meterToggle).toHaveText('Test microphone');
    await meterToggle.click();
    await expect(meterToggle).toHaveText('Stop testing');
    await expect
      .poll(async () => Number(await page.getByTestId('mic-level').getAttribute('data-level')), {
        message: 'mic-level data-level',
        timeout: VOICE_MEDIA_TIMEOUT,
        intervals: [100],
      })
      .toBeGreaterThan(-100);
    await meterToggle.click();
    await expect(meterToggle).toHaveText('Test microphone');

    // Camera preview: the <video> gets frames.
    const previewToggle = page.getByTestId('camera-preview-toggle');
    await expect(previewToggle).toHaveText('Preview camera');
    await previewToggle.click();
    await expect(previewToggle).toHaveText('Stop preview');
    await expect
      .poll(
        () =>
          page
            .getByTestId('camera-preview')
            .evaluate((el) => (el as unknown as { videoWidth: number }).videoWidth),
        { message: 'camera-preview videoWidth', timeout: VOICE_MEDIA_TIMEOUT },
      )
      .toBeGreaterThan(0);
    await previewToggle.click();
    await expect(previewToggle).toHaveText('Preview camera');
  });

  test('8. Settings keys: Push to talk with a recorded F8 key is saved and drives push-to-talk in a call', async ({
    users,
  }) => {
    const { alice } = await users(['alice']);
    await createVoiceChannel(alice.request, 'Lounge');
    const page = alice.page;
    await page.goto('/settings#voice');
    await expectConnected(page);

    await page.getByTestId('input-mode-ptt').check();
    await expect(page.getByTestId('input-mode-ptt')).toBeChecked();
    const pttKey = page.getByTestId('ptt-key');
    await expect(pttKey).toHaveText('Push-to-talk key: `');
    await pttKey.click();
    await expect(pttKey).toHaveText('Press a key… (Esc to cancel)');
    await page.keyboard.press('F8');
    await expect(pttKey).toHaveText('Push-to-talk key: F8');
    await expect(page.getByTestId('mute-key')).toHaveText('Toggle mute shortcut: Not set');
    await expect
      .poll(async () => {
        const prefs = await storedPrefs(page);
        return prefs === null ? null : { inputMode: prefs.inputMode, pttKey: prefs.pttKey };
      })
      .toEqual({ inputMode: 'ptt', pttKey: { type: 'key', code: 'F8' } });

    // The saved key works in a call (a fresh load reads it from storage).
    await page.goto('/');
    await expectConnected(page);
    await joinVoice(page, 'Lounge');
    await expect(page.getByTestId('ptt-hint')).toContainText('F8');
    await pollDebug(page, (d) => d.transmitting, 'transmitting before F8').toBe(false);
    await page.keyboard.down('Backquote');
    expect((await voiceDebug(page)).pttActive, 'the old key does nothing').toBe(false);
    await page.keyboard.up('Backquote');
    await page.keyboard.down('F8');
    await expectPanelTransmitting(page, true);
    await page.keyboard.up('F8');
    await expectPanelTransmitting(page, false);
  });

  test('9. quick menu: picking a mic in Audio options switches the call’s mic; Escape returns focus to ▾', async ({
    users,
  }) => {
    const { alice, bob } = await aliceAndBobInLounge(users);
    await expectHearing(bob.page, alice.id, 'Alice');
    const page = alice.page;
    const before = (await voiceDebug(page)).localMic?.deviceId ?? null;

    const trigger = voicePanel(page).getByTestId('audio-options');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByTestId('audio-options-menu');
    await expect(menu).toBeVisible();

    const mics = menu.getByTestId('menu-mic').getByRole('menuitemradio');
    await expect(mics.filter({ hasText: 'Fake Audio Input 2' })).toHaveCount(1);
    const item = mics.filter({ hasText: 'Fake Audio Input 2' });
    const value = await item.getAttribute('data-value');
    expect(value, 'the item’s data-value is a device id').not.toBeNull();
    expect(value).not.toBe('default');
    expect(value).not.toBe(before);
    await item.click();
    await expect(item).toHaveAttribute('aria-checked', 'true');
    // Choosing keeps the menu open.
    await expect(menu).toBeVisible();

    await pollDebug(page, (d) => d.localMic?.deviceId ?? null, 'Alice’s mic device').toBe(value);
    expect(page.url(), 'Settings was not opened').not.toContain('/settings');
    await expectHearing(bob.page, alice.id, 'Alice');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('10. PTT hold button: pointer down transmits, pointer up stops after the release delay; panel mirrors it', async ({
    users,
  }) => {
    const RELEASE_MS = 500;
    const { alice, bob } = await aliceAndBobInLounge(users, {
      prefs: { inputMode: 'ptt', pttReleaseMs: RELEASE_MS },
    });
    const page = alice.page;
    const button = page.getByTestId('ptt-button');
    await expect(button).toHaveText(/Push to talk/);
    await expect(page.getByTestId('ptt-hint')).toHaveText('Hold ` to talk');
    await expectPanelTransmitting(page, false);
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await button.hover();
    await page.mouse.down();
    await expectPanelTransmitting(page, true);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(false);

    const releasedAt = Date.now();
    await page.mouse.up();
    await expectPanelTransmitting(page, false);
    expect(Date.now() - releasedAt, 'held for the release delay').toBeGreaterThanOrEqual(RELEASE_MS);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => remoteMicMuted(bob.page, alice.id), { timeout: VOICE_MEDIA_TIMEOUT }).toBe(true);
    await expect(voiceParticipant(bob.page, alice.id)).toHaveAttribute('data-muted', 'false');

    // Muting: the panel and the debug hook agree on not transmitting, even while held.
    await panelButton(page, 'Mute').click();
    await page.mouse.move(0, 0);
    await button.hover();
    await page.mouse.down();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expectPanelTransmitting(page, false);
    await expectStays(
      async () => (await voiceDebug(page)).transmitting,
      false,
      'Alice transmitting (muted, PTT held)',
    );
    await page.mouse.up();
  });
});
