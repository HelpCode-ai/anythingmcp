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

# ── Stage 1: Install ALL dependencies ───────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies
# Extended timeout for ARM64 QEMU emulation in CI
RUN npm ci --network-timeout 600000

# ── Stage 2: Build Backend ──────────────────────────────────────────────────
FROM node:22-alpine AS backend-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY package.json package-lock.json ./
COPY packages/backend/ ./packages/backend/

WORKDIR /app/packages/backend
# Dummy URL so prisma.config.ts can resolve DATABASE_URL at generate time
# (no actual connection is made during generate)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npx prisma generate
RUN npm run build

# ── Stage 3: Build Frontend ─────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/frontend/node_modules ./packages/frontend/node_modules
COPY package.json package-lock.json ./
COPY packages/frontend/ ./packages/frontend/

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/packages/frontend
RUN npm run build

# ── Stage 4: Production ─────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache wget
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 appuser && \
    adduser --system --uid 1001 appuser

# ── Backend artifacts ──
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/dist ./backend/dist
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/prisma ./backend/prisma
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/prisma.config.ts ./backend/
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/package.json ./backend/

# Backend node_modules (Prisma 7 client is compiled into dist/ by NestJS build)
COPY --from=deps /app/node_modules ./backend/node_modules

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

LABEL org.opencontainers.image.title="AnythingMCP" \
      org.opencontainers.image.description="Convert any API into an MCP server — REST, SOAP, GraphQL, Database, MCP Bridge. Self-hosted MCP middleware." \
      org.opencontainers.image.url="https://github.com/HelpCode-ai/anythingmcp" \
      org.opencontainers.image.source="https://github.com/HelpCode-ai/anythingmcp" \
      org.opencontainers.image.documentation="https://github.com/HelpCode-ai/anythingmcp#readme" \
      org.opencontainers.image.vendor="helpcode.ai GmbH" \
      org.opencontainers.image.licenses="BSL-1.1"

USER appuser
EXPOSE 3000 4000

CMD ["./start.sh"]
