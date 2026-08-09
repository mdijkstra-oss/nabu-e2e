#!/bin/sh
# docker compose against the e2e stack, with the interpolation variables the
# override file needs. Usage: scripts/compose.sh <compose args...>
set -eu

E2E_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NABU_ROOT=$(dirname "$E2E_ROOT")

export NABU_PORT="${NABU_PORT:-8099}"
export NABU_FRONTEND_REPO="$NABU_ROOT/nabu-frontend"
export NABU_STORAGE_REPO="$NABU_ROOT/nabu-storage"
export NABU_E2E_FAKE_CONTEXT="$E2E_ROOT/fake-model-server"
export NABU_E2E_FIXTURES="$E2E_ROOT/fixtures"

exec docker compose -p nabu-e2e \
  -f "$NABU_ROOT/nabu-self-hosted/compose.yaml" \
  -f "$E2E_ROOT/compose.e2e.yaml" \
  "$@"
