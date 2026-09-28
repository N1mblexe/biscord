# Phase 6 plan — Voice (LiveKit)

Status: **awaiting approval**. Source: PLAN.md §3.8 and §5 Phase 6, CONTRACTS.md B.4 rows 1, 18 and 29–30, B.5 voice events, B.6, B.7.
Starts only after Phase 5 is committed.

## Goal

Friends can hang out in voice channels:

- Join and leave a voice channel, with one voice channel per user at a time.
- Mute, deafen, a speaking ring, and per-user local volume.
- Everyone sees who's in which voice channel, even without joining.

All media goes through the self-hosted LiveKit container. There is no custom WebRTC, signaling or TURN code (CLAUDE.md).

## In scope

| Area         | Contract                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token        | row 29 `POST /api/voice/:channelId/token` → `{token, url, roomName, expiresAt}` (grants per B.6)                                                                     |
| Webhook      | row 30 `POST /api/livekit/webhook` (raw body, `Authorization` JWT verified by `WebhookReceiver`)                                                                     |
| Voice state  | `voice:joined` / `voice:updated` / `voice:left` to `all`. Client→server `voice:state {channelId, selfMute, selfDeaf, camera, screen}`. `/bootstrap.voice` goes live. |
| Voice delete | row 18 for voice channels: LiveKit `deleteRoom` **before** the DB delete (fills the Phase 3 `TODO(phase 6)` in `services/channels.ts`)                               |
| Health       | row 1 `livekit: 'ok' \| 'down'`                                                                                                                                      |
| Test reset   | row 39 also deletes this test DB's LiveKit rooms and clears the voice state                                                                                          |

**Deferred to Phase 8:**

- row 31, the admin "disconnect from voice" endpoint and its UI;
- the voice part of deactivating a user (B.7);
- the e2e test for deleting a voice channel with people in it.

Phase 6 still wires `deleteRoom`, with a server-side test.

## API facts checked against the pinned type definitions

**livekit-server-sdk 2.19.1:**

- `AccessToken(key, secret, { identity, name, ttl })`, `addGrant(VideoGrant)`, and `toJwt(): Promise<string>`, which is async.
- `VideoGrant.canPublishSources: TrackSource[]`, with `TrackSource` re-exported by the SDK: `CAMERA=1`, `MICROPHONE=2`, `SCREEN_SHARE`, `SCREEN_SHARE_AUDIO`.
- `WebhookReceiver.receive(body: string, authHeader?, skipAuth?, clockTolerance?): Promise<WebhookEvent>`. It checks a `sha256` claim over the **exact raw body string**.
- `WebhookEvent` has `event` (the names include `participant_joined`, `participant_left`, `participant_connection_aborted`, `room_finished`, `track_published` and `track_unpublished`), `room?`, `participant?`, `id` and `createdAt: bigint`.
- `RoomServiceClient(httpHost, key, secret)` has `listRooms(names?)`, `listParticipants(room)`, `removeParticipant(room, identity)`, `deleteRoom(room)` and `mutePublishedTrack`.
- The SDK pins `@livekit/protocol` 1.51.0 exactly. Import `TrackSource` from `livekit-server-sdk` and never add `@livekit/protocol` directly.

**livekit-client 2.22.3:**

- `localParticipant.setMicrophoneEnabled/setCameraEnabled/setScreenShareEnabled(enabled, captureOptions?, publishOptions?)`.
- `RemoteParticipant.setVolume(v, source?)`, `room.startAudio()` and `room.canPlaybackAudio`.
- `RoomEvent.ActiveSpeakersChanged`, `AudioPlaybackStatusChanged` (`'audioPlaybackChanged'`), `Disconnected`, `Reconnecting`, `TrackSubscribed` and `TrackUnsubscribed`.
- `RemoteTrack.getRTCStatsReport()` and `RemoteAudioTrack.getReceiverStats()`.

**@livekit/components-react 2.9.24:**

- `LiveKitRoom`, `RoomAudioRenderer({ volume, muted })`, `useTracks`, `useParticipants`, `useIsSpeaking`, `useLocalParticipant`, `useConnectionState`.
- **Peer dependency `tslib@^2.6.2` is required**, while `@livekit/krisp-noise-filter` is optional. pnpm installs peers automatically, but `tslib` isn't in PLAN.md, so the lead asks for approval to pin it (see Dependencies).

## Contract clarifications (CONTRACTS.md, in the same commit)

1. **Health (row 1):**
   - LiveKit reachability is a `listRooms` call with a 2 s timeout, cached for 10 s.
   - LiveKit down with the DB up gives **200** and `{status:'degraded', db:'ok', livekit:'down'}`. Only a DB outage returns 503.
2. **Token (row 29):**
   - Minting is local, so `LIVEKIT_UNAVAILABLE` comes back only when the cached health says LiveKit is down.
   - Rate limit: 30 per minute per user.
   - The response `url` is `LIVEKIT_PUBLIC_URL`.
3. **Webhook (row 30):**
   - The body is read as raw text: a Fastify content-type parser for `application/webhook+json` returns the string unparsed.
   - Handling is idempotent:
     - the last 1000 event `id`s are remembered and repeats are ignored;
     - participants are keyed by `(userId, participant.sid)`, so a stale `participant_left` for an older sid never removes a newer join;
     - `participant_connection_aborted` counts as left;
     - an event for a room whose channel isn't in **this** server's DB is ignored.
   - Ignoring foreign rooms matters because the dev server (:3000) and the e2e server (:3100) both get every webhook from the shared container.
4. **Voice state:**
   - The server keeps an in-memory `Map<channelId, Map<userId, VoiceParticipant>>`. `voice:state` from a client is stored per user and applied, via `voice:updated`, only while that user is in that channel. Otherwise the ack is `VALIDATION`.
   - Reconcile runs at boot and every 60 s: `listRooms` → Hearth rooms → `listParticipants`, compared against memory, emitting joined/left for any differences.
5. **One channel at a time:** a `participant_joined` for a user already in another room triggers `removeParticipant` on the old room (a 404 counts as success). The client also disconnects the old room before joining a new one.
6. **Test reset (row 39):** before truncating, it collects this DB's voice channel ids, `deleteRoom`s each one (404 is fine), and clears voice memory and the webhook id cache. Rooms from other databases on the shared container are left alone.

## Key decisions

- **Server:**
  - `livekit/client.ts`: a `RoomServiceClient` behind a small `VoiceBackend` interface, so tests can inject a fake as well as use the real container.
  - `livekit/token.ts`, `routes/voice.ts`, `routes/livekit-webhook.ts`.
  - `realtime/voice-state.ts`, `livekit/reconcile.ts`, started and stopped with the app's lifecycle hooks.
- **Web:**
  - `voice/VoiceProvider.tsx` wraps a single `livekit-client` `Room` at app level, so voice survives moving between text channels.
  - It uses `adaptiveStream` and `dynacast`.
  - `RoomAudioRenderer` handles playback. Deafen = `muted` on the renderer plus self-mute; undeafen restores the previous mic state.
  - Per-user volume uses `RemoteParticipant.setVolume(0–1)` through a slider in the participant's menu, saved in `localStorage` by user id.
  - Speaking ring: `useIsSpeaking` / `ActiveSpeakersChanged`, which only works for people inside the same room.
- **Sidebar:** each voice channel lists its participants from bootstrap plus `voice:*` events, with mute and deafen icons from `voice:state`. Clicking a voice channel joins it.
- **Autoplay:** if `canPlaybackAudio` is false, a **Click to enable audio** banner calls `room.startAudio()`. The e2e flag `--autoplay-policy=no-user-gesture-required` avoids it in tests.
- **Debug hook (e2e builds only):** `window.__hearthDebug.voice()` returns `{ state, roomName, localIdentity, remotes: [{ identity, audioSubscribed, audioBytesReceived }] }`. The bytes come from the inbound-rtp `bytesReceived` in `getRTCStatsReport()`.
- **How e2e gets webhooks:** the e2e server on :3100 receives them through `host.docker.internal:3100`, already in `infra/livekit/livekit.yaml` together with `extra_hosts: host-gateway`. The server listens on `0.0.0.0`. A **connectivity spike runs first** to confirm LiveKit can reach the host's :3100 (host firewall and nftables). The 60 s reconcile is the safety net, and the e2e server gets a 5 s reconcile interval (`VOICE_RECONCILE_MS`, a new optional env var).

## Web UI contract (for parallel e2e work)

| Where         | Contract                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar       | Voice channels become buttons `data-testid="voice-channel"` (name as text). Under each, `data-testid="voice-participant"` per user with `data-user-id`, `data-muted` and `data-deafened`, plus `data-speaking="true"` only for people in your own room. |
| Voice panel   | Shown while connected: `data-testid="voice-panel"` with `data-state` = `connecting` / `connected` / `reconnecting`, the channel name, and buttons **Mute**/**Unmute** (`aria-pressed`), **Deafen**/**Undeafen** (`aria-pressed`) and **Leave**.         |
| Volume        | A participant's context button **Volume** opens a slider labelled **Volume for <displayName>** (0–100).                                                                                                                                                 |
| Audio blocked | A `data-testid="audio-unblock"` button **Click to enable audio**, shown only when playback is blocked.                                                                                                                                                  |

## LAN test profile (voice with devices on the same Wi-Fi)

The goal is to test voice between this PC and a phone or laptop on the same network before deploying to Oracle. The normal local setup can't do it for two reasons:

- **Browsers block the mic without HTTPS.** They allow `getUserMedia` only on `https://` or `localhost`.
- **LiveKit advertises the wrong address.** `infra/livekit/livekit.yaml` advertises `127.0.0.1`, which other devices can't reach.

The LAN profile fixes both. It's a compose **override**, so the normal dev, e2e and full-stack setups are unchanged.

| Piece                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.lan.yml`    | An override merged on top of `docker-compose.yml`. **web (Caddy):** uses `infra/caddy/Caddyfile.lan`, publishes `8443/tcp` and `7443/tcp`, and keeps its CA in a named volume `caddy_data` so the root certificate survives restarts. **livekit:** starts with `--node-ip ${LAN_IP}` so browsers on other devices get a reachable address (7881/tcp and 7882/udp are already published on all interfaces). **server:** `APP_ORIGIN=https://${LAN_IP}:8443`, `LIVEKIT_PUBLIC_URL=wss://${LAN_IP}:7443`, `COOKIE_SECURE=true`. |
| `infra/caddy/Caddyfile.lan` | `https://{$LAN_IP}:8443` with `tls internal` (Caddy's local CA issues a certificate for the IP address, so no DNS is needed). It has the same routes as the local Caddyfile (`/api`, `/socket.io`, SPA). `https://{$LAN_IP}:7443` with `tls internal` proxies to `livekit:7880`, giving browsers **wss** signaling: an https page can't open `ws://`.                                                                                                                                                                        |
| `infra/scripts/lan-up.sh`   | Detects the LAN IP (`ip -4 route get 1.1.1.1`, overridable with `LAN_IP=`) and runs `docker compose -f docker-compose.yml -f docker-compose.lan.yml up --build -d --wait`. It then exports Caddy's root certificate to `data/lan/hearth-lan-root.crt` (`docker compose cp web:/data/caddy/pki/authorities/local/root.crt`), prints the URLs, the certificate path and a bootstrap invite link, and warns if a host firewall (nftables/ufw/firewalld) is active, listing the ports to open.                                   |
| Root `package.json` scripts | `lan:up` → `infra/scripts/lan-up.sh`, `lan:down` → `docker compose -f docker-compose.yml -f docker-compose.lan.yml down`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Docs                        | A "LAN testing" section in `docs/DEPLOY.md` (created here, extended in Phase 9) with a per-device checklist. **Desktop:** import `hearth-lan-root.crt` into the browser or OS trust store, or accept the warning on **both** `https://IP:8443` and `https://IP:7443`, because wss can't show a click-through prompt. **Android:** Settings → Security → Install certificate → CA. **iOS:** install the profile, then turn on full trust in Settings → General → About → Certificate Trust Settings.                          |

Ports on the host: 8443/tcp (app), 7443/tcp (LiveKit signaling), 7881/tcp (media fallback), 7882/udp (media). This is only for a trusted home network: the local CA's key lives in the `caddy_data` volume.

**Contract changes:** a B.8 row for the LAN profile (the env values above). CLAUDE.md commands: `pnpm lan:up` / `pnpm lan:down`, plus a gotcha: open `https://IP:7443` once, or install the root certificate, before joining voice from a new device.

## Execution

1. **Lead:**
   - Connectivity spike: from the container, `wget` host :3100 during a tiny throwaway listener; then a two-page fake-media join by hand.
   - Pin `livekit-server-sdk@2.19.1` (server) and `livekit-client@2.22.3` + `@livekit/components-react@2.9.24` (+ `tslib` once approved) (web).
   - Contract clarifications 1–6, plus the `VOICE_RECONCILE_MS` env var in B.8 and `.env.example`.
   - After the parallel agents land: the **LAN profile** (`docker-compose.lan.yml`, `Caddyfile.lan`, `lan-up.sh`, scripts, DEPLOY.md section), since it only touches lead-owned root and infra files.
2. **Parallel:**
   - **server agent:** token, webhook, voice state, reconcile, voice delete, health, test reset, Vitest.
   - **web agent:** VoiceProvider, sidebar, voice panel, deafen/volume, speaking ring, debug hook.
   - **e2e agent:** the specs below.
3. **Fresh reviewer** → fix-up agent if needed → the lead runs acceptance (both modes, 3× repeat) → PROGRESS.md → commit `phase 6: …`.

## Acceptance tests

**Vitest (server):**

- **Token:** decode the JWT and check identity, name, room `voice_<id>`, TTL 600 s, the exact grants and `canPublishSources`. A text channel → 404. An inactive user → 401.
- **Webhook:**
  - A valid signature is accepted (signed in the test with `AccessToken` + `sha256` over the body). A bad signature or a tampered body → 401.
  - A duplicate event `id` is a no-op. A stale-sid `participant_left` is ignored.
  - A foreign room is ignored.
  - `room_finished` clears the room.
  - A join to a second room calls `removeParticipant` on the first (fake backend).
- **Voice state:** `voice:state` outside a room → ack `VALIDATION`. Inside → `voice:updated` to `all`.
- **Reconcile:** memory is corrected in both directions with the right events emitted. Bootstrap `voice` matches memory.
- **Voice delete:** calls `deleteRoom` before the DB delete. A backend error → `LIVEKIT_UNAVAILABLE` with the channel kept. A 404 from `deleteRoom` still deletes.
- **Health:** LiveKit down → 200 with `degraded`.
- **Real container (small suite):** `listRooms`, create by token join, `deleteRoom` round-trip against `http://localhost:7880`.

**Playwright (dev-server mode, real LiveKit container, fake media):**

1. **Join and hear:** Alice and Bob join `Lounge`. Both panels reach `connected`. Each sidebar shows both `voice-participant`s. `__hearthDebug.voice()` shows the other's audio subscribed, with `audioBytesReceived` > 0 and increasing (`expect.poll`).
2. **Visible to non-members:** Carol, not joined, sees Alice and Bob under `Lounge` within 5 s, and sees them removed when they **Leave**.
3. **Mute/deafen:** Alice presses **Mute** → Bob and Carol see `data-muted="true"`. Deafen → `data-deafened="true"`, and Alice's remote audio is muted locally (debug hook). Undeafen restores the earlier mute state.
4. **Speaking ring:** with Bob unmuted (the fake mic produces a tone), Alice sees Bob's `data-speaking="true"` at some point (`expect.poll`).
5. **Switching channels:** Alice joins `Games` while in `Lounge`. Everyone sees her only under `Games`, and there are never two panels.
6. **Resilience:** Bob's page reloads → he leaves (`voice:left`) and can rejoin.

**Full stack:** the `@smoke` specs plus a manual two-browser join through Caddy on :8080 (LiveKit at ws://localhost:7880). `/api/health` shows `livekit: 'ok'`.

**LAN profile:**

- **Automated (lead, on this machine):**
  - `pnpm lan:up`, then run a small Playwright script against `https://<LAN_IP>:8443` with `ignoreHTTPSErrors: true`, going through the LAN IP rather than localhost.
  - Two users register and join `Lounge`. Both reach `connected`, and `audioBytesReceived` > 0 for each.
  - This proves HTTPS, wss signaling, the advertised node IP and the UDP/TCP media ports all line up.
  - Then `pnpm lan:down`.
- **Manual (you, with a second device on the same Wi-Fi):**
  1. Install the root certificate.
  2. Open `https://<LAN_IP>:8443` and register via an invite.
  3. Join voice with the PC.
  4. Both of you hear each other, and mute/deafen and the speaking ring work.

  Record the result in PROGRESS.md. This check doesn't block the phase commit, because it needs your device.

## Dependencies

- **server:** `livekit-server-sdk@2.19.1`.
- **web:** `livekit-client@2.22.3` and `@livekit/components-react@2.9.24`, all already listed in PLAN.md.
- **Needs approval:** `tslib` (a required peer of components-react).

## Risks

1. **Container → host webhooks** (host firewall, `host-gateway`) and the shared container serving two servers. Handled by the spike first, ignoring foreign rooms, idempotent handling and the reconcile loop, with the fast interval in e2e.
2. **Flaky media assertions.** Fake devices plus the autoplay flag, byte counters polled with `expect.poll` rather than audio analysis, one worker, and a reset that deletes this test DB's rooms.
3. **LAN profile trust and firewall friction:** installing the certificate on phones (iOS full-trust step), wss certificate errors that can't be clicked through, and an active host firewall. Handled by the checklist in `docs/DEPLOY.md`, the script's firewall warning, and the automated same-machine LAN-IP check that proves the server side before any device is involved.
4. **State drift** from out-of-order webhooks when switching channels. Handled by sid-keyed participants, event-id dedupe, and the boot plus periodic reconcile.
