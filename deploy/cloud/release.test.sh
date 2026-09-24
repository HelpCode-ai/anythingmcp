#!/usr/bin/env bash
# =============================================================================
# Exercises deploy/cloud/release.sh against a throwaway stack: a Caddy in front
# of a backend and a frontend built from a tiny test image. Needs Docker.
#
#   bash deploy/cloud/release.test.sh
#
# Scenarios:
#   1. a healthy release goes live, exit 0;
#   2. a release whose image never becomes healthy is rolled back: exit 1, the
#      previous image and compose file are back and the site answers;
#   3. a release whose compose change breaks the app (the 2026-09-24 case: an
#      env var the image could not start with) is rolled back the same way.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PROJECT="amcprt$$"
IMAGE="amcp-release-test"
PORT="${PORT:-18080}"

cleanup() {
  (cd "$WORK/app" 2>/dev/null && docker compose -p "$PROJECT" -f docker-compose.cloud.yml down -v --remove-orphans >/dev/null 2>&1) || true
  docker rmi -f "${IMAGE}:latest" "${IMAGE}:rollback" "${IMAGE}:good" "${IMAGE}:good2" "${IMAGE}:bad" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── Test image: answers 200 on the three probed paths, unless BROKEN is set,
# in which case it never becomes healthy (like a backend that refuses to boot).
mkdir -p "$WORK/img" "$WORK/app" "$WORK/staged"
cat > "$WORK/img/server.py" <<'EOF'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
if os.environ.get("BROKEN"):
    print("refusing to start", flush=True); sys.exit(1)
class H(BaseHTTPRequestHandler):
    def _answer(self):
        ok = self.path.split("?")[0] in ("/health", "/mcp/demo", "/login")
        self.send_response(200 if ok else 404); self.end_headers()
        self.wfile.write(os.environ.get("RELEASE", "?").encode())
    do_GET = do_POST = _answer
    def log_message(self, *a): pass
HTTPServer(("0.0.0.0", 8000), H).serve_forever()
EOF
cat > "$WORK/img/Dockerfile" <<'EOF'
FROM python:3-alpine
COPY server.py /server.py
ARG RELEASE=unset
ENV RELEASE=$RELEASE
CMD ["python", "/server.py"]
EOF
docker build -q -t "${IMAGE}:good" --build-arg RELEASE=good "$WORK/img" >/dev/null
docker build -q -t "${IMAGE}:good2" --build-arg RELEASE=good2 "$WORK/img" >/dev/null
docker build -q -t "${IMAGE}:bad" --build-arg RELEASE=bad -f - "$WORK/img" >/dev/null <<'EOF'
FROM python:3-alpine
COPY server.py /server.py
ENV RELEASE=bad BROKEN=1
CMD ["python", "/server.py"]
EOF

compose_file() { # $1 = extra env line for the backend (may be empty)
  cat <<EOF
services:
  backend:
    image: ${IMAGE}:latest
    container_name: ${PROJECT}-backend
    environment:
      - PLACEHOLDER=1
$1
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8000/health"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 8s
      start_interval: 1s
    restart: unless-stopped
  frontend:
    image: ${IMAGE}:latest
    container_name: ${PROJECT}-frontend
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8000/login"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 8s
      start_interval: 1s
    restart: unless-stopped
  caddy:
    image: caddy:2-alpine
    container_name: ${PROJECT}-caddy
    ports: ["${PORT}:8080"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]
EOF
}
cat > "$WORK/staged/Caddyfile" <<'EOF'
:8080 {
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

release() { # runs release.sh against the test stack; prints its exit code
  set +e
  APP_DIR="$WORK/app" COMPOSE_FILE=docker-compose.cloud.yml IMAGE="$IMAGE" \
  NEW_COMPOSE="$WORK/staged/docker-compose.cloud.yml" NEW_CADDYFILE="$WORK/staged/Caddyfile" \
  BACKEND_CONTAINER="${PROJECT}-backend" CADDY_CONTAINER="${PROJECT}-caddy" \
  SITE_URL="http://localhost:${PORT}" WAIT_TIMEOUT=20 PROBE_TRIES=5 PROBE_DELAY=1 \
  COMPOSE_PROJECT_NAME="$PROJECT" \
    bash "$HERE/release.sh" >"$WORK/release.log" 2>&1
  local code=$?
  set -e
  echo "$code"
}
serving() { curl -s "http://localhost:${PORT}/login"; }
fail() { echo "FAIL: $*"; echo "--- release.sh output ---"; cat "$WORK/release.log"; exit 1; }

# ── Initial deploy: good ──
docker tag "${IMAGE}:good" "${IMAGE}:latest"
compose_file "" > "$WORK/app/docker-compose.cloud.yml"
cp "$WORK/staged/Caddyfile" "$WORK/app/Caddyfile"
(cd "$WORK/app" && docker compose -p "$PROJECT" -f docker-compose.cloud.yml up -d --wait --wait-timeout 30 >/dev/null 2>&1)
[ "$(serving)" = good ] || fail "initial stack does not serve 'good'"

# ── 1. healthy release ──
docker tag "${IMAGE}:good2" "${IMAGE}:latest"
compose_file "" > "$WORK/staged/docker-compose.cloud.yml"
code=$(release)
[ "$code" = 0 ] || fail "healthy release exited $code"
[ "$(serving)" = good2 ] || fail "healthy release: site serves '$(serving)'"
echo "ok   1. healthy release goes live"

# ── 2. broken image ──
docker tag "${IMAGE}:bad" "${IMAGE}:latest"
code=$(release)
[ "$code" = 1 ] || fail "broken image: release.sh exited $code, expected 1"
[ "$(serving)" = good2 ] || fail "broken image: site serves '$(serving)', expected the previous release"
grep -q "rolled back" "$WORK/release.log" || fail "broken image: no rollback message"
echo "ok   2. broken image is rolled back, previous release serving"

# ── 3. broken compose (same image, an env var it cannot start with) ──
docker tag "${IMAGE}:good2" "${IMAGE}:latest"
compose_file "      - BROKEN=1" > "$WORK/staged/docker-compose.cloud.yml"
code=$(release)
[ "$code" = 1 ] || fail "broken compose: release.sh exited $code, expected 1"
[ "$(serving)" = good2 ] || fail "broken compose: site serves '$(serving)'"
grep -q "BROKEN" "$WORK/app/docker-compose.cloud.yml" && fail "broken compose: compose file was not restored"
echo "ok   3. broken compose is rolled back, previous compose restored"

echo "all release.sh scenarios passed"
