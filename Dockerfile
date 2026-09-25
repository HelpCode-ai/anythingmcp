# syntax=docker/dockerfile:1
# =============================================================================
# AnythingMCP — Unified (Backend + Frontend) Multi-Stage Dockerfile
# =============================================================================
# Single container running both NestJS backend (port 4000) and
# Next.js frontend (port 3000) on the same Node.js runtime.
# =============================================================================

# ── OCI Image Labels ──────────────────────────────────────────────────────────
# These labels follow the OCI image spec and are used by Docker Hub, GitHub
# Container Registry, and other registries to display image metadata.
# ─────────────────────────────────────────────────────────────────────────────

# Node runtime version, declared once and reused by every stage below so the
# image always builds on a single, consistent Node major. The supported minimum
# for local development is Node 22 (see "engines" in package.json); the shipped
# image tracks a newer release. Override with --build-arg NODE_VERSION=24-alpine.
ARG NODE_VERSION=26-alpine

# ── Stage 1: Install ALL dependencies ───────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies
# Extended timeout for ARM64 QEMU emulation in CI
RUN npm ci --network-timeout 600000

# ── Stage 1b: Backend production deps only ────────────────────────────────
FROM node:${NODE_VERSION} AS backend-prod-deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/

# Stub the frontend workspace with zero deps so npm won't hoist any frontend
# packages — only backend production dependencies end up in node_modules.
RUN mkdir -p packages/frontend && \
    echo '{"name":"@anythingmcp/frontend","version":"0.1.1","private":true}' > packages/frontend/package.json

RUN npm install --omit=dev --network-timeout=600000 && \
    rm -rf node_modules/typescript node_modules/react-dom node_modules/react

# ── Stage 2: Build Backend ──────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS backend-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY package.json package-lock.json ./
COPY packages/backend/ ./packages/backend/
# The backend's `prebuild` hook runs scripts/regenerate-catalog.mjs to keep
# catalog.ts in sync with the adapter JSON files. The script lives outside
# packages/backend, so we copy it into the image (one tiny file, no deps).
COPY scripts/regenerate-catalog.mjs ./scripts/regenerate-catalog.mjs

WORKDIR /app/packages/backend
# Dummy URL so prisma.config.ts can resolve DATABASE_URL at generate time
# (no actual connection is made during generate)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npx prisma generate
RUN npm run build

# ── Stage 3: Build Frontend ─────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS frontend-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/frontend/node_modules ./packages/frontend/node_modules
COPY package.json package-lock.json ./
COPY packages/frontend/ ./packages/frontend/

ENV NEXT_TELEMETRY_DISABLED=1

# Sentry: the commit being built names the release. The auth token for the
# source map upload is a BuildKit secret, never an ARG, so it cannot end up in
# a layer or `docker history`. Without it (any build but our publish workflow)
# the upload is skipped; the maps are deleted from the output either way.
ARG SENTRY_RELEASE=
ENV SENTRY_RELEASE=$SENTRY_RELEASE

WORKDIR /app/packages/frontend
RUN --mount=type=secret,id=sentry_auth_token \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" && \
    echo "Sentry auth token: $([ -n "$SENTRY_AUTH_TOKEN" ] && echo present || echo absent)" && \
    npm run build

# ── Stage 4: Production ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache wget
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Release reported by backend and frontend when an operator sets SENTRY_DSN.
ARG SENTRY_RELEASE=
ENV SENTRY_RELEASE=$SENTRY_RELEASE

RUN addgroup --system --gid 1001 appuser && \
    adduser --system --uid 1001 appuser

# ── Backend artifacts ──
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/dist ./backend/dist
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/prisma ./backend/prisma
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/prisma.config.ts ./backend/
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/package.json ./backend/

# Backend node_modules — only backend production deps (no frontend, no devDeps)
COPY --from=backend-prod-deps /app/node_modules ./backend/node_modules

# ── Frontend artifacts (Next.js standalone) ──
# In a monorepo, Next.js standalone output preserves the workspace directory
# structure: .next/standalone/ contains the workspace root with node_modules,
# and the app files live at .next/standalone/packages/frontend/.
COPY --from=frontend-builder --chown=appuser:appuser /app/packages/frontend/.next/standalone ./frontend/
COPY --from=frontend-builder --chown=appuser:appuser /app/packages/frontend/.next/static ./frontend/packages/frontend/.next/static
COPY --from=frontend-builder --chown=appuser:appuser /app/packages/frontend/public ./frontend/packages/frontend/public

# ── Startup script ──
COPY --chown=appuser:appuser start.sh ./start.sh
RUN chmod +x ./start.sh

# ── Diagnostics ──
# Where the backend's heap guard writes its one-per-process heap snapshot
# (packages/backend/src/common/process-vitals.service.ts). Created here so the
# unprivileged user can write to it and so a deployment can mount a volume on
# a path that is known to exist; the cloud compose file does exactly that.
RUN mkdir -p /app/diagnostics && chown appuser:appuser /app/diagnostics
ENV HEAP_SNAPSHOT_DIR=/app/diagnostics

LABEL org.opencontainers.image.title="AnythingMCP" \
      org.opencontainers.image.description="Convert any API into an MCP server — REST, SOAP, GraphQL, Database, MCP Bridge. Self-hosted MCP middleware." \
      org.opencontainers.image.url="https://github.com/HelpCode-ai/anythingmcp" \
      org.opencontainers.image.source="https://github.com/HelpCode-ai/anythingmcp" \
      org.opencontainers.image.documentation="https://github.com/HelpCode-ai/anythingmcp#readme" \
      org.opencontainers.image.vendor="helpcode.ai GmbH" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

USER appuser
EXPOSE 3000 4000

# Health check — backend exposes /health on port 4000.
# start-period must exceed cold-start time: the app loads the full connector/tool
# catalog on boot (can be ~90s+ with a large catalog). During start-period a
# failing probe keeps the container "starting" (not "unhealthy"), so orchestrators
# that gate on health don't abort a deploy that is still legitimately coming up.
# 30s interval, 5s timeout, 120s start period, 3 retries before unhealthy.
#
# This is the check for the default `all` mode and for `backend` mode. A
# container run in `frontend` mode has no port 4000; a compose file that runs
# that mode overrides this with a probe of port 3000 (see docker-compose.cloud.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1

# `./start.sh backend` or `./start.sh frontend` for one process per container.
CMD ["./start.sh"]
