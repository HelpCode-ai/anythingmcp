# =============================================================================
# AnythingToMCP — Backend (NestJS) Multi-Stage Dockerfile
# =============================================================================

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/

# Install backend dependencies using workspace
RUN npm ci --workspace=packages/backend --include-workspace-root

# ── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY package.json package-lock.json ./
COPY packages/backend/ ./packages/backend/

# Generate Prisma client and build
WORKDIR /app/packages/backend
RUN npx prisma generate
RUN npm run build

# ── Stage 3: Production ─────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache wget
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nestjs && \
    adduser --system --uid 1001 nestjs

# Copy built application
COPY --from=builder --chown=nestjs:nestjs /app/packages/backend/dist ./dist
COPY --from=builder --chown=nestjs:nestjs /app/packages/backend/prisma ./prisma
COPY --from=builder --chown=nestjs:nestjs /app/packages/backend/package.json ./

# Copy production node_modules (re-install prod-only for smaller image)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nestjs /app/packages/backend/node_modules/.prisma ./node_modules/.prisma

USER nestjs
EXPOSE 4000
ENV PORT=4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
