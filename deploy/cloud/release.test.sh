#!/usr/bin/env bash
# =============================================================================
# Exercises deploy/cloud/release.sh against a throwaway stack: a Caddy in front
# of blue/green backend and frontend services built from a tiny test image,
# with a load loop hitting the site through Caddy every 100 ms during every
# release. Needs Docker (with compose) and curl.
#
#   bash deploy/cloud/release.test.sh
#
# Scenarios, in order, each on the state the previous one left:
#   0. migration: the old single-container layout is live; the first release
#      moves it to blue — the one release that reloads Caddy, so at most one
#      failed request (see the Caddyfile's header) — and a slow request that
#      was in flight on the old containers when Caddy switched completes;
#   1. a healthy release swaps blue → green with zero failed requests and no
#      Caddy reload, and the new backend's registry catch-up is called;
#   2. a broken image never serves a request: zero failed requests, the old
#      colour still serving, no container of the new one left behind;
#   3. a broken compose change (the 2026-09-24 case: an env var the image
#      cannot start with): the same, and the compose file is restored;
#   4. a Caddyfile whose routes are wrong is caught by the preview Caddy,
#      before any traffic: zero failed requests, the host file untouched;
#   5. a release that passes every private check but fails through the real
#      Caddy (broken by a hook at the one point nothing else can) is switched
#      back: the old colour serves again, failures bounded to that window;
#   6. repeated releases alternate colours: blue, green, blue (REPEATS=n
#      for more), and `release.sh --restart` swaps colour on the same release;
#   7. the cold fallback (no room for two backends): the release still goes
#      live, backend routes are down while it boots, the frontend is not.
# After every scenario: exactly one backend, one frontend and the Caddy, and
# no preview container — nothing orphaned.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PROJECT="amcprt$$"
IMAGE="amcp-release-test"
PORT="${PORT:-18080}"
SITE="http://localhost:${PORT}"
LOAD_PID=""

cleanup() {
  [ -n "$LOAD_PID" ] && kill "$LOAD_PID" 2>/dev/null || true
  docker rm -f $(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}") "${PROJECT}-caddy-preview" >/dev/null 2>&1 || true
  docker network rm "${PROJECT}_default" >/dev/null 2>&1 || true
  docker rmi -f "${IMAGE}:latest" "${IMAGE}:rollback" "${IMAGE}:bad" \
    "${IMAGE}:r1" "${IMAGE}:r2" "${IMAGE}:r3" "${IMAGE}:r4" "${IMAGE}:r5" "${IMAGE}:r6" "${IMAGE}:r8" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── Test image ───────────────────────────────────────────────────────────────
# Answers 200 on the probed paths with its release name. BROKEN: refuses to
# start (a backend that cannot boot). /tmp/broken inside the container: every
# answer becomes 500 (a release that breaks after passing its checks). /slow:
# a 3-second request, to prove in-flight requests survive the switch. It dies
# on SIGTERM without draining, so only release.sh's drain can save them.
mkdir -p "$WORK/img" "$WORK/app" "$WORK/staged"
cat > "$WORK/img/server.py" <<'EOF'
import os, signal, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
# PID 1 ignores SIGTERM unless it handles it; exit at once, no draining.
signal.signal(signal.SIGTERM, lambda *a: os._exit(0))
if os.environ.get("BROKEN"):
    print("refusing to start", flush=True); sys.exit(1)
class H(BaseHTTPRequestHandler):
    def _answer(self):
        path = self.path.split("?")[0]
        if path == "/internal/registry/catch-up":
            print("registry catch-up called", flush=True)
            body, code = b'{"reloaded":0}', 200
        else:
            if path == "/slow": time.sleep(3)
            ok = path in ("/health", "/mcp/demo", "/login", "/slow")
            code = 200 if ok else 404
            if os.path.exists("/tmp/broken"): code = 500
            body = os.environ.get("RELEASE", "?").encode()
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = _answer
    def log_message(self, *a): pass
ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
EOF
cat > "$WORK/img/Dockerfile" <<'EOF'
FROM python:3-alpine
COPY server.py /server.py
ARG RELEASE=unset
ENV RELEASE=$RELEASE
CMD ["python", "/server.py"]
EOF
for r in r1 r2 r3 r4 r5 r6 r8; do
  docker build -q -t "${IMAGE}:$r" --build-arg RELEASE=$r "$WORK/img" >/dev/null
done
docker build -q -t "${IMAGE}:bad" -f - "$WORK/img" >/dev/null <<'EOF'
FROM python:3-alpine
COPY server.py /server.py
ENV RELEASE=bad BROKEN=1
CMD ["python", "/server.py"]
EOF

HEALTH='
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8000/health"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 8s
      start_interval: 1s
    restart: unless-stopped'
# The same, for the top-level x- definitions the colours are built from.
HEALTH_X=$(printf '%s' "$HEALTH" | sed 's/^  //')
CADDY_SERVICE="
  caddy:
    image: caddy:2-alpine
    container_name: ${PROJECT}-caddy
    environment: [\"DOMAIN=:8080\"]
    ports: [\"${PORT}:8080\"]
    volumes: [\"./Caddyfile:/etc/caddy/Caddyfile:ro\"]
    restart: unless-stopped"

# The layout before blue/green: one backend and one frontend service, Caddy
# routing to them by service name.
legacy_compose() {
  cat <<EOF
services:
  backend:
    image: ${IMAGE}:latest
    container_name: ${PROJECT}-backend${HEALTH}
  frontend:
    image: ${IMAGE}:latest
    container_name: ${PROJECT}-frontend${HEALTH}
${CADDY_SERVICE}
EOF
}
legacy_caddyfile() {
  cat <<'EOF'
{$DOMAIN} {
	handle /health* {
		reverse_proxy backend:8000
	}
	handle /mcp/* {
		reverse_proxy backend:8000
	}
	handle {
		reverse_proxy frontend:8000
	}
}
EOF
}

# The blue/green layout, as docker-compose.cloud.yml has it. $1 = an extra
# env line for the backend (may be empty).
bluegreen_compose() {
  cat <<EOF
x-backend: &backend
  image: ${IMAGE}:latest
  environment:
    - PLACEHOLDER=1
$1${HEALTH_X}
x-frontend: &frontend
  image: ${IMAGE}:latest${HEALTH_X}
services:
  backend-blue:
    <<: *backend
    container_name: ${PROJECT}-backend-blue
    profiles: [blue]
  backend-green:
    <<: *backend
    container_name: ${PROJECT}-backend-green
    profiles: [green]
  frontend-blue:
    <<: *frontend
    container_name: ${PROJECT}-frontend-blue
    profiles: [blue]
  frontend-green:
    <<: *frontend
    container_name: ${PROJECT}-frontend-green
    profiles: [green]
${CADDY_SERVICE}
EOF
}
# The blue/green Caddyfile, as deploy/cloud/Caddyfile has it: the colour is
# read from a file on every request. $1 = wrong-login for one broken route.
template_caddyfile() {
  local login_route=""
  [ "${1:-}" = wrong-login ] && login_route=$'\thandle /login {\n\t\trespond 503\n\t}'
  cat <<EOF
(backend) {
	@blue vars amcp_colour blue
	@green vars amcp_colour green
	handle @blue {
		reverse_proxy backend-blue:8000
	}
	handle @green {
		reverse_proxy backend-green:8000
	}
	handle {
		respond "No live release selected" 503
	}
}
(frontend) {
	@blue vars amcp_colour blue
	@green vars amcp_colour green
	handle @blue {
		reverse_proxy frontend-blue:8000
	}
	handle @green {
		reverse_proxy frontend-green:8000
	}
	handle {
		respond "No live release selected" 503
	}
}
{\$DOMAIN} {
	vars amcp_colour {file./config/amcp-colour}
	handle /health* {
		import backend
	}
	handle /mcp/* {
		import backend
	}
${login_route}
	handle {
		import frontend
	}
}
EOF
}

# ── Harness ──────────────────────────────────────────────────────────────────
release() { # runs release.sh against the test stack; prints its exit code
  set +e
  APP_DIR="$WORK/app" COMPOSE_FILE=docker-compose.cloud.yml IMAGE="$IMAGE" \
  NEW_COMPOSE="$WORK/staged/docker-compose.cloud.yml" NEW_CADDYFILE="$WORK/staged/Caddyfile" \
  PREFIX="$PROJECT" BACKEND_PORT=8000 SITE_URL="$SITE" \
  WAIT_TIMEOUT=30 PROBE_TRIES=5 PROBE_DELAY=1 SWITCH_PROBE_TRIES=2 SWITCH_PROBE_DELAY=1 \
  DRAIN_TIMEOUT=20 MAINTENANCE_FILE="" RELEASE_MIN_AVAILABLE_MB=0 RELEASE_MEM_ABORT_MB=0 \
  COMPOSE_PROJECT_NAME="$PROJECT" env "$@" \
    bash "$HERE/release.sh" ${RELEASE_ARGS:-} >"$WORK/release.log" 2>&1
  local code=$?
  set -e
  echo "$code"
}
serving() { curl -s --max-time 5 "${SITE}/login"; }
serving_backend() { curl -s --max-time 5 "${SITE}/health"; }
live_service() { docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "${PROJECT}-backend" 2>/dev/null || echo none; }
fail() {
  echo "FAIL: $*"
  echo "--- failed requests ---"; grep -v ' 200$' "$WORK/load.txt" 2>/dev/null | head -20 || true
  echo "--- release.sh output ---"; cat "$WORK/release.log"; exit 1
}

# One request every 100 ms, alternating the backend route and a frontend page,
# each line "<path> <code>".
load_start() {
  : > "$WORK/load.txt"
  ( while :; do
      for p in /health /login; do
        c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${SITE}${p}" || true)
        echo "$(date -u +%H:%M:%S) $p ${c:-000}" >> "$WORK/load.txt"
        sleep "${LOAD_INTERVAL:-0.1}"
      done
    done ) &
  LOAD_PID=$!
}
load_stop() { kill "$LOAD_PID" 2>/dev/null || true; wait "$LOAD_PID" 2>/dev/null || true; LOAD_PID=""; }
load_total() { wc -l < "$WORK/load.txt" | tr -d ' '; }
load_failed() { grep -v ' 200$' "$WORK/load.txt" | grep -c "${1:-}" || true; }

# Only the live backend and frontend, and Caddy: nothing orphaned, no
# half-started colour, no preview.
assert_clean() {
  local names
  names=$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}' | sort | tr '\n' ' ')
  [ "$names" = "${PROJECT}-backend ${PROJECT}-caddy ${PROJECT}-frontend " ] || fail "$1: containers left: $names"
  docker inspect "${PROJECT}-caddy-preview" >/dev/null 2>&1 && fail "$1: preview Caddy left running"
  return 0
}

RESULTS=""
report() { RESULTS+="$1"$'\n'; echo "ok   $1"; }

# ── Initial state: the legacy layout, serving r1 ──
docker tag "${IMAGE}:r1" "${IMAGE}:latest"
legacy_compose > "$WORK/app/docker-compose.cloud.yml"
legacy_caddyfile > "$WORK/app/Caddyfile"
(cd "$WORK/app" && docker compose -p "$PROJECT" -f docker-compose.cloud.yml up -d --wait --wait-timeout 60 >/dev/null 2>&1)
[ "$(serving)" = r1 ] || fail "initial stack does not serve r1"

bluegreen_compose "" > "$WORK/staged/docker-compose.cloud.yml"
template_caddyfile > "$WORK/staged/Caddyfile"

# ── 0. migration from the legacy layout, with a request in flight ──
docker tag "${IMAGE}:r2" "${IMAGE}:latest"
load_start
code=$(release RELEASE_HOOK_BEFORE_CUTOVER="curl -s --max-time 20 ${SITE}/slow > $WORK/slow.txt 2>&1 & sleep 0.5")
sleep 1; load_stop
[ "$code" = 0 ] || fail "migration exited $code"
[ "$(serving)" = r2 ] || fail "migration: site serves '$(serving)'"
[ "$(live_service)" = backend-blue ] || fail "migration: live backend is '$(live_service)', expected backend-blue"
[ "$(cat "$WORK/slow.txt")" = r1 ] || fail "migration: the in-flight request got '$(cat "$WORK/slow.txt")', expected r1 from the old containers"
# The one release that reloads Caddy (the routes change from the old layout
# to the colour-file one). A reload can drop a connection accepted at that
# instant — the race the colour file exists to avoid — so allow one here and
# nowhere else.
[ "$(load_failed)" -le 1 ] || fail "migration: $(load_failed) failed requests"
grep -q "Caddyfile changed: reloaded" "$WORK/release.log" || fail "migration: Caddy was not reloaded"
grep -q "old colour drained" "$WORK/release.log" || fail "migration: no drain"
assert_clean migration
report "0. legacy → blue: $(load_total) requests, $(load_failed) failed; in-flight slow request completed on the old release"

# ── 1. healthy release ──
docker tag "${IMAGE}:r3" "${IMAGE}:latest"
load_start; code=$(release); sleep 1; load_stop
[ "$code" = 0 ] || fail "healthy release exited $code"
[ "$(serving)" = r3 ] && [ "$(serving_backend)" = r3 ] || fail "healthy release: site serves '$(serving)'/'$(serving_backend)'"
[ "$(live_service)" = backend-green ] || fail "healthy release: live is '$(live_service)'"
[ "$(load_failed)" = 0 ] || fail "healthy release: $(load_failed) failed requests"
grep -q "Caddyfile changed" "$WORK/release.log" && fail "healthy release: Caddy was reloaded for an unchanged Caddyfile"
docker logs "${PROJECT}-backend" 2>&1 | grep -q "registry catch-up called" || fail "healthy release: registry catch-up not called"
assert_clean "healthy release"
report "1. healthy blue → green: $(load_total) requests, $(load_failed) failed"

# ── 2. broken image ──
docker tag "${IMAGE}:bad" "${IMAGE}:latest"
load_start; code=$(release); sleep 1; load_stop
[ "$code" = 1 ] || fail "broken image: release.sh exited $code, expected 1"
[ "$(serving)" = r3 ] || fail "broken image: site serves '$(serving)', expected r3"
[ "$(live_service)" = backend-green ] || fail "broken image: live is '$(live_service)'"
grep -q "did not become healthy" "$WORK/release.log" || fail "broken image: no health failure reported"
[ "$(load_failed)" = 0 ] || fail "broken image: $(load_failed) failed requests"
assert_clean "broken image"
report "2. broken image: $(load_total) requests, $(load_failed) failed; green kept serving"

# ── 3. broken compose ──
docker tag "${IMAGE}:r4" "${IMAGE}:latest"
bluegreen_compose "    - BROKEN=1" > "$WORK/staged/docker-compose.cloud.yml"
load_start; code=$(release); sleep 1; load_stop
[ "$code" = 1 ] || fail "broken compose: release.sh exited $code, expected 1"
[ "$(serving)" = r3 ] || fail "broken compose: site serves '$(serving)'"
grep -q "BROKEN" "$WORK/app/docker-compose.cloud.yml" && fail "broken compose: compose file was not restored"
[ "$(load_failed)" = 0 ] || fail "broken compose: $(load_failed) failed requests"
assert_clean "broken compose"
report "3. broken compose: $(load_total) requests, $(load_failed) failed; compose file restored"
bluegreen_compose "" > "$WORK/staged/docker-compose.cloud.yml"

# ── 4. wrong Caddyfile ──
template_caddyfile wrong-login > "$WORK/staged/Caddyfile"
cp "$WORK/app/Caddyfile" "$WORK/caddyfile.before"
load_start; code=$(release); sleep 1; load_stop
[ "$code" = 1 ] || fail "wrong Caddyfile: release.sh exited $code, expected 1"
grep -q "preview, before any traffic" "$WORK/release.log" || fail "wrong Caddyfile: not caught by the preview"
cmp -s "$WORK/app/Caddyfile" "$WORK/caddyfile.before" || fail "wrong Caddyfile: host Caddyfile changed"
[ "$(serving)" = r3 ] || fail "wrong Caddyfile: site serves '$(serving)'"
[ "$(load_failed)" = 0 ] || fail "wrong Caddyfile: $(load_failed) failed requests"
assert_clean "wrong Caddyfile"
report "4. wrong Caddyfile routes: $(load_total) requests, $(load_failed) failed; caught by the preview"
template_caddyfile > "$WORK/staged/Caddyfile"

# ── 5. breaks after the private checks: switched back ──
load_start
code=$(release RELEASE_HOOK_BEFORE_CUTOVER="docker exec ${PROJECT}-backend-blue touch /tmp/broken; docker exec ${PROJECT}-frontend-blue touch /tmp/broken")
sleep 1; load_stop
[ "$code" = 1 ] || fail "post-switch failure: release.sh exited $code, expected 1"
grep -q "Caddy is back on green" "$WORK/release.log" || fail "post-switch failure: not switched back"
[ "$(serving)" = r3 ] && [ "$(serving_backend)" = r3 ] || fail "post-switch failure: site serves '$(serving)'"
assert_clean "post-switch failure"
report "5. broken after the private checks: $(load_total) requests, $(load_failed) failed (the window between switch and switch-back); green serving again"

# ── 6. repeated releases alternate ──
# REPEATS (default 3) to stress the swap: every release must be clean.
seq_seen=""; expect_seen=""; colour=blue
for i in $(seq 1 "${REPEATS:-3}"); do
  r=$([ $((i % 2)) = 1 ] && echo r5 || echo r6)
  expect_seen+="backend-${colour} "
  colour=$([ "$colour" = blue ] && echo green || echo blue)
  docker tag "${IMAGE}:$r" "${IMAGE}:latest"
  load_start; code=$(release); sleep 1; load_stop
  [ "$code" = 0 ] || fail "repeated release $r exited $code"
  [ "$(serving)" = "$r" ] || fail "repeated release $r: site serves '$(serving)'"
  [ "$(load_failed)" = 0 ] || fail "repeated release $r: $(load_failed) failed requests"
  assert_clean "repeated release $r"
  seq_seen+="$(live_service) "
  report "6. release $i ($r) → $(live_service): $(load_total) requests, $(load_failed) failed"
done
[ "$seq_seen" = "$expect_seen" ] || fail "colours did not alternate: $seq_seen"

# ── 6b. release.sh --restart: same release, other colour ──
before_rel=$(serving); before_live=$(live_service)
load_start; code=$(RELEASE_ARGS=--restart release); sleep 1; load_stop
[ "$code" = 0 ] || fail "--restart exited $code"
[ "$(serving)" = "$before_rel" ] || fail "--restart: site serves '$(serving)', expected $before_rel"
[ "$(live_service)" != "$before_live" ] || fail "--restart: colour did not change"
[ "$(load_failed)" = 0 ] || fail "--restart: $(load_failed) failed requests"
assert_clean "--restart"
report "6b. --restart ($before_rel, $before_live → $(live_service)): $(load_total) requests, $(load_failed) failed"

# ── 7. cold fallback ──
docker tag "${IMAGE}:r8" "${IMAGE}:latest"
cold_expect=$([ "$(live_service)" = backend-blue ] && echo backend-green || echo backend-blue)
load_start; code=$(release SWAP_MODE=cold); sleep 1; load_stop
[ "$code" = 0 ] || fail "cold release exited $code"
[ "$(serving)" = r8 ] || fail "cold release: site serves '$(serving)'"
[ "$(live_service)" = "$cold_expect" ] || fail "cold release: live is '$(live_service)', expected $cold_expect"
[ "$(load_failed /login)" = 0 ] || fail "cold release: the frontend failed $(load_failed /login) requests"
assert_clean "cold release"
report "7. cold fallback: $(load_total) requests; backend route failed $(load_failed /health) (expected: stop-then-start), frontend failed $(load_failed /login)"

echo
echo "all release.sh scenarios passed"
printf '%s' "$RESULTS"
