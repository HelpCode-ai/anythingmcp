# =============================================================================
# AnythingToMCP — Backend (NestJS) Multi-Stage Dockerfile
# =============================================================================

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY packages/backend/package.json packages/backend/package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY packages/backend/ ./
COPY --from=deps /app/node_modules ./node_modules
RUN npx prisma generate
RUN npm run build

# ── Stage 3: Production ─────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache wget

RUN addgroup --system --gid 1001 nestjs && \
    adduser --system --uid 1001 nestjs

COPY --from=builder --chown=nestjs:nestjs /app/dist ./dist
COPY --from=deps --chown=nestjs:nestjs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nestjs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nestjs /app/node_modules/.prisma ./node_modules/.prisma
COPY packages/backend/package.json ./

USER nestjs
EXPOSE 4000
ENV PORT=4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
