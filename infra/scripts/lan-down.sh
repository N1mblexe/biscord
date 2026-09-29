#!/usr/bin/env bash
# Stop the LAN test profile. Compose interpolates both files even for `down`, so LAN_IP needs some value.
# This also stops Postgres and LiveKit; run `pnpm infra:up` afterwards for dev.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAN_IP="${LAN_IP:-0.0.0.0}" docker compose -f docker-compose.yml -f docker-compose.lan.yml down
