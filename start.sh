#!/bin/sh
# =============================================================================
# AnythingMCP — container startup script
#
#   ./start.sh            backend + frontend in ONE container (default; the
#                         self-hosted quickstart and docker-compose.yml)
#   ./start.sh backend    NestJS backend only, port 4000
#   ./start.sh frontend   Next.js frontend only, port 3000
#
# Why the modes exist: on 2026-09-20 the cloud backend exhausted its heap four
# times in an afternoon. In the single-container layout the liveness loop at
# the bottom of this file did exactly what it was written to do — noticed the
# backend was gone and shut the container down so Docker would restart it —
# and every restart took the frontend, and every tenant's MCP endpoint, down
# with it. A backend crash should restart the backend. The cloud compose file
# therefore runs two containers from this same image, one per mode.
#
# In `backend` and `frontend` mode the process is exec'd as PID 1: a SIGTERM
# from `docker stop`, or the one the backend sends itself when its heap guard
# trips, reaches Node directly, and when Node exits the container exits and
# `restart: unless-stopped` brings it back. No loop, no trap, nothing to get
# wrong. The `all` mode keeps the original behaviour unchanged.
# =============================================================================

MODE="${1:-all}"

run_migrations() {
  echo "==> Running database migrations..."
  cd /app/backend
  # A failed migration used to be ignored: the backend started anyway, against a
  # schema that was empty or half-applied, and the first query died with a
  # confusing "relation does not exist" a dozen lines later. Fail here instead,
  # where the error still says what actually went wrong. Docker's restart policy
  # retries, which is also the right behaviour when the database is simply not
  # accepting connections yet.
  if ! npx prisma migrate deploy; then
    echo "==> Migrations failed — refusing to start against an unknown schema." >&2
    exit 1
  fi
}

# Cap the V8 heap so a runaway allocation fails *this* process instead of
# OOM-killing the whole host. Override via NODE_MAX_OLD_SPACE_MB; default 2048
# suits a ~4GB host. The backend's own heap guard (see
# packages/backend/src/common/process-vitals.ts) exits gracefully at a
# percentage of whatever this is, before V8 hits the wall.
BACKEND_CMD="node --max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-2048} dist/src/main.js"

case "$MODE" in
  backend)
    run_migrations
    echo "==> Starting backend (port 4000) as PID 1..."
    cd /app/backend
    exec $BACKEND_CMD
    ;;

  frontend)
    echo "==> Starting frontend (port 3000) as PID 1..."
    # Next.js standalone in a monorepo preserves the workspace directory structure
    cd /app/frontend/packages/frontend
    HOSTNAME=0.0.0.0 PORT=3000 exec node server.js
    ;;

  all)
    # Trap to clean up child processes on exit
    cleanup() {
      echo "==> Shutting down..."
      kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
      wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
      exit 0
    }
    trap cleanup TERM INT

    run_migrations

    echo "==> Starting backend (port 4000)..."
    cd /app/backend
    $BACKEND_CMD &
    BACKEND_PID=$!

    echo "==> Starting frontend (port 3000)..."
    cd /app/frontend/packages/frontend
    HOSTNAME=0.0.0.0 PORT=3000 node server.js &
    FRONTEND_PID=$!

    echo "==> AnythingMCP running — backend PID=$BACKEND_PID, frontend PID=$FRONTEND_PID"

    # If EITHER process dies (e.g. the backend is OOM-killed), exit so Docker's
    # `restart: unless-stopped` brings the container back — instead of leaving a
    # half-broken container up (a dead backend behind a live frontend serving 502s,
    # which previously needed a manual restart). POSIX `wait pid1 pid2` waits for
    # BOTH to exit, so we poll liveness instead.
    while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
      sleep 5
    done
    echo "==> A process exited unexpectedly, shutting down so the container restarts..."
    cleanup
    ;;

  *)
    echo "Usage: $0 [all|backend|frontend]  (got: '$MODE')" >&2
    exit 64
    ;;
esac
