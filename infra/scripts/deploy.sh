#!/usr/bin/env bash
# Deploy (or roll back) the production stack on the server.
#
#   infra/scripts/deploy.sh                          # git pull (fast-forward) the current branch, back up, build, restart
#   infra/scripts/deploy.sh --ref deploy-20261001    # roll back/forward to a tag or commit (detached HEAD)
#   infra/scripts/deploy.sh --no-backup              # skip the pre-deploy backup (not recommended)
#
# Order: pre-deploy backup data/backups/pre-deploy-<running sha>-<UTC> (aborts the deploy if it fails) → git →
# build → up → recreate caddy/livekit/backup if infra/ or the compose file changed → tag deploy-YYYYMMDD (-2, -3 …)
# → prune old images → status. The server applies migrations on start.
set -euo pipefail
cd "$(dirname "$0")/../.."

compose=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
ref=''
backup=true
while (($# > 0)); do
  case "$1" in
    --ref) ref="${2:?--ref needs a tag or commit}"; shift 2 ;;
    --no-backup) backup=false; shift ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f .env.prod ]] || { echo ".env.prod not found; run infra/scripts/gen-secrets.sh first." >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "The working tree has local changes to tracked files; commit or discard them first (git status)." >&2
  exit 1
fi

before="$(git rev-parse HEAD)"
before_tag="$(git tag --points-at "$before" -l 'deploy-*' | sort | tail -n 1)"

pre_deploy=''
if [[ "$backup" == true ]]; then
  if [[ -n "$("${compose[@]}" ps -q --status running backup 2>/dev/null)" ]]; then
    echo "Pre-deploy backup of the running version ($(git rev-parse --short HEAD)) ..."
    # tee into a temp file, not /dev/stderr: reopening a redirected log file would truncate it.
    backup_log="$(mktemp)"
    infra/scripts/backup.sh --run --prefix "pre-deploy-$(git rev-parse --short=8 HEAD)-" | tee "$backup_log" ||
      { rm -f "$backup_log"; echo "The pre-deploy backup failed; nothing was changed." >&2; exit 1; }
    pre_deploy="$(sed -n 's#.*done: data/backups/##p' "$backup_log" | tail -n 1)"
    rm -f "$backup_log"
    [[ -n "$pre_deploy" ]] || { echo "The pre-deploy backup failed; nothing was changed." >&2; exit 1; }
  else
    echo "The stack isn't running (first deploy?): no pre-deploy backup."
  fi
fi

git fetch --tags --quiet
if [[ -n "$ref" ]]; then
  git -c advice.detachedHead=false checkout --quiet "$ref"
else
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$branch" ]] || { echo "HEAD is detached (after a rollback). Run: git switch main, then deploy again." >&2; exit 1; }
  git pull --ff-only --quiet
fi
after="$(git rev-parse HEAD)"
echo "Deploying $(git rev-parse --short HEAD) (was $(git rev-parse --short "$before")): $(git log -1 --format=%s)"

echo "Building images ..."
"${compose[@]}" build --pull
echo "Starting ..."
"${compose[@]}" up -d --wait --remove-orphans

# Config files are directory mounts, but caddy/livekit only read them at start and the backup loop keeps its
# script open: recreate them whenever their config may have changed.
if [[ -n "$(git diff --name-only "$before" "$after" -- infra docker-compose.prod.yml)" ]]; then
  echo "infra/ or docker-compose.prod.yml changed: recreating caddy, livekit and backup ..."
  "${compose[@]}" up -d --wait --no-deps --force-recreate caddy livekit backup
fi

if [[ -z "$(git tag --points-at HEAD -l 'deploy-*')" ]]; then
  tag="deploy-$(date -u +%Y%m%d)"
  n=2
  while git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do tag="deploy-$(date -u +%Y%m%d)-$n"; n=$((n + 1)); done
  git tag "$tag"
  echo "Tagged $(git rev-parse --short HEAD) as $tag"
fi

# Every rebuild leaves the previous images untagged; the boot volume is small.
docker image prune -f >/dev/null
echo
infra/scripts/status.sh || true

echo
if [[ -n "$pre_deploy" ]]; then
  echo "Pre-deploy backup: data/backups/$pre_deploy"
  echo "To roll back code AND data to exactly before this deploy (loses everything written since that backup):"
  echo "  infra/scripts/deploy.sh --ref ${before_tag:-$(git rev-parse --short "$before")}"
  echo "  infra/scripts/restore.sh data/backups/$pre_deploy"
fi
