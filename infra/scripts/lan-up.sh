#!/usr/bin/env bash
# Start Hearth for testing on the local network: https://<LAN_IP>:8443 (see docs/DEPLOY.md → LAN testing).
# Override the detected address with: LAN_IP=192.168.1.20 pnpm lan:up
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ -z "${LAN_IP:-}" ]]; then
  # `|| true`: with no default route `ip` fails, and set -e would exit before the friendly message below.
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
fi
if [[ -z "${LAN_IP:-}" ]]; then
  echo "Could not detect this machine's LAN IP. Run again with LAN_IP=<address> pnpm lan:up" >&2
  exit 1
fi
export LAN_IP

compose=(docker compose -f docker-compose.yml -f docker-compose.lan.yml)
# Remember the current Hearth images; the rebuild leaves them untagged (removed below).
old_images="$(docker images -q hearth-server hearth-web 2>/dev/null || true)"
echo "Starting Hearth LAN profile on ${LAN_IP} ..."
"${compose[@]}" build web
# Caddy runs unprivileged (Phase 8). A caddy_data volume created by an older root image keeps root ownership;
# re-own it so the existing local CA (already trusted on your devices) keeps working.
"${compose[@]}" run --rm --no-deps --user root --entrypoint chown web -R caddy:caddy /data /config >/dev/null
"${compose[@]}" up --build -d --wait

# Caddy creates its local CA on first start; wait for the root certificate, then export it.
mkdir -p data/lan
cert=data/lan/hearth-lan-root.crt
rm -f "$cert" # never report a stale certificate from an earlier CA
for _ in $(seq 1 30); do
  if "${compose[@]}" cp web:/data/caddy/pki/authorities/local/root.crt "$cert" >/dev/null 2>&1; then break; fi
  sleep 1
done
[[ -s "$cert" ]] || { echo "Caddy's root certificate did not appear; check: ${compose[*]} logs web" >&2; exit 1; }

# The previous Hearth images are untagged now and fill the small root partition (see CLAUDE.md → Disk space).
# Remove exactly those; `docker rmi` refuses any that are still tagged or in use.
for id in $old_images; do docker rmi "$id" >/dev/null 2>&1 || true; done

echo
echo "App:               https://${LAN_IP}:8443"
echo "LiveKit signaling: wss://${LAN_IP}:7443  (open https://${LAN_IP}:7443 once in each browser, or install the certificate)"
echo "Root certificate:  ${cert}  (install it on each device; steps in docs/DEPLOY.md → LAN testing)"
echo
echo "First admin invite (skipped if an admin already exists):"
"${compose[@]}" exec -T server node dist/cli/bootstrap.js || true

active=()
for svc in firewalld ufw nftables; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then active+=("$svc"); fi
done
if (( ${#active[@]} > 0 )); then
  echo
  echo "Warning: host firewall active (${active[*]}). Allow from the LAN: 8443/tcp, 7443/tcp, 7881/tcp, 7882/udp."
fi
