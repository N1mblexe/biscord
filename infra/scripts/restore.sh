#!/usr/bin/env bash
# Restore a backup made by backup.sh. DESTRUCTIVE: the database and the uploads are replaced by the backup's, so
# everything written since that backup is lost (except in the pre-restore backup made first).
#
#   infra/scripts/restore.sh data/backups/20261001T033000Z
#   infra/scripts/restore.sh 20261001T033000Z --yes           # no confirmation prompt
#   infra/scripts/restore.sh <dir> --no-safety-backup          # skip the pre-restore backup of the current state
#
# The backup must be inside data/backups/ (copy a downloaded one there first). Steps: verify checksums → start
# postgres + the backup sidecar → back up the current state as data/backups/pre-restore-<UTC> → stop the server →
# recreate the database and pg_restore → replace the uploads → start everything → wait for /api/health (db ok) →
# compare row counts with the backup's counts.txt.
set -euo pipefail
cd "$(dirname "$0")/../.."

compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
yes=false
safety=true
target=''
while (($# > 0)); do
  case "$1" in
    --yes | -y) yes=true ;;
    --no-safety-backup) safety=false ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) [[ -z "$target" ]] || { echo "Only one backup directory, please." >&2; exit 2; }; target="$1" ;;
  esac
  shift
done
[[ -n "$target" ]] || { echo "usage: infra/scripts/restore.sh <data/backups/<name>> [--yes] [--no-safety-backup]" >&2; exit 2; }
[[ -f .env.prod ]] || { echo ".env.prod not found; run infra/scripts/gen-secrets.sh first." >&2; exit 1; }

# Accept "data/backups/<name>", "<name>" or an absolute path, but only inside data/backups (the sidecar's /backups).
[[ -d "$target" ]] || target="data/backups/$target"
[[ -d "$target" ]] || { echo "No such backup directory: $target" >&2; exit 1; }
root="$(realpath data/backups)"
dir="$(realpath "$target")"
[[ "$(dirname "$dir")" == "$root" ]] || { echo "The backup must be directly inside data/backups/ (got $dir)." >&2; exit 1; }
name="$(basename "$dir")"
for f in hearth.dump uploads.tar.gz SHA256SUMS; do
  [[ -s "$dir/$f" ]] || { echo "Missing or empty: $dir/$f" >&2; exit 1; }
done
echo "Verifying checksums of $name ..."
(cd "$dir" && sha256sum --quiet -c SHA256SUMS) || { echo "Checksum mismatch: this backup is damaged." >&2; exit 1; }

echo
echo "This REPLACES the production database and all uploads with backup $name:"
(cd "$dir" && du -h hearth.dump uploads.tar.gz | sed 's/^/  /')
echo "Everything written after that backup is lost. The app is unavailable (502) until the restore finishes."
if [[ "$yes" != true ]]; then
  read -r -p "Type RESTORE to continue: " answer
  [[ "$answer" == RESTORE ]] || { echo "Aborted; nothing changed."; exit 1; }
fi

echo "Starting postgres and the backup sidecar ..."
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d --no-deps backup
exec_backup=("${compose[@]}" exec -T backup)

safety_name=''
if [[ "$safety" == true ]]; then
  echo "Backing up the current state first ..."
  # --protect: this run's pruning must never delete the backup being restored (it may itself be a pre-restore-*).
  # tee into a temp file, not /dev/stderr: reopening a redirected log file would truncate it.
  backup_log="$(mktemp)"
  "${exec_backup[@]}" bash /scripts/backup.sh --run --prefix pre-restore- --protect "$name" | tee "$backup_log"
  safety_name="$(sed -n 's#.*done: data/backups/##p' "$backup_log" | tail -n 1)"
  rm -f "$backup_log"
  [[ -n "$safety_name" ]] || { echo "Could not determine the safety backup's name; aborting before any change." >&2; exit 1; }
fi

# From here on the data changes. On any failure, say exactly how to get back.
step='starting'
on_error() {
  echo >&2
  echo "RESTORE FAILED while $step (line $1). The server may be stopped." >&2
  if [[ -n "$safety_name" ]]; then
    echo "The state from before this restore is in data/backups/$safety_name. To put it back:" >&2
    echo "  infra/scripts/restore.sh data/backups/$safety_name --yes --no-safety-backup" >&2
  else
    echo "No safety backup was made (--no-safety-backup)." >&2
  fi
  echo "To retry this restore: infra/scripts/restore.sh data/backups/$name --yes --no-safety-backup" >&2
  echo "Logs: ${compose[*]} logs --since 10m server postgres" >&2
}
trap 'on_error $LINENO' ERR

step='stopping the server'
echo "Stopping the server ..."
"${compose[@]}" stop server

step='restoring the database'
echo "Recreating the database and restoring $name/hearth.dump ..."
# A fresh database makes the result identical to the backup (no leftovers from newer migrations); --clean
# --if-exists is kept so the same command is also safe on a non-empty database.
# shellcheck disable=SC2016 # expanded by bash inside the sidecar, not here
"${exec_backup[@]}" bash -euo pipefail -c '
  dropdb --if-exists --force --maintenance-db=postgres "$PGDATABASE"
  createdb --maintenance-db=postgres --owner="$PGUSER" "$PGDATABASE"
  pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction -d "$PGDATABASE" "/backups/$1/hearth.dump"
' restore "$name"

step='replacing the uploads'
echo "Replacing the uploads ..."
# One-off container from the server image (busybox tar, the `node` user), as root so it can set ownership.
"${compose[@]}" run --rm --no-deps -T --user root --entrypoint sh -v "$dir:/restore:ro" server -euc '
  find /data/uploads -mindepth 1 -delete
  tar -xzf /restore/uploads.tar.gz -C /data/uploads
  chown -R node:node /data/uploads
'

step='starting the stack'
echo "Starting the stack ..."
"${compose[@]}" up -d --wait

step='waiting for /api/health'
echo "Waiting for /api/health ..."
health=''
for _ in $(seq 1 60); do
  health="$(curl -fsS --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  [[ "$health" == *'"db":"ok"'* ]] && break
  sleep 2
done
[[ "$health" == *'"db":"ok"'* ]] || false # → on_error
echo "  $health"
[[ "$health" == *'"status":"ok"'* ]] || echo "  Warning: status is not ok (LiveKit down?). The data restore itself succeeded."
trap - ERR

if [[ -s "$dir/counts.txt" ]]; then
  echo "Comparing row counts with the backup ..."
  if diff <(sort "$dir/counts.txt") <("${exec_backup[@]}" bash /scripts/backup.sh --counts | sort); then
    echo "  All $(wc -l <"$dir/counts.txt") tables match."
  else
    echo "  Warning: row counts differ (lines with < are the backup, > the database now). A migration that ran" >&2
    echo "  on start, or activity since the restore, can explain small differences." >&2
  fi
fi
echo "Restore of $name complete.${safety_name:+ The previous state is kept in data/backups/$safety_name.}"
