#!/usr/bin/env bash
# One-screen health report for the production stack: /api/health, containers, disk, last backup, certificate expiry.
#   infra/scripts/status.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

[[ -f .env.prod ]] || { echo ".env.prod not found; run infra/scripts/gen-secrets.sh first." >&2; exit 1; }
compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
# Read single values; never `source` .env.prod (LIVEKIT_KEYS contains ": " and would run as a command).
env_value() { sed -n "s/^$1=//p" .env.prod | tail -n 1; }
domain="$(env_value HEARTH_DOMAIN)"
problems=0

echo "== /api/health"
if health="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/health 2>&1)"; then
  echo "  $health"
  [[ "$health" == *'"status":"ok"'* ]] || problems=$((problems + 1))
else
  echo "  NOT OK: $health"
  problems=$((problems + 1))
fi

echo
echo "== Containers"
"${compose[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
unhealthy="$("${compose[@]}" ps --format '{{.Service}} {{.Status}}' | grep -Ev '\(healthy\)' || true)"
expected=5
running="$("${compose[@]}" ps -q --status running | wc -l)"
if [[ -n "$unhealthy" || "$running" -lt "$expected" ]]; then
  echo "  Attention: $running/$expected running; not healthy: ${unhealthy:-none listed}"
  problems=$((problems + 1))
fi

echo
echo "== Disk"
df -h / | sed 's/^/  /'
avail_kb="$(df -Pk / | awk 'NR == 2 { print $4 }')"
if ((avail_kb < 5 * 1024 * 1024)); then
  echo "  Attention: less than 5 GB free. Try: docker image prune -f && docker builder prune -f"
  problems=$((problems + 1))
fi
docker system df 2>/dev/null | sed 's/^/  /' || true

echo
echo "== Backups (data/backups)"
nightly=()
for path in data/backups/*/; do
  name="$(basename "$path")"
  if [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then nightly+=("$name"); fi
done
latest="$(printf '%s\n' "${nightly[@]}" | sort | tail -n 1)"
if [[ -z "$latest" ]]; then
  echo "  No nightly backup yet. Make one now: infra/scripts/backup.sh"
else
  when="$(echo "$latest" | sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6 UTC/')"
  age_h=$(( ($(date -u +%s) - $(date -u -d "$when" +%s)) / 3600 ))
  count="${#nightly[@]}"
  extra="$(find data/backups -mindepth 1 -maxdepth 1 -type d -name 'pre-*' | wc -l)"
  echo "  latest: $latest (${age_h} h ago), $count nightly + $extra pre-deploy/pre-restore, $(du -sh data/backups | cut -f1) in total"
  if ((age_h > 26)); then
    echo "  Attention: the last backup is older than a day. Check: ${compose[*]} logs backup"
    problems=$((problems + 1))
  fi
fi

if [[ -n "$domain" ]] && command -v openssl >/dev/null; then
  echo
  echo "== Certificates"
  for host in "$domain" "lk.$domain"; do
    end="$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$host" 2>/dev/null |
      openssl x509 -noout -enddate -issuer 2>/dev/null | tr '\n' ' ' || true)"
    echo "  $host: ${end:-no certificate served (yet)}"
  done
fi

echo
if ((problems > 0)); then
  echo "$problems item(s) need attention."
  exit 1
fi
echo "All good."
