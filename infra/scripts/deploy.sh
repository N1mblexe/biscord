#!/usr/bin/env bash
# Deploy (or roll back) the production stack on the server.
#
#   infra/scripts/deploy.sh                    # git pull (fast-forward) the current branch, back up, build, restart
#   infra/scripts/deploy.sh --ref deploy-20261001   # roll back/forward to a tag or commit (detached HEAD)
#   infra/scripts/deploy.sh --no-backup        # skip the pre-deploy backup (not recommended)
#
# Each successful deploy tags the deployed commit deploy-YYYYMMDD (then -2, -3, ... on the same day) in the local
# clone, so `git tag -l 'deploy-*'` lists every version that ran. The server applies migrations on start.
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

before="$(git rev-parse --short HEAD)"
git fetch --tags --quiet
if [[ -n "$ref" ]]; then
  git -c advice.detachedHead=false checkout --quiet "$ref"
else
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$branch" ]] || { echo "HEAD is detached (after a rollback). Run: git switch main, then deploy again." >&2; exit 1; }
  git pull --ff-only --quiet
fi
after="$(git rev-parse --short HEAD)"
echo "Deploying $after (was $before): $(git log -1 --format=%s)"

if [[ "$backup" == true && -n "$("${compose[@]}" ps -q --status running backup 2>/dev/null)" ]]; then
  echo "Pre-deploy backup ..."
  infra/scripts/backup.sh
fi

echo "Building images ..."
"${compose[@]}" build --pull
echo "Starting ..."
"${compose[@]}" up -d --wait --remove-orphans

if [[ -z "$(git tag --points-at HEAD -l 'deploy-*')" ]]; then
  tag="deploy-$(date -u +%Y%m%d)"
  n=2
  while git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do tag="deploy-$(date -u +%Y%m%d)-$n"; n=$((n + 1)); done
  git tag "$tag"
  echo "Tagged $after as $tag"
fi

# Every rebuild leaves the previous images untagged; the boot volume is small.
docker image prune -f >/dev/null
echo
infra/scripts/status.sh || true
