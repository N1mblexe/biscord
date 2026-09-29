# Hearth — Deploy and test environments

- [LAN testing](#lan-testing-voice-with-devices-on-the-same-wi-fi): voice between devices on your own network.
- [Production on Oracle Cloud](#production-on-oracle-cloud): one Always Free VM, HTTPS on a DuckDNS name.

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

## Production on Oracle Cloud

Hearth runs on one Oracle Cloud **Always Free** VM (Ampere A1, arm64, Ubuntu 24.04) with Docker Compose:

| Container  | What it does                                                                                              | Reachable from                                  |
| ---------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `caddy`    | HTTPS (Let's Encrypt) for `$HEARTH_DOMAIN` and `lk.$HEARTH_DOMAIN`, serves the app, proxies the API       | Internet: 80/tcp, 443/tcp, 443/udp              |
| `server`   | Fastify + Socket.IO; runs the DB migrations on start                                                      | `127.0.0.1:3000` only (Caddy, LiveKit webhooks) |
| `postgres` | the database                                                                                              | the compose network only                        |
| `livekit`  | voice/video (host networking); signalling on :7880 is proxied by Caddy                                    | Internet: 7881/tcp, 50000–50100/udp, 3478/udp   |
| `backup`   | nightly `pg_dump` + uploads tarball into `~/hearth/data/backups`, keeps 7 (+3 pre-deploy, +3 pre-restore) | nothing                                         |

Files: `docker-compose.prod.yml`, `infra/caddy/Caddyfile.prod`, `infra/livekit/livekit.prod.yaml`, and
`infra/scripts/{gen-secrets,backup,restore,status,deploy}.sh`. Secrets live only in `~/hearth/.env.prod` on the VM.

In the commands below, replace:

- `<name>`: your DuckDNS name, so the app is `https://<name>.duckdns.org` and LiveKit `wss://lk.<name>.duckdns.org`;
- `<ip>`: the VM's reserved public IP;
- `<you@example.com>`: the email Let's Encrypt sends expiry warnings to.

### 1. Create the Oracle Cloud VM

1. **Account.** Sign up at <https://www.oracle.com/cloud/free/>. The **home region** can't be changed later and Ampere capacity differs by region; pick one near your friends. A card is needed for identity checks; Always Free resources are not charged.
2. **Upgrade to Pay-As-You-Go (recommended).** Billing & Cost Management → Upgrade and Manage Payment → **Pay As You Go**. The Always Free resources used here (2 OCPU / 12 GB A1, 100 GB disk, one reserved IP) stay free, but on a Free Tier account Oracle **reclaims idle instances**: an A1 VM whose CPU, network and memory use all stay under 20% (95th percentile) over 7 days counts as idle, and a chat for a few friends easily is. Pay-As-You-Go accounts are exempt. Set a budget alert (Billing → Budgets, e.g. 1 USD) so any accidental paid resource is noticed. If you stay on Free Tier, the downloaded backups (step 9) are your only safety net.
3. **Network.** Console → Networking → Virtual Cloud Networks → **Start VCN Wizard** → "Create VCN with Internet Connectivity". Keep the defaults (VCN `10.0.0.0/16`, public subnet `10.0.0.0/24`).
4. **Instance.** Console → Compute → Instances → **Create instance**:
   - Name: `hearth`.
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for Ampere).
   - Shape: Ampere → **VM.Standard.A1.Flex**, **2 OCPUs, 12 GB** memory.
   - Networking: the VCN and **public subnet** from step 3, with "Assign a public IPv4 address" on.
   - SSH keys: upload your public key (`~/.ssh/id_ed25519.pub`).
   - Boot volume: set the size to **100 GB** (Always Free includes 200 GB of block storage; the default ~47 GB fills up with Docker images and backups).
   - "Out of capacity" is common for A1: try another availability domain, or retry later.
5. **Reserve the public IP** so it never changes:
   1. Networking → IP Management → Reserved Public IPs → **Reserve public IP address** (name `hearth`).
   2. Instance → Attached VNICs → the primary VNIC → IPv4 Addresses → the primary private IP → ⋮ → **Edit**: choose "No public IP" and save, then Edit again, choose **Reserved public IP** and pick `hearth`.
   3. Note the address: that's `<ip>`.
6. **Log in:** `ssh ubuntu@<ip>`.

### 2. DuckDNS name

1. Sign in at <https://www.duckdns.org>, add the sub-domain `<name>` and set its **current ip** to `<ip>` (the IP is reserved, so no updater cron is needed).
2. DuckDNS answers for every name below yours, so `lk.<name>.duckdns.org` already points at the same IP. Check from your PC:

   ```bash
   dig +short <name>.duckdns.org      # → <ip>
   dig +short lk.<name>.duckdns.org   # → <ip>
   ```

### 3. Open the firewall (both layers)

Oracle filters traffic twice: the VCN **security list** and the VM's own **iptables**. A port must be open in both.
Port 7880 (LiveKit signalling), 3000 (server) and 5432 (Postgres) are **never** opened.

**3a. Security list.** Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List →
**Add Ingress Rules**, stateful, source CIDR `0.0.0.0/0`, one rule per line:

| Protocol | Destination port | Purpose                                  |
| -------- | ---------------- | ---------------------------------------- |
| TCP      | 80               | HTTP → HTTPS redirect, Let's Encrypt     |
| TCP      | 443              | the app and LiveKit signalling (wss)     |
| UDP      | 443              | HTTP/3 (optional)                        |
| TCP      | 7881             | media over TCP (networks that block UDP) |
| UDP      | 50000-50100      | media                                    |
| UDP      | 3478             | TURN                                     |

Then edit the existing **TCP 22** rule: change its source from `0.0.0.0/0` to `<your home IP>/32`. Home IPs change;
if you're locked out later, set the source of that rule to your new IP (or temporarily `0.0.0.0/0`) in the same
console page. The instance's **Console connection** (Cloud Shell) also works without SSH access.

**3b. VM iptables.** Do this **before installing Docker** (so `netfilter-persistent save` doesn't capture Docker's
own rules). Oracle's Ubuntu image ends the `INPUT` chain with a `REJECT` rule, so new rules must be inserted before
it, never appended. Don't use `ufw`.

```bash
sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
n=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }'); echo "REJECT is rule $n"
sudo iptables -I INPUT "$n" -p tcp -m state --state NEW -m multiport --dports 80,443,7881 -j ACCEPT
sudo iptables -I INPUT "$n" -p udp -m multiport --dports 443,3478 -j ACCEPT
sudo iptables -I INPUT "$n" -p udp --dport 50000:50100 -j ACCEPT
# Caddy and the server reach LiveKit's signalling port on the prod network's gateway only. The bridge name
# hearth-prod0 is fixed in docker-compose.prod.yml; the interface doesn't exist yet, which iptables accepts.
sudo iptables -I INPUT "$n" -i hearth-prod0 -s 172.29.0.0/24 -d 172.29.0.1 -p tcp --dport 7880 -j ACCEPT
sudo iptables -L INPUT --line-numbers -n     # the new rules must be above REJECT
sudo netfilter-persistent save
grep -E 'dports|dport' /etc/iptables/rules.v4
sudo reboot
```

After the reboot, `ssh` back in and run `sudo iptables -L INPUT -n --line-numbers` again: the rules must still be
there, above `REJECT`.

### 4. Install Docker and tools

```bash
sudo apt-get install -y ca-certificates curl git openssl netcat-openbsd
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
exit   # log out and back in so the docker group applies
```

Back in: `docker version && docker compose version` must work without `sudo`.

### 5. Get the code and generate secrets

If the repository is private, give the VM a read-only deploy key: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519`,
then add `~/.ssh/id_ed25519.pub` on GitHub → the repo → Settings → Deploy keys (leave "write access" off).

```bash
git clone git@github.com:<owner>/<repo>.git ~/hearth     # or the https URL for a public repo
cd ~/hearth
infra/scripts/gen-secrets.sh --domain <name>.duckdns.org --email <you@example.com> --node-ip <ip>
ls -l .env.prod        # -rw------- : readable by you only; never commit or paste it
echo "alias hc='docker compose -f $HOME/hearth/docker-compose.prod.yml --env-file $HOME/hearth/.env.prod'" >> ~/.bashrc
source ~/.bashrc
```

`gen-secrets.sh` writes `.env.prod` (mode 600) with random `POSTGRES_PASSWORD` and `LIVEKIT_API_SECRET` (never
printed). It refuses to overwrite an existing file unless you pass `--force`. `--node-ip` stores the reserved IP as
`NODE_IP`, so LiveKit advertises it directly instead of asking a STUN server at every start (leave it out to use
STUN). `hc` is a shortcut for
`docker compose` with the production files. **Every compose command needs `--env-file .env.prod`** (or `hc`);
without it, compose stops with "required variable … is missing".

### 6. Build and start

```bash
cd ~/hearth
hc build                 # builds the arm64 images on the VM (several minutes the first time)
hc up -d --wait          # starts everything and waits until all containers are healthy
infra/scripts/status.sh
```

Caddy gets the certificates within a minute of the first start (watch with `hc logs -f caddy`). If it can't, check
DNS (step 2) and port 80 (step 3); Caddy keeps retrying on its own.

### 7. Bootstrap the first admin

```bash
hc exec server node dist/cli/bootstrap.js
```

Open the printed `https://<name>.duckdns.org/register?invite=…` link within 24 h and create the admin account.
Invite friends from the admin page.

### 8. Verify

From your PC (not the VM):

```bash
curl -sI https://<name>.duckdns.org | grep -iE '^(HTTP|strict-transport|content-security|x-content-type)'
curl -s https://<name>.duckdns.org/api/health        # {"status":"ok","db":"ok","livekit":"ok"}
curl -s https://lk.<name>.duckdns.org; echo          # OK (LiveKit behind Caddy)
nc -vz -w 5 <ip> 7881                                # succeeded
nc -vz -w 5 <ip> 7880; nc -vz -w 5 <ip> 3000; nc -vz -w 5 <ip> 5432   # all three must FAIL
```

**LiveKit connection test** (checks UDP, TCP and TURN from your network):

```bash
hc exec server node dist/cli/livekit-test-token.js
```

Open <https://livekit.io/connection-test>, paste the URL (`wss://lk.<name>.duckdns.org`) and the token (valid for
10 minutes). Run it from a PC and from a phone on **mobile data**. UDP and TCP must pass.

Then the real test: two devices on different networks (one on mobile data) chat, talk both ways, turn on the camera
and share a screen. While the call runs, `docker stats --no-stream` on the VM should stay well under 50% CPU.

### 9. Backups

**Backups live on the VM only, on the same disk as the database.** If the VM is lost (reclaimed, deleted, disk
failure), so are they. **Copy them to your PC every week**, and before every update. From your PC:

```bash
rsync -av ubuntu@<ip>:hearth/data/backups/ ~/hearth-backups/     # copies only what's new; keeps old copies
# no rsync (Windows): scp -r ubuntu@<ip>:hearth/data/backups ./hearth-backups-$(date +%F)
```

A reminder in your calendar (for example every Sunday) is enough. The files contain password hashes and all
messages: keep them private.

- The `backup` container makes one every day at 03:30 UTC (`BACKUP_AT` in `.env.prod`) into `~/hearth/data/backups/<UTC timestamp>/`: `hearth.dump` (`pg_dump -Fc`), `uploads.tar.gz` (without the `tmp/` folder of in-flight uploads), `counts.txt` (rows per table, read from the dump itself) and `SHA256SUMS`.
- Retention: the newest 7 nightly backups (`BACKUP_KEEP`), plus the newest 3 `pre-deploy-*` and 3 `pre-restore-*` backups (`BACKUP_KEEP_EXTRA`), so updates and restores never push nightly backups out.
- **Disk guard:** a backup is skipped, with a `NOT ENOUGH DISK SPACE` log line, unless at least max(1.5 × (database + uploads), `BACKUP_MIN_FREE_MB` = 2 GB) is free, so backups can't fill the disk Postgres writes to. `status.sh` flags a missing nightly backup.
- Each backup holds a full copy of the uploads. That is fine for a group of friends (tens of MB to a few GB); if the uploads grow large, lower `BACKUP_KEEP` or move old backups off the VM.
- Backup now: `infra/scripts/backup.sh`. Logs: `hc logs backup`.
- `.env.prod` is not part of the backups. Losing it is not fatal: a restore into a fresh database works with newly generated secrets.

### 10. Restore (and the restore drill)

```bash
infra/scripts/restore.sh data/backups/<UTC timestamp>
```

It verifies the checksums, asks you to type `RESTORE`, saves the current state as `data/backups/pre-restore-<UTC>`
(the newest 3 are kept), stops the server, recreates the database from `hearth.dump`, replaces the
uploads, starts everything, waits for `/api/health`, and compares the row counts with the backup's `counts.txt`.
A backup downloaded elsewhere must first be copied into `data/backups/`. Everything written after the backup is
lost. If a step fails, the script prints the exact command to put the pre-restore state back.

**Drill** (do it once after the first deploy, in a quiet moment; the app is down for a minute or two):

```bash
infra/scripts/backup.sh
hc down
docker volume rm hearth-prod_pgdata hearth-prod_uploads      # the data is gone now
infra/scripts/restore.sh data/backups/<the backup just made> --no-safety-backup
```

Then log in and check that users, messages and attachments are back. Prefer removing the two data volumes as
above over `hc down -v`: that also deletes `caddy_data`, and re-issuing certificates repeatedly can hit Let's
Encrypt's limit of 5 identical certificates per week.

### 11. Updates and rollback

```bash
cd ~/hearth
infra/scripts/deploy.sh
```

`deploy.sh` refuses if tracked files have local changes, then:

1. backs up the running version as `data/backups/pre-deploy-<commit>-<UTC>` (if the backup fails, nothing is changed);
2. `git pull --ff-only`, `hc build --pull`, `hc up -d --wait` (migrations run when the server starts);
3. recreates `caddy`, `livekit` and `backup` when anything under `infra/` or `docker-compose.prod.yml` changed (they only read their config at start);
4. tags the deployed commit `deploy-YYYYMMDD` (`-2`, `-3` … for more on the same day), prunes old images, runs `status.sh`;
5. prints the pre-deploy backup's exact name and the two rollback commands.

**Rollback.** Code only (the release changed no database schema):

```bash
git tag -l 'deploy-*'                                  # every version that ran here
infra/scripts/deploy.sh --ref deploy-20261001           # checks out that tag (detached) and redeploys
```

Code **and** data, when the release you're leaving changed the database (a new migration): run the two commands
`deploy.sh` printed at the end of that deploy, in that order, for example:

```bash
infra/scripts/deploy.sh --ref deploy-20261001
infra/scripts/restore.sh data/backups/pre-deploy-1a2b3c4d-20261008T190000Z
```

Use exactly that `pre-deploy-*` directory (`ls data/backups`), not a nightly one. **Restoring it loses everything
written since that backup** (messages, uploads, new accounts). To go forward again later:
`git switch main && infra/scripts/deploy.sh`.

### 12. Routine checks

- `infra/scripts/status.sh`: `/api/health`, container health, disk space, last backup age, certificate expiry. It exits non-zero when something needs attention.
- Logs: `hc logs --since 1h server` (each container keeps at most 3 × 10 MB of logs).
- Reboot test: `sudo reboot`, wait a minute, then `infra/scripts/status.sh`. Every container has `restart: unless-stopped` and comes back on its own.
- **Weekly:** copy the backups to your PC (step 9).
- **Idle reclamation:** on a Free Tier account, Oracle reclaims an A1 VM whose CPU, network and memory use all stay under 20% (95th percentile) over 7 days. An idle friends' chat meets that easily, so **upgrade to Pay-As-You-Go** (step 1.2; the resources stay free). Until then, your PC's copy of the backups is the only thing that survives a reclamation.

### 13. Troubleshooting

- **Certificate errors / Caddy logs `challenge failed`:** DNS doesn't point at `<ip>` yet, or TCP 80 is closed in one of the two firewall layers. Fix it; Caddy retries by itself (`hc logs -f caddy`).
- **The page works but voice never connects:** check `https://lk.<name>.duckdns.org` answers (step 8) and `hc logs livekit`. If LiveKit restarts with "cannot assign requested address" on `172.29.0.1`, the compose network is missing: `hc up -d` creates it.
- **Voice connects but no audio / the connection test fails UDP:** UDP 50000–50100 is closed in one of the two layers. Check both. TCP 7881 is the fallback when UDP is blocked.
- **The connection test fails only TURN:** expected, and harmless. TURN/UDP may simply not work on Oracle: its relay reaches LiveKit through the VM's own public IP, which needs Oracle's NAT to loop traffic back to the VM. It also adds little here, because LiveKit already has a public IP (direct UDP) and ICE/TCP on 7881 covers networks that block UDP. Only a network that allows nothing but TLS on 443 would need TURN/TLS, which is not set up in v1.
- **LiveKit advertises the wrong IP:** with `NODE_IP` set, `hc logs livekit | grep NAT1To1` shows `using explicit node IP` with `<ip>`. Without it, `hc logs livekit | grep "using external IPs"` must show `<ip>/10.0.0.x` (the public IP mapped to the VM's VCN address). `livekit.prod.yaml` excludes Docker's bridge ranges (`rtc.ips.excludes`); if your VCN uses 172.16.0.0/12 or 192.168.0.0/16, replace that with `ips: {includes: [<subnet CIDR>]}`. Then `hc up -d --force-recreate livekit`.
- **A config change under `infra/` isn't picked up:** `deploy.sh` recreates the affected containers; after a manual edit run `hc up -d --force-recreate caddy livekit backup`.
- **Changing firewall rules later:** insert the rule live with `sudo iptables -I INPUT <n> …` as in step 3b, and add the same line to `/etc/iptables/rules.v4` by hand. Don't run `netfilter-persistent save` or `iptables-restore` while Docker runs: the first saves Docker's rules into the file, the second wipes Docker's live rules.
- **Disk full** (uploads refused with "The server is out of storage space", or `NOT ENOUGH DISK SPACE` in `hc logs backup`): `docker image prune -f && docker builder prune -f`, remove old `pre-*` backups after copying them to your PC, check `df -h /`.
- **`required variable … is missing`:** you ran `docker compose` without `--env-file .env.prod`; use `hc`.
- **Changed `POSTGRES_PASSWORD` in `.env.prod`:** Postgres only reads it when the volume is first created. Put the old value back (see `.env.prod.bak-*`), or set the new one inside without it landing in your shell history: `hc exec postgres psql -U hearth`, then type `\password hearth`, paste the new value twice, and `\q`.
