#!/bin/sh
# =============================================================================
# AnythingMCP — Unified container startup script
# Runs NestJS backend and Next.js frontend in the same container.
# =============================================================================

# Trap to clean up child processes on exit
cleanup() {
  echo "==> Shutting down..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

echo "==> Running database migrations..."
cd /app/backend
npx prisma migrate deploy

echo "==> Starting backend (port 4000)..."
node dist/main.js &
BACKEND_PID=$!

echo "==> Starting frontend (port 3000)..."
# Next.js standalone in a monorepo preserves the workspace directory structure
cd /app/frontend/packages/frontend
HOSTNAME=0.0.0.0 PORT=3000 node server.js &
FRONTEND_PID=$!

echo "==> AnythingMCP running — backend PID=$BACKEND_PID, frontend PID=$FRONTEND_PID"

# Wait for both processes — if either exits, the wait returns and we shut down
wait "$BACKEND_PID" "$FRONTEND_PID"
echo "==> A process exited unexpectedly, shutting down..."
cleanup
