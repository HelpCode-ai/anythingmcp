#!/usr/bin/env bash
# =============================================================================
# Swap the cloud's app containers to a new release, and put the previous one
# back if the new one does not come up.
#
# Called by .github/workflows/deploy-cloud.yml once the new image is pulled
# and the new docker-compose.cloud.yml and Caddyfile are staged. Until
# 2026-09-24 a release that failed to start stayed failed: the backend
# refused to boot with Sentry enabled and the API answered 502 for five
# minutes, until someone removed the variable by hand. A failed deploy now
# ends with the previous release serving and the workflow red.
#
# What is rolled back: the app image, docker-compose.cloud.yml and the
# Caddyfile, i.e. everything a deploy changes. Not rolled back: the database.
# The backend runs `prisma migrate deploy` at start, so a release that got as
# far as migrating leaves the schema one step ahead of the code that comes
# back. Our migrations are additive, which the previous code tolerates;
# a destructive one would need its own plan anyway. Not rolled back either:
# .env, which operators edit by hand; the compose file decides which of its
# variables reach the containers, and that file is restored.
#
# Every name is overridable so the script can be exercised against a
# throwaway stack (see deploy/cloud/release.test.sh).
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/anythingmcp-cloud}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
IMAGE="${IMAGE:-helpcodeai/anythingmcp}"
NEW_COMPOSE="${NEW_COMPOSE:-/tmp/anythingmcp-deploy/docker-compose.cloud.yml}"
NEW_CADDYFILE="${NEW_CADDYFILE:-/tmp/anythingmcp-deploy/deploy/cloud/Caddyfile}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-amcp-cloud-backend}"
CADDY_CONTAINER="${CADDY_CONTAINER:-amcp-cloud-caddy}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"
PROBE_TRIES="${PROBE_TRIES:-12}"
PROBE_DELAY="${PROBE_DELAY:-5}"

cd "$APP_DIR"

if [ -z "${SITE_URL:-}" ]; then
  DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
  SITE_URL="https://${DOMAIN}"
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ── Rollback point ───────────────────────────────────────────────────────────
# The image the running backend was created from, by ID: the :latest tag has
# already moved to the new release by the time this runs. Tagging it keeps it
# out of `docker image prune` and gives compose a name to start it by.
PREV_IMAGE=$(docker inspect --format '{{.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)
if [ -n "$PREV_IMAGE" ]; then
  docker tag "$PREV_IMAGE" "${IMAGE}:rollback"
  [ -f "$COMPOSE_FILE" ] && cp "$COMPOSE_FILE" "${COMPOSE_FILE}.rollback"
  [ -f Caddyfile ] && cp Caddyfile Caddyfile.rollback
  echo "rollback point: ${PREV_IMAGE}"
else
  echo "::warning::no running ${BACKEND_CONTAINER}: a failed release cannot be rolled back"
fi

# ── Checks ───────────────────────────────────────────────────────────────────
# The container health gate asks the containers. These ask the site, through
# Caddy, for the backend route, the anonymous MCP endpoint and a frontend
# page: three different proxy targets.
probe() {
  local label="$1" expect="$2"; shift 2
  local code=""
  for _ in $(seq 1 "$PROBE_TRIES"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true)
    [ "$code" = "$expect" ] && { echo "ok   $label → $code"; return 0; }
    sleep "$PROBE_DELAY"
  done
  echo "::error::$label answered ${code:-nothing} (expected $expect)"
  return 1
}

site_ok() {
  local ok=0
  probe "${SITE_URL}/health" 200 "${SITE_URL}/health" || ok=1
  probe "${SITE_URL}/mcp/demo tools/list" 200 -X POST \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    "${SITE_URL}/mcp/demo" || ok=1
  probe "${SITE_URL}/login" 200 "${SITE_URL}/login" || ok=1
  return $ok
}

# Recreate ONLY the two app containers (postgres, redis and motis keep
# running) and wait until both report healthy.
swap_apps() {
  compose up -d --no-deps --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" backend frontend
}

# Caddy reads its Caddyfile once, at start; the file is a bind mount, so a
# changed file does not recreate the container. Reload, unconditionally: it
# is graceful, and a no-op when nothing changed.
reload_proxy() {
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
}

rollback() {
  echo "::error::$1: rolling back to the previous release"
  compose ps || true
  docker logs --tail 40 "$BACKEND_CONTAINER" 2>&1 || true
  if [ -z "$PREV_IMAGE" ]; then
    echo "::error::no rollback point; the failed release is still in place"
    exit 1
  fi
  docker tag "${IMAGE}:rollback" "${IMAGE}:latest"
  [ -f "${COMPOSE_FILE}.rollback" ] && cp "${COMPOSE_FILE}.rollback" "$COMPOSE_FILE"
  [ -f Caddyfile.rollback ] && cp Caddyfile.rollback Caddyfile
  if swap_apps && reload_proxy && site_ok; then
    echo "::error::the release was rolled back; the previous one (${PREV_IMAGE}) is serving"
  else
    echo "::error::the rollback did not come up healthy either: manual intervention needed"
  fi
  # Red either way: the release that was asked for is not the one running.
  exit 1
}

# ── Release ──────────────────────────────────────────────────────────────────
cp "$NEW_COMPOSE" "$COMPOSE_FILE"
cp "$NEW_CADDYFILE" Caddyfile

swap_apps || rollback "backend/frontend did not become healthy"

# Bring up anything else in the compose file and drop what is no longer in it.
compose up -d --remove-orphans || rollback "the rest of the stack did not start"

reload_proxy || rollback "Caddy rejected the new Caddyfile"

site_ok || rollback "the site did not answer through Caddy"

echo "release is live"
