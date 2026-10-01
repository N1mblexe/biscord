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
  type MediaDeviceView,
  type TestUser,
  type VoiceDebug,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Engine-level scenarios for voice and video devices (docs/plans/devices.md "Verification → e2e",
// CONTRACTS B.12). They drive the prefs directly (localStorage `hearth:voice-prefs`) rather than the
// Settings UI: seeded before the app loads, or changed live with the `storage` event another tab
// would send. Media runs through the real LiveKit container with Chromium's fake devices (several
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
    expect(
      await alice.page.evaluate(
        (key) =>
          (
            globalThis as unknown as { localStorage: { getItem(k: string): string | null } }
          ).localStorage.getItem(key),
        'hearth:voice-prefs',
      ),
      'no voice prefs stored',
    ).toBeNull();

    await pollDebug(
      alice.page,
      (d) => [d.transmitting, d.pttActive, d.localMic?.muted],
      'Alice transmits',
    ).toEqual([true, false, false]);
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
});
