# Phase 9 plan — Production deployment (Oracle Cloud)

Status: **approved 2026-09-29**. Hostnames with DuckDNS: the app on `{$HEARTH_DOMAIN}` (for example `myhearth.duckdns.org`) and LiveKit on `lk.{$HEARTH_DOMAIN}`; DuckDNS resolves every name under your DuckDNS name to the same IP, so one registration covers both. Reserve the VM's public IP in Oracle so it never changes. The open questions below are answered by the decisions above; VM shape: 2 OCPUs / 12 GB.. Source: PLAN.md §5 Phase 9, §6 and §7; CONTRACTS.md B.8; CLAUDE.md gotchas (HTTPS for media; LiveKit ports; OCI's two firewall layers).
Starts only after Phase 8 is committed.

## Decisions from the user (2026-09-29)

- **Domain:** a free **DuckDNS** name (for example `<name>.duckdns.org` for the app and `lk.<name>.duckdns.org` for LiveKit, or two separate DuckDNS names if a subdomain isn't available). The user creates the names on duckdns.org; the runbook includes the DNS steps.
- **VM:** **not created yet.** The runbook starts by creating an Always Free Ampere A1 VM (arm64) and its networking in the Oracle console; the user runs those steps.
- **Backups:** **on the VM only** for v1 (nightly `pg_dump` + uploads tarball, keep 7), plus a documented command to download them to a PC. No rclone.

## Goal

Hearth runs on one Oracle Cloud Always Free VM (Ampere A1, arm64, Ubuntu) behind HTTPS:

- friends on different networks, including mobile data, can chat, talk and share their screen;
- nightly backups exist, and restoring from one has been proven.

## Open questions for the user (needed before execution)

1. **Domain:** the plan assumes `hearth.<domain>` and `lk.hearth.<domain>` as A records pointing at the VM's public IP. Which domain, and who runs its DNS?
2. **Backups off the VM:** v1 keeps 7 nightly backups on the VM only (PLAN.md §1 lists off-box backups as out of scope). Accept that, or add a manual `scp` step to the runbook?
3. **VM shape:** the Always Free Ampere A1 allows up to 4 OCPUs and 24 GB. The plan assumes 2 OCPUs and 12 GB, which is plenty for 8 users.

## In scope

| Artifact                                 | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.prod.yml`                | Services:<br>• `caddy`: the web image built in P1/P8, ports 80/443 (tcp and udp for HTTP/3), volumes `caddy_data`/`caddy_config`.<br>• `server`: listens on `127.0.0.1:3000` only.<br>• `postgres`: no published port.<br>• `livekit`: `network_mode: host`.<br>• `backup`: a cron sidecar.<br>All use `restart: unless-stopped`, healthchecks, and `depends_on: condition: service_healthy`. Prod runs `HEARTH_TEST_MODE=false` and `COOKIE_SECURE=true`. |
| `infra/caddy/Caddyfile.prod`             | • `{$HEARTH_DOMAIN}`: `/api/*` and `/socket.io/*` go to `server:3000`; everything else is SPA static; `request_body max_size 26MB`; the Phase 8 security headers plus HSTS.<br>• `lk.{$HEARTH_DOMAIN}`: `reverse_proxy host.docker.internal:7880`, with websockets proxied automatically.<br>• Automatic Let's Encrypt certificates, with an email for expiry notices.                                                                                     |
| `infra/livekit/livekit.prod.yaml`        | `port: 7880`, `bind_addresses: ["127.0.0.1", "<docker bridge gateway>"]` (never exposed publicly; Caddy terminates TLS), `rtc: {tcp_port: 7881, port_range_start: 50000, port_range_end: 50100, use_external_ip: true}`, `turn: {enabled: true, udp_port: 3478}` (no TURN/TLS in v1), `room.max_participants: 25`, and the webhook to `http://127.0.0.1:3000/api/livekit/webhook`. Keys come from env.                                                     |
| Secrets                                  | `infra/scripts/gen-secrets.sh` writes `.env.prod` with `openssl rand -base64 48` for `POSTGRES_PASSWORD` and `LIVEKIT_API_SECRET` (a key name like `hearth-prod`). File mode 600; gitignored by `.env.*`.                                                                                                                                                                                                                                                  |
| `TRUST_PROXY` in prod                    | the fixed Caddy IP on the prod compose network (same `172.28.0.0/24` subnet and `172.28.0.10` pin as locally).                                                                                                                                                                                                                                                                                                                                             |
| `infra/scripts/backup.sh` / `restore.sh` | backup: `pg_dump -Fc` plus `tar` of the uploads volume into `/backups/<UTC timestamp>/`, prune to the newest 7, log the size. restore: stop `server`, `pg_restore --clean --if-exists`, untar the uploads, start `server`, verify `/api/health`.                                                                                                                                                                                                           |
| `docs/DEPLOY.md`                         | The runbook below, step by step, with copy-paste commands.                                                                                                                                                                                                                                                                                                                                                                                                 |

## Key decisions

- **Everything is Docker Compose on one VM. No Kubernetes, no managed database.**
  - Images are built **on the VM** with `docker compose -f docker-compose.prod.yml build`, avoiding cross-arch builds and a registry.
  - Every base image (node:26-alpine, postgres:17-alpine, caddy, livekit-server) is published for arm64. Step 0 of the phase checks each with `docker manifest inspect`.
- **LiveKit uses host networking.** WebRTC needs the real public IP and UDP ports, and Docker's userland proxy on a 100-port UDP range is slow and error-prone.
  - `use_external_ip: true` discovers the public IP via STUN. OCI VMs sit behind 1:1 NAT, so this is required.
  - Caddy reaches the LiveKit signalling port through `host.docker.internal:host-gateway`.
- **TURN over UDP 3478 only.** Friends on strict networks that block all UDP fall back to ICE/TCP 7881. TURN/TLS on 5349 needs its own certificate and is deferred: this is recorded as a known limitation, as accepted in Step 1, item 28.
- **Server on loopback.** Only Caddy reaches it (compose network), and LiveKit posts its webhooks to `127.0.0.1:3000` from the host network.
- **First admin:** after the first deploy, `docker compose -f docker-compose.prod.yml exec server node dist/cli/bootstrap.js` prints a one-time invite URL on the production domain.
- **Monitoring (basic):**
  - compose healthchecks restart unhealthy containers;
  - a small `infra/scripts/status.sh` prints the `/api/health` output, `docker compose ps` and disk usage;
  - logs via `docker compose logs --since 1h`, with the json-file driver capped at `max-size: 10m, max-file: 3` per service.
- **Updates:** `git pull`, then `docker compose -f docker-compose.prod.yml build`, then `up -d`. The server runs migrations on start, so there's no separate migration step. Rollback: `git checkout <previous tag>`, rebuild, `up -d`; restore from backup if a migration was destructive. Each deploy is tagged `deploy-YYYYMMDD`.
- **Idle reclamation:** Oracle reclaims Always Free A1 instances that are idle over a 7-day window (95th-percentile CPU, network and memory all under 20%). An idle friends' chat server will likely meet that, so the runbook recommends **upgrading the account to Pay-As-You-Go** (resources stay within the free tier; set a budget alert) and copying backups to a PC weekly.

## Oracle firewall runbook (both layers)

1. **VCN security list (or NSG) ingress rules**, source `0.0.0.0/0`:
   - TCP 80 and 443
   - UDP 443 (HTTP/3, optional)
   - TCP 7881
   - UDP 50000–50100
   - UDP 3478
   - Keep SSH (TCP 22) restricted to the admin's IP.
2. **VM iptables (Oracle's Ubuntu images):** the stock rules end in `INPUT … REJECT`. New rules must be **inserted before** that reject (`iptables -I INPUT <n> …`), never appended.
   - Add the same port list as step 1.
   - Persist with `sudo netfilter-persistent save`, then check `/etc/iptables/rules.v4` and reboot once to confirm the rules survive.
   - Do not use `ufw`, which fights the stock rules.
3. **Checks from outside the VM:**
   - `curl -I https://hearth.<domain>` returns 200 with HSTS.
   - `nc -vz <ip> 7881` succeeds.
   - LiveKit's connection test (https://livekit.io/connection-test with a token generated by the server CLI) shows UDP and TCP both OK.

## Execution (tech lead + subagents)

1. **Lead:** collect the answers to the open questions, then write the step-0 arm64 manifest check.
2. **Parallel:**
   - **infra agent:** the compose prod file, `Caddyfile.prod`, `livekit.prod.yaml`, the scripts and `DEPLOY.md`. Validate locally with `docker compose -f docker-compose.prod.yml config` and a **local prod-mode dry run** (Caddy on internal TLS with a `localhost` cert; LiveKit with `use_external_ip: false`).
   - **server agent:** a `livekit-token` CLI for the connection test, plus a check that `COOKIE_SECURE`/HSTS behave correctly behind TLS.
3. **Fresh reviewer**, focused on secrets, exposed ports and restore safety.
4. **The user or lead runs the deploy on the VM**, following `DEPLOY.md` (this needs SSH access, which the user provides or runs themselves with `!` commands).
5. **Acceptance run on the real VM**, then PROGRESS.md and commit `phase 9: …`.

## Acceptance tests

- **Local dry run:**
  - `docker compose -f docker-compose.prod.yml config` is valid.
  - The prod images build.
  - Caddy serves over internal TLS on localhost, and the `@smoke` specs pass against it.
  - `backup.sh` → drop the DB volume → `restore.sh` → the data is identical (row counts plus a message and attachment checksum).
- **On the VM:**
  1. `https://hearth.<domain>` loads with a valid certificate, the headers from Phase 8, and `/api/health` = ok.
  2. The first admin is bootstrapped; a friend registers from an invite.
  3. **Two devices on different networks, one on mobile data:** text chat, voice both ways, camera, and screen share viewed on the other device. The LiveKit connection test passes. While the call runs, `docker stats` stays reasonable (CPU under 50%).
  4. **Restore drill:** run a backup, `docker compose down -v` (in a maintenance window), restore, and confirm the users, messages and attachments are all back.
  5. Reboot the VM → every service comes back healthy with no manual steps (restart policies plus persistent iptables).

## Dependencies

No npm dependencies. On the VM itself (not the repo): Docker Engine plus the compose plugin, `iptables-persistent`, and `openssl`. These are system packages; they're **flagged here for approval** only because they go on the user's server.

## Risks

1. **UDP/NAT on OCI (two firewall layers, 1:1 NAT).** Guarded by the runbook, `use_external_ip`, the connection test, and a mobile-data acceptance test.
2. **Certificate issuance failing** (DNS not propagated, port 80 blocked). Guarded by checking DNS and port 80 before the first `up`; Caddy retries automatically.
3. **Data loss** (reclamation, disk failure, a bad migration). Guarded by nightly backups, a tested restore drill and deploy tags. Off-box copies are an open question for the user.

## References

- LiveKit ports and firewall: https://docs.livekit.io/home/self-hosting/ports-firewall/
- Oracle: enabling network traffic to Ubuntu images: https://blogs.oracle.com/developers/enabling-network-traffic-to-ubuntu-images-in-oracle-cloud-infrastructure
- Opening ports on OCI (both layers): https://jc-lan.org/2026/03/22/opening-port-443-https-and-port-80-http-on-oracle-cloud-infrastructure-oci/
