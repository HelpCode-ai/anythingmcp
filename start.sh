#!/bin/sh
# =============================================================================
# AnythingMCP — Unified container startup script
# Runs NestJS backend and Next.js frontend in the same container.
# =============================================================================

set -e

echo "==> Running database migrations..."
cd /app/backend
npx prisma migrate deploy

echo "==> Starting backend (port 4000)..."
node dist/main.js &
BACKEND_PID=$!

echo "==> Starting frontend (port 3000)..."
cd /app/frontend
HOSTNAME=0.0.0.0 PORT=3000 node server.js &
FRONTEND_PID=$!

echo "==> AnythingMCP running — backend PID=$BACKEND_PID, frontend PID=$FRONTEND_PID"

# Wait for either process to exit; if one dies, stop the other
wait -n $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
echo "==> One process exited, shutting down..."
kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
wait
exit 1
