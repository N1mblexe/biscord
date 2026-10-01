# Push-to-talk while the browser isn't focused — "Hearth PTT" desktop helper (plan)

Status: **approved 2026-10-01** (user decisions: companion helper, Rust, Windows + Linux X11 + Linux Wayland, portal with evdev fallback). Builds on docs/plans/devices.md.

## Context

- **The need:** the devices plan (`docs/plans/devices.md`, approved, not built yet) gives push-to-talk that only works while the Hearth tab is focused, because browsers never deliver keys to a page that isn't focused. The user wants push-to-talk to keep working while they're in a game or another app and use Hearth **on the web**.
- **User's decisions:**
  - A **companion helper app** on each PC catches the key globally and tells the open Hearth tab over a local connection.
  - It's written in **Rust**.
  - Targets: **Windows, Linux X11 and Linux Wayland**.
  - On Wayland it uses the **Global Shortcuts portal**, with an **evdev fallback**.
  - No server changes.
- **What I checked on this machine:**
  - The desktop is GNOME Shell 50.5 on Wayland, and `org.freedesktop.portal.GlobalShortcuts` is available.
  - `cargo 1.98` is installed; Go isn't.
  - The repo remote is GitHub `N1mblexe/biscord`, and there's no `.github/` yet.
  - The CSP `connect-src` in all three Caddyfiles allows only self and LiveKit.

**Order:** the user asked to start building `docs/plans/devices.md` next. The helper's Rust work is independent, so it can run alongside that. The helper's web integration waits until the devices work is merged, because it plugs into that work's PTT machine and its Settings section.

## Design

### 1. The helper app: `apps/ptt-helper/`

A Rust crate, binary `hearth-ptt`.

- **Repo setup:**
  - It's outside the pnpm workspace, and `target/` is gitignored.
  - Root scripts: `pnpm ptt:build` (`cargo build --release`) and `pnpm ptt:check` (`cargo fmt --check && cargo clippy -D warnings && cargo test`).
- **Input backends** sit behind `trait InputBackend`, which emits `KeyEvent { binding, pressed }`. All of them only observe keys and never swallow them, so `` ` `` still types normally in other apps.
  - **Windows:** low-level keyboard and mouse hooks (`WH_KEYBOARD_LL`/`WH_MOUSE_LL`), covering keys and the X1/X2 mouse buttons.
  - **X11:** XRecord, or XInput2 raw events.
  - The Wave 0 spike picks between `rdev` and direct `windows`/`x11rb` code, depending on which reliably reports both press and release, mouse X buttons included.
  - **Wayland (default): the Global Shortcuts portal**, via `ashpd`:
    - It creates a session and binds `ptt`, `toggle-mute` and `toggle-deafen` with a preferred trigger (e.g. `grave`). The desktop shows its confirmation dialog once.
    - `Activated`/`Deactivated` signals map to press/release.
    - Keyboard only; the user can change the key in GNOME/KDE settings.
  - **Wayland fallback: `evdev`.** Opt-in with `--backend evdev`. It reads `/dev/input/event*` and supports mouse side buttons. It needs the user in the `input` group; the docs explain the privacy trade-off.
  - **`stdin` backend:** for tests and debugging only. It reads lines like `down ptt` / `up ptt`.
  - **Auto-detection:** `XDG_SESSION_TYPE=wayland` → portal, falling back to evdev with a clear message if the portal is missing; otherwise X11; Windows → hooks.
- **Key names:** the web stores bindings as `KeyboardEvent.code` (`Backquote`, `F13`, `KeyV`, …) or as a mouse button (`3`/`4`). `keymap.rs` maps each code to the Windows virtual-key code, the X11 keysym, the evdev `KEY_*` and the portal trigger string. It's table-driven and unit-tested; codes the portal can't express are reported as unsupported.
- **PTT logic, in the helper:**
  - Key auto-repeat is ignored.
  - The **release delay runs in the helper**, using a native timer. Background tabs throttle `setTimeout`, so the page can't time it accurately; the page simply releases at once when it receives `up`.
  - The two toggle bindings emit `toggle` events.
- **Local WebSocket server** (`tungstenite`):
  - It binds **only `127.0.0.1:47391`**; the port can be changed in the config.
  - Only one instance runs; if the port is taken, it exits with a message.
  - At most 8 clients, messages up to 4 KB, rate-limited.
- **Pairing and security** (CONTRACTS B.13):
  - The `Origin` header must be in the paired list. An unpaired origin is allowed to connect only in order to pair.
  - Pairing:
    1. The helper shows a 6-digit code: in the tray menu or a desktop notification, and from `hearth-ptt pair`, which prints it.
    2. The user types the code into Hearth Settings.
    3. The page sends `{type:'pair', code}`.
    4. The helper stores the origin with a random 32-byte token (saved as a hash) and returns the token.
    5. The page keeps the token in localStorage `hearth:ptt-helper`.
  - Later connections send `{type:'auth', token}`. Nothing is sent before auth succeeds.
  - Codes expire after 2 minutes, and 5 wrong tries reset the code.
  - The helper never logs keys other than the bound ones.
- **Config file:** `%APPDATA%\Hearth PTT\config.json` or `~/.config/hearth-ptt/config.json`. It holds the port, the backend, paired origins with token hashes, and the current bindings and release delay pushed by the page.
- **Tray and autostart:**
  - **Windows:** a tray icon (`tray-icon`) with status, **Show pairing code**, **Start with Windows** (a registry `Run` key) and **Quit**.
  - **Linux:**
    - The tray is used if available. GNOME needs the AppIndicator extension; otherwise the helper runs headless.
    - The pairing code comes via `notify-rust` and the `pair` subcommand.
    - `hearth-ptt install-autostart` writes `~/.config/autostart/hearth-ptt.desktop`.

### 2. Protocol v1 (JSON over WebSocket; zod-validated on the page, serde on the helper)

- **Helper → page:**
  - `hello {v:1, version, platform, backend, paired:boolean}`
  - `paired {token}`
  - `authed`
  - `bound {ptt, mute, deafen, display}` (`display` is the key the desktop actually bound, e.g. the GNOME-chosen trigger)
  - `ptt {state:'down'|'up'}`
  - `toggle {action:'mute'|'deafen'}`
  - `error {code:'BAD_CODE'|'UNAUTHORIZED'|'UNSUPPORTED_KEY'|'BACKEND_UNAVAILABLE'|…}`
- **Page → helper:**
  - `pair {code}`
  - `auth {token}`
  - `bind {ptt: KeyBinding, mute: KeyBinding|null, deafen: KeyBinding|null, releaseMs}`
  - `ping`
- **Multiple tabs:** every authed tab gets the events, and only a tab that's connected to voice acts on them.

### 3. Web integration

Built on the devices plan's `voice/ptt.ts`, `voice/prefs.ts` and the Settings Voice & video section.

- **`voice/desktopHelper.ts`:**
  - Connects to `ws://127.0.0.1:<port>`, **only when the user has turned on "Use the desktop helper"**. That keeps everyone else away from the browser's local-network permission prompt.
  - Reconnects with backoff, runs the auth/pair flow, and keeps a store `useDesktopHelper {state: off|connecting|needs-pairing|connected|unavailable, backend, version, display}`.
  - After auth, and whenever prefs change, it sends `bind`.
- **PTT sources:** `createPushToTalk` gains named sources (`'page'`, `'helper'`); it's active while any source is held.
  - While the helper is connected, the page's own PTT key listener is off, so the helper is in charge and nothing is counted twice.
  - Helper `up` releases at once, because the helper already applied the delay.
  - `toggle` events call the existing `toggleMute`/`toggleDeafen`.
  - Applying the gate (`mute()`/`unmute()` on the mic track) works the same in a background tab.
- **Settings:** a new subsection **Push to talk outside the browser**, under the PTT controls:
  - checkbox **Use the desktop helper** (`helper-toggle`);
  - a status line (`helper-status`): Not running / Pairing needed / Connected (Windows hooks · GNOME shortcut "`") / Not available;
  - a pairing-code input and a **Pair** button (`helper-code`, `helper-pair`);
  - a download link and a help link (`/downloads/…`, docs);
  - **Unpair** (`helper-unpair`).
  - All strings are translated, en + tr.
- **CSP and browser notes:**
  - Add `ws://127.0.0.1:47391` to `connect-src` in all three Caddyfiles, and update `headers.spec.ts`.
  - The first connection may show Chrome/Brave's **local network access** permission prompt, and Brave Shields' "localhost" permission. Settings explains this when the state is `unavailable`.
  - Firefox allows loopback `ws://` from HTTPS pages.

### 4. Distribution

- **CI:** `.github/workflows/ptt-helper.yml` builds `hearth-ptt-windows-x64.exe` (on `windows-latest`) and `hearth-ptt-linux-x64` (on `ubuntu-latest`). It runs on `ptt-helper-v*` tags and on manual dispatch, and uploads the artifacts/release assets.
- **Hosting:** Caddy serves `/downloads/*` from a gitignored `data/downloads/`, so friends download from Hearth itself and don't need repo access. `infra/scripts/fetch-ptt-helper.sh` pulls the latest release assets into it (via `gh release download`). This covers the LAN and prod Caddyfiles.
- **Unsigned Windows exe:** SmartScreen will say "More info → Run anyway". This is documented.
- **Docs:** `docs/PTT-HELPER.md`: install per OS, pairing, Wayland portal vs evdev, the `input`-group trade-off, browser permission prompts, troubleshooting, uninstall.

### 5. Contracts and dependencies

- **CONTRACTS:** a new **B.13 "Desktop PTT helper"** covering the port, loopback-only binding, origin and pairing rules, protocol v1, the release delay owned by the helper, and the helper being off by default. B.12 rule 3 is amended to read "tab-focused unless the desktop helper is paired".
- **CLAUDE.md:**
  - A "Rust helper" pinned-versions block, verified on crates.io in Wave 0: `tungstenite`, `serde`/`serde_json`, `ashpd`, `evdev`, `rdev` or `windows`/`x11rb`, `tray-icon`, `notify-rust`, `rand`, `sha2`, `directories`.
  - New commands, and a gotcha: "TypeScript everywhere except `apps/ptt-helper` (Rust)".
- **PLAN.md:** a note that a desktop helper (not a native app) is in scope.

## Execution (lead + subagents in worktrees, each starting with `git reset --hard main`)

- **Now (per the user): start `docs/plans/devices.md`.**
  - Its Wave 0 docs are already committed.
  - Next is its Wave 1 core agent, then its Wave 2 (Settings UI, voice panel, e2e), then review and acceptance.
  - The helper's Waves 0–1 run in parallel with it, since they touch only `apps/ptt-helper/` and docs.
- **Helper Wave 0 (lead):**
  - B.13, `docs/plans/ptt-helper.md` (this plan) and the CLAUDE.md pins.
  - A **spike agent** checks the hook libraries on Linux X11 (via Xvfb/XWayland), the portal on this GNOME 50.5 session (bind a shortcut, see Activated/Deactivated), and that the Windows target compiles (`cargo check --target x86_64-pc-windows-gnu`, if the target can be added).
- **Helper Wave 1** (in parallel; module ownership is fixed by the trait defined in Wave 0):
  - **H1 core:** WS server, pairing and config, the PTT logic, keymap, the stdin backend, Windows and X11 backends, tray/autostart, and Rust tests.
  - **H2 Wayland:** the portal and evdev backends, and auto-detection.
- **Helper Wave 2** (after the devices work is merged):
  - **W web:** `desktopHelper.ts`, PTT sources, the Settings subsection, i18n, CSP and unit tests.
  - **D distribution:** CI workflow, `/downloads` in Caddy, the fetch script, `docs/PTT-HELPER.md`.
  - **E e2e:** see Verification.
- **Helper Wave 3:**
  - A reviewer, with a security focus on origin/token handling, loopback binding and no key logging.
  - Fix-ups.
  - Lead acceptance and a manual test on the user's GNOME Wayland machine.
  - PROGRESS.md and the commit `feat(ptt-helper): desktop push-to-talk helper for the web app`.

## Verification

- **Rust** (`pnpm ptt:check`):
  - keymap tables;
  - the PTT machine (repeat, release delay, toggles);
  - protocol serde round-trips;
  - pairing: code expiry, retry limit, token hash check, bad Origin rejected, nothing sent before auth;
  - an integration test: the WS server on a random port, a tungstenite client pairs, the stdin backend sends `down`/`up`, and the client receives `ptt` events.
- **Web unit tests:** the helper client state machine with a fake WebSocket (pair, auth, reconnect, bad messages ignored), merging of PTT sources, and no page listener while the helper is connected.
- **e2e** (`e2e/tests/ptt-helper.spec.ts`, @voice):
  - Playwright starts `hearth-ptt --backend stdin --config <tmp> --port 47399` (the e2e build reads `VITE_PTT_HELPER_PORT`) and grants or disables Chromium's local-network-access check.
  - Alice turns the helper on, pairs with the code printed on stdout, chooses PTT and joins voice.
  - Bob's page is brought to the front, so Alice's tab is unfocused. `down ptt` on stdin → Bob sees Alice `data-speaking` / hears her. `up ptt` → it stops.
  - A reload re-authenticates without pairing again. A wrong code shows an error. Unpairing stops the events.
- **Full stack:** `@smoke` checks the new `connect-src` entry and that `/downloads/` is served.
- **Manual:**
  - The user on GNOME 50.5 Wayland: the portal dialog, PTT while another app is focused, autostart.
  - A Windows friend: the downloaded exe, SmartScreen, PTT in a fullscreen game, mouse side button.
  - An X11 friend: the same checks.
- **Gates:** `pnpm typecheck`, `lint`, `format:check`, `test`, `pnpm ptt:check`, and the e2e suite ×3.

## Known limits (in the docs)

- The helper must be running, and the Hearth tab must stay open (it can be in the background).
- Wayland portal mode supports keyboard keys only; mouse buttons need the evdev fallback.
- Some anti-cheat software dislikes global input hooks (the same caveat as Discord's own).
- The first connection may trigger the browser's local-network permission prompt.
