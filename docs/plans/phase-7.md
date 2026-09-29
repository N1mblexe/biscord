# Phase 7 plan — Camera & screen share

Status: **approved 2026-09-29**. Spike result: headless Chromium with the CLAUDE.md flags resolves `getDisplayMedia` and a second page receives screen share (960×540 fake capture) and camera (320×180) through the real LiveKit container → **plain headless, no xvfb, no canvas fallback**.. Source: PLAN.md §3.9 and §5 Phase 7, CONTRACTS.md B.5 `voice:state` (`camera`, `screen`), B.6 (grants and publish presets).
Starts only after Phase 6 is committed.

## Goal

People in a voice channel can:

- Turn on their camera (720p30).
- Share a screen, window or tab (1080p30, with optional tab audio).
- Watch any of the videos in a grid or a focused view.

Everyone else sees a LIVE badge in the sidebar. No server media code and no new endpoints: the LiveKit grants already allow `CAMERA`, `SCREEN_SHARE` and `SCREEN_SHARE_AUDIO` (B.6).

## In scope

| Area        | Contract                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishing  | Client only: `setCameraEnabled(true, { resolution: VideoPresets.h720.resolution })` and `setScreenShareEnabled(true, { audio: true, resolution: ScreenSharePresets.h1080fps30.resolution, contentHint: 'detail' })`. |
| State flags | `voice:state { camera, screen }` (already in B.5) → `voice:updated` → sidebar badges                                                                                                                                 |
| Server      | Nothing new, except as noted under contract clarifications                                                                                                                                                           |

## Contract clarifications (CONTRACTS.md, in the same commit)

1. **`camera`/`screen` flags** come from the client and are cosmetic, for the sidebar. The server cross-checks them in the 60 s reconcile: from `listParticipants`, a `ParticipantInfo.tracks[].source` without a published camera or screen track forces the flag to false and emits `voice:updated`. So a crashed client can't leave a LIVE badge stuck.
2. **Screen-share audio** is published only when the browser provides it (tab audio in Chromium). It follows the per-user volume slider for that sharer through `setVolume(v, Track.Source.ScreenShareAudio)`.
3. **Publish presets:** camera 720p30 with simulcast (LiveKit defaults). Screen 1080p30 with `contentHint: 'detail'`, and simulcast off for screen share (text sharpness over bandwidth at 6–8 users).

## Key decisions

- **Spike first (mandatory, before any UI):** a throwaway Playwright script against the Phase 6 stack checks that headless Chromium, with the CLAUDE.md flags (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --auto-select-desktop-capture-source=Entire screen`), resolves `getDisplayMedia` and publishes a screen track that a second page receives with `videoWidth > 0`.
  - **Fallback A:** the same flags in a separate Playwright project running **headed under `xvfb-run`**, for the `@screen` specs only. The spike checks that `xvfb-run` exists on this Arch host; installing it needs `sudo pacman -S xorg-server-xvfb`, which the user runs.
  - **Fallback B:** the e2e build replaces `getDisplayMedia` with `canvas.captureStream()` via `addInitScript`. It still goes through LiveKit, but it's a weaker test and would be documented as such.
  - The spike's result decides which one is used, and it's recorded in PROGRESS.md.
- **Web:**
  - `voice/VideoStage.tsx`, shown in the main area while connected with at least one video: `useTracks([Camera, ScreenShare], { onlySubscribed: true })` + `GridLayout`-style CSS grid.
  - Clicking a tile focuses it (a large view plus a strip of the rest). Screen shares focus automatically when started, unless the viewer has already pinned something.
  - Controls in the voice panel: **Camera** / **Stop camera**, **Share screen** / **Stop sharing** (with a checkbox **Share tab audio**, default on).
  - Denied permission or the user cancelling the picker shows the page's single alert, "Screen share was cancelled or blocked", and the state stays consistent.
- **Adaptive stream:** only visible tiles subscribe at full quality; hidden or unfocused tiles get the lower simulcast layers. Viewing is opt-in by focusing; the grid keeps a limited set of videos by default.
- **LIVE badge:** the sidebar `voice-participant` shows `data-live="screen"` when screen sharing (text "LIVE") and a camera icon when the camera is on.
- **Debug hook (e2e only):** `__hearthDebug.voice()` gains `remotes[].video: [{ source: 'camera' | 'screen_share', subscribed, videoWidth, framesDecoded }]`. `videoWidth` is read from the attached `<video>` element and `framesDecoded` from `getReceiverStats()`.

## Web UI contract (for parallel e2e work)

| Where       | Contract                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice panel | Buttons **Camera** / **Stop camera** and **Share screen** / **Stop sharing** (`aria-pressed`), checkbox **Share tab audio**.                                                                                            |
| Video stage | `data-testid="video-stage"`. Tiles `data-testid="video-tile"` with `data-user-id`, `data-source` = `camera` / `screen_share`, and `data-focused="true"` on the focused tile. Tile label = display name (+ " (screen)"). |
| Sidebar     | `voice-participant` gets `data-camera="true"` and `data-live="screen"`.                                                                                                                                                 |

## Execution

1. **Lead:** run the spike and pick the approach (headless / xvfb / canvas fallback), update CLAUDE.md gotchas with the result, and add the contract clarifications. No new dependencies (unless xvfb, which is a system package the user installs).
2. **Parallel:**
   - **web agent:** controls, VideoStage, focus, badges, error handling, debug hook.
   - **server agent** (small): reconcile cross-checks camera/screen flags from `ParticipantInfo.tracks`, plus Vitest.
   - **e2e agent:** the specs below, with a `@screen` Playwright project if xvfb is chosen.
3. **Fresh reviewer** → fix-up agent → the lead runs acceptance (both modes, 3× repeat) → PROGRESS.md → commit `phase 7: …`.

## Acceptance tests

**Vitest (server):** reconcile clears stale `camera`/`screen` flags when LiveKit reports no such track, and leaves them set when the track exists (fake backend returning `ParticipantInfo` with `tracks[].source`). It emits `voice:updated` only on a change.

**Playwright (real LiveKit, fake media):**

1. **Camera:** Alice and Bob are in `Lounge`. Alice presses **Camera** → Bob's stage has a `video-tile[data-source=camera][data-user-id=alice]` with `videoWidth > 0` and `framesDecoded` increasing. Carol, outside the channel, sees Alice's `data-camera="true"`. **Stop camera** → the tile disappears for Bob and the flag clears for Carol.
2. **Screen share:** Alice presses **Share screen** → Bob gets a `screen_share` tile with `videoWidth > 0`, auto-focused. Carol sees `data-live="screen"`. **Stop sharing** → it's gone for Bob and the badge clears.
3. **Both at once plus focus:** Alice has camera and screen on, and Bob clicks the camera tile → `data-focused` moves to it. Stopping the screen share keeps Bob's pin.
4. **Cancel/deny:** with `getDisplayMedia` forced to reject via an init script, pressing **Share screen** shows the alert, and the button stays **Share screen** with `aria-pressed=false`.
5. **Stale flag after a crash:** Alice's context closes while sharing → Carol's badge clears (through `voice:left`, or the reconcile within its test interval).

**Full stack:** the `@smoke` specs plus a manual camera and screen share between two browsers through Caddy.

## Dependencies

None new, beyond the Phase 6 LiveKit packages. Possibly the system package `xorg-server-xvfb`, which the user installs if the spike needs it.

## Risks

1. **`getDisplayMedia` in headless Chromium.** Handled by the spike first, with the headed-xvfb and canvas fallbacks. The choice is written down in PROGRESS.md.
2. **CPU and bandwidth with several 1080p streams** on the small Oracle VM. LiveKit is an SFU and doesn't transcode, but it forwards every stream. Adaptive stream, simulcast on camera, viewing by focus, and a limited grid keep this down. It's measured on the VM in Phase 9.
3. **Stuck LIVE or camera badges** after crashes. Handled by `voice:left` on disconnect and the reconcile cross-check against the tracks LiveKit reports.
