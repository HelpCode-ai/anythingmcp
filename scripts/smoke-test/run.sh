#!/usr/bin/env bash
# =============================================================================
# AnythingMCP smoke test runner
# =============================================================================
# Builds the Docker image from the current working tree, brings up postgres +
# mysql + app, runs the TypeScript smoke test on the host, then tears
# everything down.
#
# Usage:
#   ./scripts/smoke-test/run.sh             # build, run, tear down
#   KEEP_STACK=1 ./scripts/smoke-test/run.sh # leave stack up after the test
#   SKIP_BUILD=1 ./scripts/smoke-test/run.sh # reuse existing image
# =============================================================================

set -euo pipefail

cd "$(dirname "$0")"
SMOKE_DIR="$(pwd)"
ROOT_DIR="$(cd ../.. && pwd)"

export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export JWT_SECRET="$(openssl rand -base64 48 | tr -d '=' | tr -d '\n')"
export ENCRYPTION_KEY="$(openssl rand -base64 48 | tr -d '=' | tr -d '\n')"

trap_handler() {
  local code=$?
  if [[ "${KEEP_STACK:-0}" == "1" ]]; then
    echo "[smoke] KEEP_STACK=1 set — leaving stack running."
    echo "[smoke] App: http://localhost:4000  |  MySQL: localhost:3306"
  else
    echo "[smoke] Tearing down stack..."
    docker compose -f "$SMOKE_DIR/docker-compose.smoke.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap trap_handler EXIT INT TERM

echo "[smoke] Working dir: $SMOKE_DIR"
echo "[smoke] Repo root  : $ROOT_DIR"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "[smoke] Building app image..."
  docker compose -f "$SMOKE_DIR/docker-compose.smoke.yml" build app
fi

echo "[smoke] Starting stack..."
docker compose -f "$SMOKE_DIR/docker-compose.smoke.yml" up -d

echo "[smoke] Waiting for app to be healthy..."
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' amcp-smoke-app 2>/dev/null || echo "starting")
  if [[ "$status" == "healthy" ]]; then
    echo "[smoke] App is healthy."
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[smoke] App did not become healthy within 5 minutes."
    docker compose -f "$SMOKE_DIR/docker-compose.smoke.yml" logs app | tail -100
    exit 1
  fi
  sleep 5
done

echo "[smoke] Running smoke test..."
cd "$ROOT_DIR"
export SMOKE_API_BASE="${SMOKE_API_BASE:-http://localhost:${SMOKE_BACKEND_PORT:-4100}}"
npx -y --package=typescript --package=ts-node --package=axios --package=@modelcontextprotocol/sdk \
  ts-node --transpile-only \
  --compiler-options '{"module":"commonjs","target":"es2020","esModuleInterop":true,"resolveJsonModule":true,"strict":false}' \
  scripts/smoke-test/main.ts

echo "[smoke] OK."
