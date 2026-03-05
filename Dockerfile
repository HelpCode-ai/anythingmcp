# =============================================================================
# AnythingMCP — Unified (Backend + Frontend) Multi-Stage Dockerfile
# =============================================================================
# Single container running both NestJS backend (port 4000) and
# Next.js frontend (port 3000) on the same Node.js runtime.
# =============================================================================

# ── Stage 1: Install ALL dependencies ───────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies
RUN npm ci

# ── Stage 2: Build Backend ──────────────────────────────────────────────────
FROM node:22-alpine AS backend-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY package.json package-lock.json ./
COPY packages/backend/ ./packages/backend/

WORKDIR /app/packages/backend
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
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/package.json ./backend/

# Backend node_modules (production deps)
COPY --from=deps /app/node_modules ./backend/node_modules
COPY --from=backend-builder --chown=appuser:appuser /app/packages/backend/node_modules/.prisma ./backend/node_modules/.prisma

# ── Frontend artifacts (Next.js standalone) ──
COPY --from=frontend-builder /app/packages/frontend/public ./frontend/public
COPY --from=frontend-builder --chown=appuser:appuser /app/packages/frontend/.next/standalone ./frontend/
COPY --from=frontend-builder --chown=appuser:appuser /app/packages/frontend/.next/static ./frontend/.next/static

# ── Startup script ──
COPY --chown=appuser:appuser start.sh ./start.sh
RUN chmod +x ./start.sh

USER appuser
EXPOSE 3000 4000

CMD ["./start.sh"]
