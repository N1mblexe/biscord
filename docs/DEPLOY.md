# Hearth — Deploy and test environments

Phase 9 extends this file with the production deployment on Oracle Cloud. This section covers testing on your own
network before that.

## LAN testing (voice with devices on the same Wi-Fi)

Use this to try voice, camera and screen share between this PC and a phone or laptop in the same house. It runs
the full stack with HTTPS from Caddy's own local certificate authority. **Only use it on a trusted home network.**
The CA's private key lives in the `caddy_data` Docker volume.

### Why it's needed

- **Browsers block the mic without HTTPS.** They only allow `getUserMedia` on `https://` or `localhost`, so another device opening `http://<your-ip>:8080` gets no microphone.
- **The normal LiveKit config only works on this machine.** It advertises `127.0.0.1`, which other devices can't reach. The LAN profile advertises your LAN IP instead.

### Start and stop

```bash
pnpm lan:up        # detects your LAN IP; override with LAN_IP=192.168.1.20 pnpm lan:up
pnpm lan:down      # stops everything, including Postgres and LiveKit; run `pnpm infra:up` afterwards for dev
```

`pnpm lan:up` prints:

- the app URL, `https://<LAN_IP>:8443`;
- the LiveKit signaling URL, `wss://<LAN_IP>:7443`;
- the root certificate path, `data/lan/hearth-lan-root.crt`;
- a first-admin invite link, if there's no admin yet.

It runs the same containers as `docker compose up --build`. Don't run it at the same time as `pnpm dev`, because both use port 3000.

### Ports

These must be reachable from the other device. `pnpm lan:up` warns you if a host firewall (firewalld, ufw or nftables) is active.

| Port | Protocol | Purpose                            |
| ---- | -------- | ---------------------------------- |
| 8443 | TCP      | The app over HTTPS                 |
| 7443 | TCP      | LiveKit signaling over wss         |
| 7881 | TCP      | Media fallback when UDP is blocked |
| 7882 | UDP      | Media                              |

### Per-device checklist

Do this once per device (and again if you delete the `caddy_data` volume, which creates a new CA).

1. **Get the certificate onto the device.** Copy `data/lan/hearth-lan-root.crt` over, for example by email to yourself, a USB cable, or a chat app.
2. **Trust it:**
   - **Android:** Settings → Security → More security settings → Install from device storage (or "Encryption & credentials") → **CA certificate**, then pick the file. Chrome trusts user-installed CAs. Firefox for Android does too only after you turn on Settings → About Firefox (tap the logo 5 times) → Secret settings → **Use third party CA certificates**.
   - **iOS / iPadOS:**
     1. Open the file and install the profile (Settings → General → VPN & Device Management).
     2. Turn on full trust: Settings → General → About → **Certificate Trust Settings**. Both steps are needed.
   - **Desktop Chrome/Edge:** Settings → Privacy and security → Security → Manage certificates → Authorities → Import. Alternatively, skip the import: open **both** `https://<LAN_IP>:8443` and `https://<LAN_IP>:7443` and accept the warning on each. The second one matters because a wss connection can't show a click-through prompt.
   - **Desktop Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, and tick "Trust this CA to identify websites".
3. **Try it:**
   1. Open `https://<LAN_IP>:8443` and register with an invite from the admin.
   2. Join the same voice channel from this PC and the device.
   3. Check that each of you hears the other, and that mute, deafen and the speaking ring work.

### Troubleshooting

- **The page loads but voice never connects:** you haven't trusted the certificate for `:7443`. Open `https://<LAN_IP>:7443` once, or install the root certificate.
- **The device can't reach the page at all:**
  - check that both devices are on the same network (guest Wi-Fi often isolates clients);
  - check the host firewall;
  - check that the IP printed by `lan:up` is the one on your Wi-Fi.
- **Voice connects but there's no audio:** UDP 7882 is blocked somewhere. LiveKit falls back to TCP 7881, so make sure that port is reachable too.
- **The IP changed (new DHCP lease):** run `pnpm lan:down` and then `pnpm lan:up` again. The certificate authority stays the same, so devices keep trusting it.
