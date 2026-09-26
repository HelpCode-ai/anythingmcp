#!/usr/bin/env bash
# =============================================================================
# Blue/green release of the cloud's app containers: start the new release
# NEXT TO the one serving, check it, move Caddy over, then stop the old one.
#
#   release.sh              release the staged compose file + Caddyfile
#                           (deploy-cloud.yml stages them in /tmp/anythingmcp-deploy)
#   release.sh --restart    re-release the local :latest image with the compose
#                           file and Caddyfile in use: a zero-downtime
#                           restart (e.g. to shed a heap that has grown, or
#                           after editing .env). :latest is what is serving —
#                           a failed release puts it back. To go back to the
#                           previous release: `docker tag helpcodeai/
#                           anythingmcp:rollback helpcodeai/anythingmcp:latest`,
#                           restore docker-compose.cloud.yml.rollback if the
#                           compose file changed, then --restart. Installed on
#                           the host as /opt/anythingmcp-cloud/release.sh.
#
# ── Why ─────────────────────────────────────────────────────────────────────
# Until 2026-09-25 a release recreated backend and frontend in place:
# `--force-recreate` stopped the old container before the new one was up, so
# every deploy cost ~20–40 s of 502 on the API and every tenant's MCP
# endpoint, and a release that never became healthy kept the site down for
# minutes, until Docker called it unhealthy and the rollback started.
#
# ── How ─────────────────────────────────────────────────────────────────────
# docker-compose.cloud.yml defines each app service twice, backend-blue /
# backend-green and frontend-blue / frontend-green, behind compose profiles.
# The live colour is one word in /config/amcp-colour inside the Caddy
# container, which the Caddyfile reads on every request (why a file and not
# a config reload: see the header of deploy/cloud/Caddyfile). A release:
#
#   1. starts the other colour (the old one keeps serving) and waits for both
#      of its containers to report healthy — failing fast if one exits or
#      restarts, or if the host runs short of memory while it boots;
#   2. runs the new Caddyfile in a throwaway Caddy on the same network, its
#      colour set to the new one, and puts the public checks (/health,
#      /mcp/demo tools/list, /login) through it — the new release AND the new
#      Caddyfile are exercised before a single real request reaches them;
#   3. writes the new colour into the real Caddy's colour file (and, only if
#      the routes changed, the new Caddyfile, with a reload): requests
#      already on the old colour finish there, new ones go to the new one;
#   4. repeats the public checks through the real Caddy; if they fail, Caddy
#      is pointed back at the old colour, which never stopped;
#   5. waits until Caddy has no request in flight to the old colour, stops
#      it, and gives the new containers the stable names amcp-cloud-backend
#      and amcp-cloud-frontend;
#   6. asks the new backend to catch its tool registry up with changes made
#      through the old one while it was starting (see below);
#   7. applies the rest of the compose file (postgres, redis, motis, caddy)
#      and drops what is no longer in it.
#
# Any failure before step 3 removes the new colour and nothing else: the old
# one served throughout, and a broken release never answered a request.
# Every exit other than "release is live" is non-zero: a red job.
#
# The first release after this script replaced the in-place one finds the
# old single `backend`/`frontend` containers serving ("legacy") and treats
# them as the old colour; they are removed at step 5 like any old colour.
#
# ── Memory: two backends at once ────────────────────────────────────────────
# Measured on the droplet (7.9 GB RAM, 4 GB swap) on 2026-09-25, 43 minutes
# after a restart: backend 646 MiB RSS (heap 549 of 4192 MB), frontend 82,
# postgres 458, motis 368, caddy 29, redis 3; host 1.9 GB used, 6.0 GB
# available. The overlap adds one booting backend — its steady ~0.7 GB, and
# at the most ~1.5 GB while it pages the ~24k-tool registry in (the load is
# paged precisely to bound that; see McpServerService.loadAllTools) — and one
# frontend (~0.1 GB): ~3.5 GB used of 7.9 at the peak. The backend's
# mem_limit (6 GB) stays: it is a ceiling for one runaway process, which the
# heap guard watches, not a reservation, and 2 × 6 GB was never going to fit.
# What can hurt is the leak (#659): a live backend that has grown to 3–4 GB
# leaves no room for a second one. Hence, before anything starts:
#   RELEASE_MIN_AVAILABLE_MB (2500) — MemAvailable needed to overlap. Below
#     it the release falls back to stop-then-start (the old behaviour, with
#     its ~30–90 s of 502 on backend routes, the frontend still overlapping),
#     says so, and silences the uptime probe for the window;
#   RELEASE_MEM_ABORT_MB (500) — if MemAvailable drops below this while the
#     new colour boots, the new colour is removed and the old keeps serving.
#
# ── Database: expand, then contract ─────────────────────────────────────────
# The new backend runs `prisma migrate deploy` when it starts, while the old
# backend is still serving on the same database — and if the release fails,
# the old code goes on serving the migrated schema. So every migration must
# be one the PREVIOUS release can run against:
#   - add tables, add nullable columns or columns with a default, add
#     indexes (CONCURRENTLY for big tables: a long lock stalls the old
#     backend's queries during the overlap);
#   - never, in the same release as the code that stops using it, drop or
#     rename a column/table, tighten a constraint, or change a type. Ship
#     the code that no longer needs it first; drop it in a later release.
# This was already true for rollbacks; the overlap makes it true for every
# release, including the ones that succeed.
#
# ── Work that must not run twice ────────────────────────────────────────────
# Audited 2026-09-25. There is no scheduler in the backend; what runs by
# itself is per process and fine to overlap: the heap guard, the MCP session
# sweep, the SSRF-policy cache. The catalog reconciler runs once at each
# boot: only the NEW backend runs it during a release (the old one ran it at
# its own boot), and its safe-class resync is idempotent. License re-verify
# at startup returns immediately in cloud mode. The onboarding-reminder cron
# is an HTTP call from GitHub Actions, served by whichever backend Caddy
# routes it to — one.
#
# What does NOT overlap well is in-memory state. The tool registry is loaded
# at boot and kept current by the process that makes a change; a connector
# installed through the old backend while the new one waits would be missing
# from the new one's MCP tools. Step 6 fixes that (POST
# /internal/registry/catch-up, loopback-only; McpServerService.
# catchUpRegistry). Pending connector-OAuth flows (the "Authorize with
# Provider" redirect) live in the old process and are lost with it, as they
# were on every restart: the user clicks again. Stateful MCP sessions exist
# only with MCP_STATEFUL_SESSIONS=true, which the cloud does not set; were it
# set, a session opened on the old backend gets 404 "Session not found" from
# the new one, and spec-compliant clients start a new session — again, what
# a restart did.
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
# Container names. The live colour's containers are renamed to these.
PREFIX="${PREFIX:-amcp-cloud}"
BACKEND_NAME="${BACKEND_NAME:-${PREFIX}-backend}"
FRONTEND_NAME="${FRONTEND_NAME:-${PREFIX}-frontend}"
CADDY_CONTAINER="${CADDY_CONTAINER:-${PREFIX}-caddy}"
PREVIEW_CONTAINER="${PREVIEW_CONTAINER:-${PREFIX}-caddy-preview}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"
PROBE_TRIES="${PROBE_TRIES:-12}"
# After the switch real traffic is on the new colour, so a failing check
# must turn Caddy back quickly rather than retry for a minute: the preview
# already passed, and a check that fails now is not a slow start.
SWITCH_PROBE_TRIES="${SWITCH_PROBE_TRIES:-3}"
SWITCH_PROBE_DELAY="${SWITCH_PROBE_DELAY:-2}"
PROBE_DELAY="${PROBE_DELAY:-5}"
COLOUR_FILE="${COLOUR_FILE:-/config/amcp-colour}"
MAINTENANCE_FILE="${MAINTENANCE_FILE-/var/lib/anythingmcp-probe/maintenance}"
# For release.test.sh only: a command run after the preview checks passed and
# before the switch, to break a release at the one point nothing else can.
RELEASE_HOOK_BEFORE_CUTOVER="${RELEASE_HOOK_BEFORE_CUTOVER:-}"

RESTART=0
case "${1:-}" in
  --restart) RESTART=1 ;;
  "") ;;
  *) echo "usage: $0 [--restart]" >&2; exit 2 ;;
esac

cd "$APP_DIR"

# Tunables: the environment first, then the deployment's .env, so an operator
# can change them on the host without touching the workflow (e.g. SWAP_MODE=
# cold to force the old stop-then-start for one release).
envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
tunable() { local v="${!1:-}"; [ -n "$v" ] || v=$(envval "$1"); echo "${v:-$2}"; }
SWAP_MODE=$(tunable SWAP_MODE auto)                          # auto | overlap | cold
RELEASE_MIN_AVAILABLE_MB=$(tunable RELEASE_MIN_AVAILABLE_MB 2500)
RELEASE_MEM_ABORT_MB=$(tunable RELEASE_MEM_ABORT_MB 500)
DRAIN_TIMEOUT=$(tunable DRAIN_TIMEOUT 120)

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

if [ "$RESTART" = 1 ]; then
  NEW_COMPOSE="$APP_DIR/$COMPOSE_FILE"
  NEW_CADDYFILE="$APP_DIR/Caddyfile"
  grep -q 'amcp-colour' "$NEW_CADDYFILE" 2>/dev/null \
    || { echo "::error::--restart needs one blue/green release by the workflow first" >&2; exit 1; }
fi

if [ -z "${SITE_URL:-}" ]; then
  DOMAIN=$(envval DOMAIN)
  SITE_URL="https://${DOMAIN}"
fi
SITE_HOST="${SITE_URL#*://}"; SITE_HOST="${SITE_HOST%%/*}"

# One release at a time on this host, whoever starts it (the workflow queues
# its own runs; an operator's --restart would not be queued with them).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$APP_DIR/.release.lock"
  flock -n 9 || { echo "::error::another release is running on this host" >&2; exit 1; }
fi

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
exists() { [ -n "$1" ] && docker inspect "$1" >/dev/null 2>&1; }
service_of() { docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1" 2>/dev/null || true; }
mem_available_mb() { awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true; }
# Rewrite a file in place: Caddy's bind mount follows the inode, and `mv`
# would give the host a new file the container never sees.
write_in_place() { cat "$1" > "$2"; }

# The live colour is one word in a file inside the Caddy container, read by
# the Caddyfile on every request (see the header of deploy/cloud/Caddyfile).
# Written with a rename, so a request reads the old word or the new one.
get_colour() { docker exec "$CADDY_CONTAINER" cat "$COLOUR_FILE" 2>/dev/null | tr -cd 'a-z' || true; }
set_colour() {
  docker exec "$CADDY_CONTAINER" sh -c "printf '%s' '$1' > '${COLOUR_FILE}.tmp' && mv '${COLOUR_FILE}.tmp' '$COLOUR_FILE'"
}

# ── Which colour is live ────────────────────────────────────────────────────
# What the running Caddy routes to: the colour file when the host Caddyfile
# reads it; the single backend/frontend services of the layout before
# blue/green when it does not.
LIVE=none
if [ -f Caddyfile ]; then
  if grep -q 'amcp-colour' Caddyfile; then
    case "$(get_colour)" in blue) LIVE=blue ;; green) LIVE=green ;; esac
  elif grep -qE 'reverse_proxy +backend:' Caddyfile; then
    LIVE=legacy
  fi
fi
case "$LIVE" in blue) NEW=green ;; *) NEW=blue ;; esac

# The live colour's containers, wherever an interrupted release left them:
# normally under the stable names; under their colour names if a release
# died between stopping the old colour and renaming the new one.
live_container() { # $1 = backend | frontend
  local stable="$BACKEND_NAME"
  if [ "$1" = frontend ]; then stable="$FRONTEND_NAME"; fi
  case "$LIVE" in
    legacy)
      if exists "$stable"; then echo "$stable"; fi ;;
    blue|green)
      if exists "${PREFIX}-$1-${LIVE}"; then echo "${PREFIX}-$1-${LIVE}"
      elif [ "$(service_of "$stable")" = "$1-$LIVE" ]; then echo "$stable"
      fi ;;
  esac
  return 0
}
OLD_BACKEND=$(live_container backend)
OLD_FRONTEND=$(live_container frontend)
[ "$LIVE" != none ] && [ -z "$OLD_BACKEND" ] && LIVE=none
NEW_BACKEND="${PREFIX}-backend-${NEW}"
NEW_FRONTEND="${PREFIX}-frontend-${NEW}"

log "live: ${LIVE}${OLD_BACKEND:+ ($OLD_BACKEND, $OLD_FRONTEND)} → releasing as: ${NEW}"

# Put the live containers under the stable names if an interrupted release
# left them under their colour names, and clear anything else that holds
# those names.
settle_names() {
  local app live stable
  for app in backend frontend; do
    stable="$BACKEND_NAME"; live="$OLD_BACKEND"
    [ "$app" = frontend ] && { stable="$FRONTEND_NAME"; live="$OLD_FRONTEND"; }
    if [ -z "$live" ] || [ "$live" = "$stable" ]; then continue; fi
    if exists "$stable"; then docker rm -f "$stable" >/dev/null; fi
    docker rename "$live" "$stable"
    log "renamed $live → $stable"
    if [ "$app" = backend ]; then OLD_BACKEND="$stable"; else OLD_FRONTEND="$stable"; fi
  done
}
if [ "$LIVE" = blue ] || [ "$LIVE" = green ]; then settle_names; fi

# ── Checks ──────────────────────────────────────────────────────────────────
TRIES="$PROBE_TRIES"; DELAY="$PROBE_DELAY"
probe() {
  local label="$1" expect="$2"; shift 2
  local code=""
  for _ in $(seq 1 "$TRIES"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true)
    [ "$code" = "$expect" ] && { echo "ok   $label → $code"; return 0; }
    sleep "$DELAY"
  done
  echo "::error::$label answered ${code:-nothing} (expected $expect)"
  return 1
}

# The site's three proxy targets: the backend, the anonymous MCP endpoint,
# a frontend page. $1 = base URL; the rest go to curl (e.g. a Host header).
# Stops at the first failure.
site_ok() {
  local base="$1"; shift
  probe "${base}/health" 200 "$@" "${base}/health" || return 1
  probe "${base}/mcp/demo tools/list" 200 "$@" -X POST \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    "${base}/mcp/demo" || return 1
  probe "${base}/login" 200 "$@" "${base}/login" || return 1
}

# Wait for containers to report healthy. Fails fast on an exit or a restart
# (a backend that cannot boot restarts in a loop and would otherwise take
# start_period plus retries to read "unhealthy"), on "unhealthy", and when
# the host runs short of memory — so the overlap can never be what pushes
# the host into the OOM killer.
restart_count() { docker inspect -f '{{.RestartCount}}' "$1" 2>/dev/null || echo 0; }
wait_healthy() {
  local deadline=$((SECONDS + WAIT_TIMEOUT)) c i state health restarts all avail
  local base=()
  for c in "$@"; do base+=("$(restart_count "$c")"); done
  while :; do
    all=1; i=0
    for c in "$@"; do
      read -r state health restarts < <(docker inspect -f \
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$c" 2>/dev/null || echo "missing none 0")
      if [ "$state" = missing ] || [ "$state" = exited ] || [ "$state" = dead ] || [ "$restarts" -gt "${base[$i]}" ]; then
        WAIT_ERROR="$c exited (state $state, restarts $restarts)"; return 1
      fi
      i=$((i + 1))
      [ "$health" = unhealthy ] && { WAIT_ERROR="$c is unhealthy"; return 1; }
      [ "$health" = healthy ] || all=0
    done
    [ "$all" = 1 ] && return 0
    avail=$(mem_available_mb)
    if [ -n "$avail" ] && [ "$RELEASE_MEM_ABORT_MB" -gt 0 ] && [ "$avail" -lt "$RELEASE_MEM_ABORT_MB" ]; then
      WAIT_ERROR="host MemAvailable fell to ${avail} MB (abort line ${RELEASE_MEM_ABORT_MB} MB)"; return 1
    fi
    [ "$SECONDS" -ge "$deadline" ] && { WAIT_ERROR="not healthy after ${WAIT_TIMEOUT}s"; return 1; }
    sleep 1
  done
}

reload_proxy() {
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
}

# Requests Caddy has in flight to the given upstream hosts, from its admin
# API. Empty when the API does not answer.
in_flight() {
  local json
  json=$(docker exec "$CADDY_CONTAINER" wget -qO- http://127.0.0.1:2019/reverse_proxy/upstreams 2>/dev/null) || return 0
  printf '%s' "$json" | tr '{' '\n' | { grep -E "\"address\":\"($1):" || true; } \
    | sed -n 's/.*"num_requests":\([0-9]*\).*/\1/p' | awk '{s += $1} END {print s + 0}'
}

# After the switch, Caddy lets requests already sent to the old colour finish
# there (a reload is graceful). Wait for them, up to DRAIN_TIMEOUT: a long
# MCP tool call is exactly what a plain `docker stop` would have cut.
drain() {
  local hosts="$1" deadline=$((SECONDS + DRAIN_TIMEOUT)) n
  while :; do
    n=$(in_flight "$hosts")
    if [ -z "$n" ]; then
      echo "::warning::Caddy's admin API did not answer; waiting 5 s instead of counting requests"
      sleep 5; return 0
    fi
    [ "$n" = 0 ] && { log "old colour drained"; return 0; }
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::warning::$n request(s) still in flight to the old colour after ${DRAIN_TIMEOUT}s; stopping it anyway"
      return 0
    fi
    sleep 1
  done
}

PREVIEW_URL=""
preview_up() {
  local net img port
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER" | awk '{print $1}')
  img=$(docker inspect -f '{{.Config.Image}}' "$CADDY_CONTAINER")
  docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true
  printf '%s' "$NEW" > "$APP_DIR/.preview-colour"
  docker run -d --name "$PREVIEW_CONTAINER" --network "$net" \
    -e DOMAIN="http://:8081" -v "$APP_DIR/Caddyfile.next:/etc/caddy/Caddyfile:ro" \
    -v "$APP_DIR/.preview-colour:${COLOUR_FILE}:ro" \
    -p 127.0.0.1::8081 "$img" >/dev/null || return 1
  port=$(docker port "$PREVIEW_CONTAINER" 8081/tcp | head -1 | sed 's/.*://')
  [ -n "$port" ] || return 1
  PREVIEW_URL="http://127.0.0.1:${port}"
}
preview_down() { docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true; }

MAINTENANCE_SET=0
cleanup() {
  preview_down
  rm -f "$APP_DIR/Caddyfile.next" "$APP_DIR/.preview-colour"
  [ "$MAINTENANCE_SET" = 1 ] && rm -f "$MAINTENANCE_FILE"
  return 0
}
trap cleanup EXIT

remove_new_colour() { docker rm -f "$NEW_BACKEND" "$NEW_FRONTEND" >/dev/null 2>&1 || true; }

COMPOSE_CHANGED=0
COLD_STOPPED=0
# The new colour is out: remove it, put the old compose file back and, if
# the old backend was stopped to make room, start it again.
abort() {
  echo "::error::$1 — removing the new release; the previous one keeps serving"
  if exists "$NEW_BACKEND"; then
    docker ps -a --filter "name=${PREFIX}-" --format '{{.Names}}\t{{.Status}}' || true
    echo "--- last lines of ${NEW_BACKEND} ---"; docker logs --tail 60 "$NEW_BACKEND" 2>&1 || true
  fi
  preview_down
  remove_new_colour
  # Keep the local :latest meaning "what is serving", as the pre-blue/green
  # rollback did: a later --restart must not pick up the rejected image.
  if [ -n "${PREV_IMAGE:-}" ]; then docker tag "$PREV_IMAGE" "${IMAGE}:latest"; fi
  if [ "$COMPOSE_CHANGED" = 1 ] && [ -f "${COMPOSE_FILE}.rollback" ]; then
    cp "${COMPOSE_FILE}.rollback" "$COMPOSE_FILE"
  fi
  if [ "$COLD_STOPPED" = 1 ]; then
    log "starting the previous backend again"
    docker start "$OLD_BACKEND" >/dev/null && wait_healthy "$OLD_BACKEND" \
      || echo "::error::the previous backend did not come back healthy: ${WAIT_ERROR:-} — manual intervention needed"
  fi
  if [ "$LIVE" != none ] && site_ok "$SITE_URL"; then
    echo "::error::the release was not applied; the previous one (${OLD_BACKEND}) is serving"
  elif [ "$LIVE" != none ]; then
    echo "::error::the previous release does not answer either: manual intervention needed"
  fi
  exit 1
}

# ── Preflight ───────────────────────────────────────────────────────────────
MODE=overlap
if [ "$LIVE" != none ]; then
  avail=$(mem_available_mb)
  case "$SWAP_MODE" in
    cold) MODE=cold ;;
    overlap) ;;
    auto)
      if [ -z "$avail" ]; then
        log "MemAvailable unknown (no /proc/meminfo): overlapping"
      elif [ "$avail" -lt "$RELEASE_MIN_AVAILABLE_MB" ]; then
        MODE=cold
        echo "::warning::host MemAvailable ${avail} MB < ${RELEASE_MIN_AVAILABLE_MB} MB: no room for two backends. Falling back to stop-then-start — backend routes answer 502 until the new backend is up. (Is the live backend's heap grown? Check /health.)"
      else
        log "host MemAvailable ${avail} MB ≥ ${RELEASE_MIN_AVAILABLE_MB} MB: overlapping"
      fi ;;
    *) echo "::error::SWAP_MODE must be auto, overlap or cold" >&2; exit 2 ;;
  esac
fi

# Anything left of the new colour by an interrupted release is not serving
# (the Caddyfile says so): clear it.
remove_new_colour
preview_down

# Rollback point, for an operator going back further than this script does:
# the live image, by ID, under a tag `docker image prune` leaves alone.
if [ -n "$OLD_BACKEND" ]; then
  PREV_IMAGE=$(docker inspect --format '{{.Image}}' "$OLD_BACKEND")
  docker tag "$PREV_IMAGE" "${IMAGE}:rollback"
  log "rollback point: ${PREV_IMAGE}"
fi
[ -f "$COMPOSE_FILE" ] && cp "$COMPOSE_FILE" "${COMPOSE_FILE}.rollback"
[ -f Caddyfile ] && cp Caddyfile Caddyfile.rollback

# ── 1. Start the new colour next to the old ─────────────────────────────────
if [ "$NEW_COMPOSE" != "$APP_DIR/$COMPOSE_FILE" ]; then
  cp "$NEW_COMPOSE" "$COMPOSE_FILE"; COMPOSE_CHANGED=1
fi
cp "$NEW_CADDYFILE" Caddyfile.next
grep -q 'amcp-colour' Caddyfile.next \
  || abort "the new Caddyfile does not read the colour file: it is not a blue/green Caddyfile"
CADDYFILE_CHANGED=1
if [ -f Caddyfile ] && cmp -s Caddyfile.next Caddyfile; then CADDYFILE_CHANGED=0; fi

# Infrastructure the app needs, started if missing, never recreated here
# (changes to it are applied at step 7, once the release is live).
INFRA_LIST=$(compose config --services 2>/dev/null | tr '\n' ' ') || true
[ -n "${INFRA_LIST// /}" ] || abort "the new compose file does not parse"
read -r -a INFRA <<< "$INFRA_LIST"
compose up -d --no-recreate "${INFRA[@]}" || abort "could not start the stack's infrastructure"

if [ "$MODE" = cold ]; then
  if [ -n "$MAINTENANCE_FILE" ]; then
    mkdir -p "$(dirname "$MAINTENANCE_FILE")"
    echo $(( $(date -u +%s) + 1800 )) > "$MAINTENANCE_FILE"; MAINTENANCE_SET=1
  fi
  log "stopping ${OLD_BACKEND} to make room (cold swap)"
  docker stop -t 30 "$OLD_BACKEND" >/dev/null; COLD_STOPPED=1
fi

log "starting ${NEW}"
compose --profile "$NEW" up -d --no-deps "backend-$NEW" "frontend-$NEW" \
  || abort "compose could not create the ${NEW} containers"
WAIT_ERROR=""
wait_healthy "$NEW_BACKEND" "$NEW_FRONTEND" || abort "the new release did not become healthy: ${WAIT_ERROR}"
log "${NEW} is healthy"

# ── 2. The site, through the new Caddyfile, on the new colour — privately ──
preview_up || abort "the new Caddyfile does not run (preview Caddy failed to start)"
site_ok "$PREVIEW_URL" -H "Host: ${SITE_HOST}" \
  || { docker logs --tail 20 "$PREVIEW_CONTAINER" 2>&1 || true; abort "the new release failed the site checks (preview, before any traffic)"; }
preview_down
log "preview checks passed"

[ -n "$RELEASE_HOOK_BEFORE_CUTOVER" ] && bash -c "$RELEASE_HOOK_BEFORE_CUTOVER"

# ── 3. Switch ───────────────────────────────────────────────────────────────
# One word in Caddy's colour file; and, only when the routes changed (or on
# the first release after the single-container layout), the Caddyfile with a
# reload.
revert_proxy() {
  case "$LIVE" in
    blue|green) set_colour "$LIVE" || echo "::error::could not write the colour file back" ;;
  esac
  if [ "$CADDYFILE_CHANGED" = 1 ]; then
    if [ -f Caddyfile.rollback ]; then write_in_place Caddyfile.rollback Caddyfile; fi
    reload_proxy || echo "::error::Caddy refused the previous Caddyfile too"
  fi
}
set_colour "$NEW" || { revert_proxy; abort "could not write Caddy's colour file"; }
if [ "$CADDYFILE_CHANGED" = 1 ]; then
  write_in_place Caddyfile.next Caddyfile
  if ! reload_proxy; then
    revert_proxy
    abort "Caddy rejected the new Caddyfile"
  fi
  log "Caddyfile changed: reloaded"
fi
log "Caddy now routes to ${NEW}"

# ── 4. The site, publicly ───────────────────────────────────────────────────
TRIES="$SWITCH_PROBE_TRIES"; DELAY="$SWITCH_PROBE_DELAY"
switch_ok=0; site_ok "$SITE_URL" || switch_ok=1
TRIES="$PROBE_TRIES"; DELAY="$PROBE_DELAY"
if [ "$switch_ok" != 0 ]; then
  if [ "$COLD_STOPPED" = 1 ]; then
    docker start "$OLD_BACKEND" >/dev/null && wait_healthy "$OLD_BACKEND" || true
    COLD_STOPPED=0
  fi
  [ "$LIVE" != none ] && revert_proxy
  abort "the site failed the checks through Caddy after the switch; Caddy is back on ${LIVE}"
fi

# ── 5. Retire the old colour ────────────────────────────────────────────────
if [ "$LIVE" != none ]; then
  case "$LIVE" in
    legacy) OLD_HOSTS="backend|frontend" ;;
    *) OLD_HOSTS="backend-${LIVE}|frontend-${LIVE}" ;;
  esac
  drain "$OLD_HOSTS"
  for c in "$OLD_BACKEND" "$OLD_FRONTEND"; do
    [ -n "$c" ] || continue
    docker stop -t 30 "$c" >/dev/null 2>&1 || true
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  log "stopped and removed ${OLD_BACKEND} ${OLD_FRONTEND}"
fi
for pair in "$NEW_BACKEND:$BACKEND_NAME" "$NEW_FRONTEND:$FRONTEND_NAME"; do
  from="${pair%%:*}"; to="${pair#*:}"
  if exists "$to"; then docker rm -f "$to" >/dev/null 2>&1; fi
  docker rename "$from" "$to"
done
log "${NEW} is live as ${BACKEND_NAME} / ${FRONTEND_NAME}"

# ── 6. Registry catch-up ────────────────────────────────────────────────────
# Connectors changed through the old backend after the new one loaded its
# registry. Not fatal: the release is live either way, and an image older
# than the endpoint answers 404 — then a changed connector shows its old
# tools until it is saved again or the backend restarts.
if out=$(docker exec "$BACKEND_NAME" wget -qO- --post-data= "http://127.0.0.1:${BACKEND_PORT}/internal/registry/catch-up" 2>&1); then
  log "registry catch-up: ${out}"
else
  echo "::warning::registry catch-up failed (${out}); connectors changed during the release may show stale tools until the backend restarts"
fi

# ── 7. The rest of the stack ────────────────────────────────────────────────
# Named services only, and with the live colour's profile on, so that
# --remove-orphans can only ever mean a service deleted from the file.
if ! compose --profile "$NEW" up -d --remove-orphans "${INFRA[@]}"; then
  echo "::error::the release is live, but applying the rest of the compose file failed"
  exit 1
fi
if ! site_ok "$SITE_URL"; then
  echo "::error::the release is live, but the site fails its checks after the rest of the stack was applied"
  exit 1
fi

# For `release.sh --restart`.
[ "$SELF" = "$APP_DIR/release.sh" ] || install -m 755 "$SELF" "$APP_DIR/release.sh"

echo "release is live (${NEW})"
