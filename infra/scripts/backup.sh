#!/usr/bin/env bash
# Hearth backups: `pg_dump -Fc` + a tarball of the uploads volume into data/backups/<name>/. Each backup holds
# hearth.dump, uploads.tar.gz, counts.txt (rows per table, read from the dump itself, so it describes exactly the
# dumped snapshot) and SHA256SUMS.
#
# Names and retention:
#   <UTC>                          nightly (and manual) backups; the newest BACKUP_KEEP (7) are kept
#   pre-deploy-<sha>-<UTC>         made by deploy.sh before an update; the newest BACKUP_KEEP_EXTRA (3) are kept
#   pre-restore-<UTC>              made by restore.sh before a restore; the newest BACKUP_KEEP_EXTRA (3) are kept
#
# On the host (repo root, stack running):   infra/scripts/backup.sh          # one backup now, via the sidecar
# Inside the `backup` sidecar (docker-compose.prod.yml mounts infra/scripts at /scripts):
#   --schedule                         a backup every day at BACKUP_AT (UTC, HH:MM); the sidecar's entrypoint
#   --run [--prefix P] [--protect N]   one backup now, named P<UTC>; pruning never deletes backup N
#   --counts                           rows per table in the live database (restore.sh compares them)
set -euo pipefail

# ----------------------------------------------------------------------------------------------------------------
# Host side: delegate to the sidecar, which has pg_dump 17 and the uploads volume mounted read-only.
if [[ "${HEARTH_BACKUP_SIDECAR:-}" != 1 ]]; then
  cd "$(dirname "$0")/../.."
  [[ -f .env.prod ]] || { echo ".env.prod not found; run infra/scripts/gen-secrets.sh first." >&2; exit 1; }
  compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
  if [[ -z "$("${compose[@]}" ps -q --status running backup 2>/dev/null)" ]]; then
    echo "The backup sidecar isn't running. Start the stack first: ${compose[*]} up -d --wait" >&2
    exit 1
  fi
  (($# > 0)) || set -- --run
  exec "${compose[@]}" exec -T backup bash /scripts/backup.sh "$@"
fi

# ----------------------------------------------------------------------------------------------------------------
# Sidecar side. PGHOST/PGUSER/PGPASSWORD/PGDATABASE come from the compose file.
BACKUP_ROOT=/backups
UPLOADS=/uploads
KEEP="${BACKUP_KEEP:-7}"
KEEP_EXTRA="${BACKUP_KEEP_EXTRA:-3}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
AT="${BACKUP_AT:-03:30}"
HEARTBEAT=/tmp/hearth-backup.heartbeat
TS_RE='[0-9]{8}T[0-9]{6}Z'

log() { echo "[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

for var in KEEP KEEP_EXTRA MIN_FREE_MB; do
  [[ "${!var}" =~ ^[0-9]+$ && "${!var}" -ge 1 ]] || { log "$var must be a positive integer, got '${!var}'"; exit 2; }
done
[[ "$AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { log "BACKUP_AT must be HH:MM (UTC), got '$AT'"; exit 2; }

row_counts() {
  # One "table count" line per base table in the public schema, sorted by name.
  psql -X -v ON_ERROR_STOP=1 -At -c "
    select format('select %L || '' '' || count(*) from %I.%I;', table_name, table_schema, table_name)
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name" | psql -X -v ON_ERROR_STOP=1 -At | sort
}

dump_counts() {
  # Rows per public table inside a dump (COPY blocks: one line per row, ended by "\."), same format as row_counts.
  pg_restore --data-only -f - "$1" | awk '
    /^COPY public\./ { name = $2; sub(/^public\./, "", name); gsub(/"/, "", name); rows = 0; inside = 1; next }
    inside && $0 == "\\." { print name, rows; inside = 0; next }
    inside { rows++ }' | sort
}

check_space() {
  local db_bytes uploads_kb need_kb floor_kb free_kb
  db_bytes="$(psql -X -At -v ON_ERROR_STOP=1 -c 'select pg_database_size(current_database())')"
  uploads_kb="$(du -sk "$UPLOADS" | cut -f1)"
  need_kb=$(((db_bytes / 1024 + uploads_kb) * 3 / 2))
  floor_kb=$((MIN_FREE_MB * 1024))
  ((need_kb >= floor_kb)) || need_kb=$floor_kb
  free_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 { print $4 }')"
  if ((free_kb < need_kb)); then
    log "NOT ENOUGH DISK SPACE: $((free_kb / 1024)) MB free, need $((need_kb / 1024)) MB (1.5 x (database $((db_bytes / 1048576)) MB + uploads $((uploads_kb / 1024)) MB), at least BACKUP_MIN_FREE_MB=$MIN_FREE_MB). Backup skipped. Free space: docker image prune -f; delete old data/backups/pre-* directories."
    exit 1
  fi
}

run_backup() {
  local prefix="$1" protect="$2"
  local name dir owner attempt
  name="${prefix}$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$BACKUP_ROOT/$name"
  work="$BACKUP_ROOT/.$name.partial" # global: the EXIT trap below runs after this function returns
  [[ ! -e "$dir" ]] || { log "$dir already exists"; exit 1; }

  check_space
  umask 077
  rm -rf "$work"
  # Only ever called as its own process (`--run`), so set -e holds and this trap removes a failed attempt.
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$work"

  log "dumping database $PGDATABASE ..."
  pg_dump -Fc -f "$work/hearth.dump"
  dump_counts "$work/hearth.dump" >"$work/counts.txt"

  log "archiving uploads ..."
  # tmp/ holds in-flight uploads only. The upload GC may delete a file while tar reads the tree; retry then.
  for attempt in 1 2 3; do
    if tar -czf "$work/uploads.tar.gz" -C "$UPLOADS" --exclude ./tmp .; then break; fi
    ((attempt < 3)) || { log "archiving the uploads failed 3 times"; exit 1; }
    log "tar failed (a file changed or vanished, e.g. upload GC); retrying in 5 s"
    sleep 5
  done

  (cd "$work" && sha256sum hearth.dump uploads.tar.gz counts.txt >SHA256SUMS)
  mv "$work" "$dir"
  trap - EXIT

  # Hand the files to the owner of data/backups on the host, so they can be copied off without sudo.
  owner="$(stat -c %u:%g "$BACKUP_ROOT")"
  chown -R "$owner" "$dir"

  log "done: data/backups/$name"
  (cd "$dir" && du -h hearth.dump uploads.tar.gz | sed 's/^/  /')
  prune_group "^$TS_RE\$" "$KEEP" "$protect"
  prune_group "^pre-deploy-[0-9a-f]+-$TS_RE\$" "$KEEP_EXTRA" "$protect"
  prune_group "^pre-restore-$TS_RE\$" "$KEEP_EXTRA" "$protect"
  # Leftovers of interrupted runs (older than 12 h, so a running backup is never touched).
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.*.partial' -mmin +720 -exec rm -rf {} \; 2>/dev/null || true
  log "total: $(du -sh "$BACKUP_ROOT" | cut -f1) in data/backups"
}

# prune_group <name regex> <keep> <protected name>: delete all but the newest <keep> (by the trailing UTC stamp).
prune_group() {
  local re="$1" keep="$2" protect="$3" path name names=() old
  for path in "$BACKUP_ROOT"/*/; do
    name="$(basename "$path")"
    if [[ "$name" =~ $re ]]; then names+=("$name"); fi
  done
  ((${#names[@]} > keep)) || return 0
  old="$(printf '%s\n' "${names[@]}" | awk '{ print substr($0, length($0) - 15), $0 }' | sort -r | awk -v keep="$keep" 'NR > keep { print $2 }')"
  for name in $old; do
    [[ "$name" != "$protect" ]] || continue
    log "pruning data/backups/$name (keeping the newest $keep of its kind)"
    rm -rf "${BACKUP_ROOT:?}/$name"
  done
}

schedule() {
  local last='' today hb
  # Heartbeat from its own process, so the container stays healthy while a long backup runs.
  (while true; do touch "$HEARTBEAT"; sleep 30; done) &
  hb=$!
  trap 'kill "$hb" 2>/dev/null; log "stopping"; exit 0' TERM INT
  log "scheduler started: daily at $AT UTC; keeping $KEEP nightly and $KEEP_EXTRA of each pre-deploy/pre-restore kind"
  while true; do
    today="$(date -u +%F)"
    if [[ "$(date -u +%H:%M)" == "$AT" && "$last" != "$today" ]]; then
      last="$today"
      # A separate process: inside `f || ...` bash would ignore set -e, and a failed pg_dump could pass as a backup.
      bash "$0" --run || log "BACKUP FAILED (see above); next attempt tomorrow at $AT UTC, or run infra/scripts/backup.sh"
    fi
    sleep 20 &
    wait $! || true
  done
}

mode="${1:---run}"
shift || true
case "$mode" in
  --schedule) schedule ;;
  --run)
    prefix='' protect=''
    while (($# > 0)); do
      case "$1" in
        --prefix) prefix="${2:?--prefix needs a value}"; shift 2 ;;
        --protect) protect="${2:?--protect needs a backup name}"; shift 2 ;;
        *) log "unknown option $1"; exit 2 ;;
      esac
    done
    [[ "$prefix" =~ ^[a-z0-9-]*$ ]] || { log "prefix may only contain a-z, 0-9 and '-'"; exit 2; }
    run_backup "$prefix" "$protect"
    ;;
  --counts) row_counts ;;
  *) echo "usage: backup.sh [--run [--prefix P] [--protect NAME] | --schedule | --counts]" >&2; exit 2 ;;
esac
