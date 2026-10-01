# Voice and video devices, push-to-talk and audio settings — plan

Status: **approved 2026-10-01; starts after the i18n work (docs/plans/i18n.md) is merged.** Contracts: CONTRACTS B.12 (and the B.6/B.6b camera presets).
Requested by the user: "plan to add detailed mic, headphone, camera selection and push to talk etc.". The user's choices were:

- Settings plus quick menus in the voice panel.
- A rebindable push-to-talk key that works while the tab is focused.
- Noise, echo and gain toggles.
- A mic test with a level meter.
- Voice-activity sensitivity.
- A camera preview and a quality choice.

## Goal

Everyone can:

- choose their microphone, speaker or headphones, and camera, and switch them during a call;
- use push-to-talk (a key, a mouse side button, or a hold button on phones) or voice activity with a sensitivity threshold;
- toggle the browser's noise suppression, echo cancellation and auto gain control;
- test their mic (level meter and loopback) and speakers (test sound);
- preview their camera and pick 360p, 720p or 1080p.

There are no server changes. Everything is stored per browser (B.12).

## Architecture

- **`voice/prefs.ts`, `voice/devices.ts`, `voice/gate.ts`, `voice/ptt.ts`, `voice/levelMeter.ts` (+ `voice/levelWorklet.js`):** these use plain browser APIs, not LiveKit, and may be imported from the initial bundle (Settings, VoicePanel, VoiceProvider).
- **VoiceProvider** (initial bundle):
  - It owns the push-to-talk machine and the keyboard/mouse shortcuts, which are active only while `state === 'connected'`.
  - It writes `pttActive` to the voice session.
  - It exposes `pttPress`/`pttRelease` in `VoiceActions` for the on-screen hold button.
- **engine.tsx** (the lazy chunk, the only LiveKit user):
  - It builds `RoomOptions` from the prefs.
  - It subscribes to `useVoicePrefs` and reconciles device, processing and quality changes.
  - It runs the VAD level meter on a clone of the published mic track.
  - It applies the gate: `shouldTransmit(...)` → mic publication `mute()`/`unmute()`.
  - It writes `transmitting` to the session.
  - Mic restarts go through the controller's `micQueue`, using the new `VoiceRoomPort.restartMic(constraints)`.
- **Device loss:** a `devicechange` event where the chosen ID has disappeared triggers a switch to `'default'` and a notice; the preference is kept.

## Module APIs (binding for the parallel agents)

```ts
// voice/prefs.ts (the zod field schemas live in @hearth/shared: VoicePrefsFields, KeyBinding, InputMode, CameraQuality)
export const VOICE_PREFS_KEY = 'hearth:voice-prefs';
export type KeyBinding = { type: 'key'; code: string } | { type: 'mouse'; button: 3 | 4 };
export type InputMode = 'voice' | 'ptt';
export type CameraQuality = '360p' | '720p' | '1080p';
export interface VoicePrefs {
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string; // 'default' = system default
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  inputMode: InputMode;
  vadGate: boolean;
  vadThresholdDb: number; // −100…0
  pttKey: KeyBinding;
  pttReleaseMs: number; // 0…1000
  muteKey: KeyBinding | null;
  deafenKey: KeyBinding | null;
  cameraQuality: CameraQuality;
}
export const DEFAULT_VOICE_PREFS: VoicePrefs;
export const CAMERA_QUALITY: Record<CameraQuality, { width: number; height: number; frameRate: 30 }>;
export function parseVoicePrefs(raw: unknown): VoicePrefs; // per-field fallback to defaults, clamps ranges
export function readVoicePrefs(): VoicePrefs; // try/catch, never throws
export function writeVoicePrefs(prefs: VoicePrefs): void; // try/catch
export function followVoicePrefsStorage(win): () => void; // `storage` event from another tab → reload (installed at module load)
export const useVoicePrefs: UseBoundStore<
  StoreApi<{
    prefs: VoicePrefs;
    update: (patch: Partial<VoicePrefs>) => void; // validates, saves, notifies
    reset: () => void;
    reload: () => void;
  }>
>;

// voice/devices.ts
export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';
export interface DeviceOption {
  deviceId: string;
  label: string;
} // label '' → UI shows a numbered fallback
export interface DeviceLists {
  audioinput: DeviceOption[];
  audiooutput: DeviceOption[];
  videoinput: DeviceOption[];
  labelsHidden: boolean;
  supported: boolean;
}
export function listDevices(): Promise<DeviceLists>;
export function useMediaDevices(): DeviceLists & {
  refresh: () => void;
  requestAccess: (kinds: { audio?: boolean; video?: boolean }) => Promise<boolean>; // gUM once, stop, refresh
};
export function resolveDevice(list: readonly DeviceOption[], preferredId: string): string; // missing → 'default'; an empty list (no permission yet) keeps the preference
export function canSelectOutput(): boolean; // HTMLMediaElement.prototype.setSinkId exists
export function canPromptOutput(): boolean; // navigator.mediaDevices.selectAudioOutput exists
export function audioConstraints(prefs: VoicePrefs, deviceId?: string): MediaTrackConstraints; // deviceId via micDeviceConstraint
export function micDeviceConstraint(deviceId: string): ConstrainDOMString; // a chosen mic { exact } (Chromium ignores an ideal/bare audio deviceId and opens the default); 'default' { ideal }
export function withDefaultMic<T>(constraints: T): T; // same constraints on { ideal: 'default' }
export function isMissingDevice(error: unknown): boolean; // OverconstrainedError / NotFoundError
export function openMic(audio: MediaTrackConstraints): Promise<MediaStream>; // gUM; a gone mic falls back to the default (the engine's capture does the same)
export function videoConstraints(prefs: VoicePrefs, deviceId?: string): MediaTrackConstraints; // { ideal } device, width, height, frameRate, aspectRatio

// voice/gate.ts (pure)
export interface GateInput {
  micMuted: boolean;
  deafened: boolean;
  inputMode: InputMode;
  pttActive: boolean;
  vadGate: boolean;
  vadOpen: boolean;
}
export function shouldTransmit(s: GateInput): boolean;
export const VAD_RELEASE_MS = 300;
export function createVadHysteresis(releaseMs?: number): {
  update: (db: number, thresholdDb: number, nowMs: number) => boolean; // open at ≥ threshold, close after releaseMs below
  reset: () => void;
};

// voice/ptt.ts
export function isEditableTarget(target: EventTarget | null): boolean;
export function isPrintingKey(code: string): boolean; // letters, digits, punctuation, Space, Backquote…
export function matchesBinding(b: KeyBinding | null, e: KeyboardEvent | MouseEvent): boolean;
export const PAGE_SOURCE = 'page';
export interface PushToTalk {
  // Named sources ('page' = this tab's key/mouse/hold button; later 'helper', docs/plans/ptt-helper.md §3).
  // Active while any source holds it; a press during a pending release keeps it.
  press: (source?: string) => void; // default 'page'
  release: (source?: string, opts?: { immediate?: boolean }) => void; // after releaseMs, or at once with immediate (the helper owns its delay)
  releaseNow: () => void; // every source, at once
  active: () => boolean;
  dispose: () => void; // clears without calling onChange
}
export function createPushToTalk(opts: {
  releaseMs: () => number;
  onChange: (active: boolean) => void;
}): PushToTalk;
export function bindVoiceShortcuts(
  win: Window,
  opts: {
    prefs: () => VoicePrefs;
    enabled: () => boolean;
    ptt: PushToTalk;
    onToggleMute: () => void;
    onToggleDeafen: () => void;
  },
): () => void; // keydown/keyup/pointerdown/pointerup (+ mouseup to swallow side-button navigation)/blur/visibilitychange; blur and hide release only 'page', at once
export function recordBinding(win: Window, signal?: AbortSignal): Promise<KeyBinding | null>; // Escape → null
export function bindingLabel(b: KeyBinding | null, layout?: ReadonlyMap<string, string>): string; // translated (voice.keys.*): '`', 'A', 'Left Shift', 'Mouse 4', 'Not set'

// voice/levelMeter.ts
export interface LevelMeter {
  subscribe: (cb: (db: number) => void) => () => void;
  stop: () => void;
}
export function createLevelMeter(track: MediaStreamTrack): Promise<LevelMeter>; // clones the track; AudioWorklet, AnalyserNode fallback; ~20 ms
export function rmsToDb(rms: number): number; // floor −100
export function dbToFraction(db: number): number; // −100…0 → 0…1 for meters

// voice/session.ts additions: transmitting: boolean; pttActive: boolean (both reset on leave); GATE_OFF
// voice/context.ts additions: pttPress(): void; pttRelease(): void; EngineVoiceActions = VoiceActions without those two
// voice/controller.ts additions:
//   VoiceRoomPort: setMicrophoneEnabled(enabled, transmit) (publishes/unmutes but stays muted while the gate is closed),
//                  setMicGate(open), restartMic(constraints)
//   VoiceController: setGate(gate: LocalGate), restartMic(constraints): Promise<void> (both on micQueue)
//   LocalGate = Omit<GateInput, 'micMuted' | 'deafened'>
// voice/roomOptions.ts (pure): roomOptionsFromPrefs(prefs, devices), micConstraints, cameraCaptureOptions
//   (the engine's publish and restartMic retry on the default mic when an exact one is gone: isMissingDevice)
// voice/deviceSync.ts (engine chunk): startDeviceSync(...) — live device/processing/quality changes, device loss
// debug (e2e): localMic { deviceId, muted, constraints } | null, camera { deviceId, width } | null, audioSinkId: string | null,
//              transmitting, pttActive
// i18n: voice.messages.{micLost, cameraLost, outputLost, switchFailed}, voice.keys.{none, space, mouse, left, right}
```

## UI contract (English copy; e2e runs in en-US)

**Settings, a new section after Language:** `<section id="voice" aria-labelledby="settings-voice-heading">` with the heading **Voice & video** (`data-testid="settings-voice-heading"`).

| Control                                     | Label / name                                                                                             | testid                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Permission button (while labels are hidden) | **Allow access**                                                                                         | `device-access`                           |
| Mic select                                  | **Input device**                                                                                         | `mic-select`                              |
| Output select                               | **Output device** (hidden when unsupported; hint "Your browser chooses the output device.")              | `speaker-select`                          |
| Firefox output prompt                       | **Choose output device**                                                                                 | `speaker-choose`                          |
| Camera select                               | **Camera**                                                                                               | `camera-select`                           |
| Level meter                                 | `<meter>` labelled **Input level**, `data-level` in dB                                                   | `mic-level`                               |
| Loopback                                    | toggle button **Let's check** / **Stop checking** (`aria-pressed`), hint "Use headphones to avoid echo." | `mic-test`                                |
| Test tone                                   | **Play test sound**                                                                                      | `speaker-test`                            |
| Input mode                                  | radio group **Input mode**: **Voice activity**, **Push to talk**                                         | `input-mode`                              |
| VAD gate                                    | checkbox **Only transmit above the sensitivity**                                                         | `vad-gate`                                |
| Sensitivity                                 | range **Input sensitivity** (−100…0 dB)                                                                  | `vad-threshold`                           |
| PTT key                                     | button **Push-to-talk key: `<key>`**; while recording "Press a key… (Esc to cancel)"                     | `ptt-key`                                 |
| Release delay                               | range **Release delay** (0–1000 ms)                                                                      | `ptt-release`                             |
| Shortcuts                                   | **Toggle mute shortcut**, **Toggle deafen shortcut**, each with **Clear**                                | `mute-key`, `deafen-key`                  |
| Processing                                  | checkboxes **Noise suppression**, **Echo cancellation**, **Automatic gain control**                      | `ns-toggle`, `ec-toggle`, `agc-toggle`    |
| Camera preview                              | toggle **Preview camera** / **Stop preview** + `<video muted playsinline>`                               | `camera-preview-toggle`, `camera-preview` |
| Quality                                     | select **Video quality**: 360p, 720p, 1080p                                                              | `camera-quality-select`                   |

Notes: Settings streams stop on unmount and on tab hide. The mic meter runs only while the section is on screen and a mic test is running (**Test microphone** starts it: `mic-meter-toggle`).

**Voice panel.** The existing exact names (Mute/Unmute, Deafen/Undeafen, Leave, Camera/Stop camera, Share screen/Stop sharing, Share tab audio) are unchanged.

| Control          | Name                                                                                                                                                                                         | testid          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Audio quick menu | button **Audio options** (`aria-haspopup="menu"`, `aria-expanded`) → menu with **Input device** and **Output device** radio groups and a link **Voice & video settings** (`/settings#voice`) | `audio-options` |
| Video quick menu | button **Video options** → **Camera** radio group, **Video quality** radio group, the same link                                                                                              | `video-options` |
| PTT hold         | button **Push to talk** (hold; pointer events, `touch-action: none`), shown only in PTT mode                                                                                                 | `ptt-button`    |
| Hint             | "Hold `<key>` to talk" (PTT mode)                                                                                                                                                            | `ptt-hint`      |
| Panel            | `data-transmitting="true\|false"` on `voice-panel`                                                                                                                                           | —               |

Notices (one-shot, not alerts): "Microphone disconnected — using the default device.", "Camera disconnected — using the default device.", "Output device disconnected — using the default device.", "Couldn't switch to that device."

Header: Permissions-Policy gains `speaker-selection=(self)` in all three Caddyfiles.

## Waves

1. **Core (one agent):** the modules above, the engine/controller integration, session and debug fields, and unit tests. `routes/lazy.test.ts` stays green.
2. **In parallel:**
   - **Settings UI**, with en and tr strings;
   - **the voice panel quick menus**, the PTT button and hint, `data-transmitting`, and the Caddy header plus `headers.spec.ts`;
   - **e2e** `e2e/tests/devices.spec.ts` (@voice).
3. **Review and fix-up,** then acceptance: gates, e2e ×3, full-stack smoke, and screenshots at 390 px and 1280 px in en and tr. Then PROGRESS.md and the commit `feat(voice): device selection, push-to-talk, voice activity and audio settings`.

## Known limits

- Push-to-talk works only while Hearth is focused.
- iOS Safari can't choose the output device.
- The processing flags are hints the browser may ignore.
