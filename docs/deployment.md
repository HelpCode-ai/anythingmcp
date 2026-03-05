# Deployment Guide

> Docker setup, production deployment, local development, reverse proxy, and environment configuration.

[Back to README](../README.md)

---

## Quick Start (Docker)

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp
cp .env.example .env
# Edit .env — set JWT_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD
docker compose up -d
open http://localhost:3000
```

The first user to register becomes **Admin**.

### Docker Services

| Container | Description | Port |
|-----------|-------------|------|
| `atmcp-app` | Next.js 16 + NestJS 11 (single image) | 3000, 4000 |
| `atmcp-postgres` | PostgreSQL 17 | 5432 |
| `atmcp-redis` | Redis 7 (optional) | 6379 |

> **Note:** Frontend and backend run in a single container since both are Node.js. A lightweight startup script (`start.sh`) manages both processes.

### Service URLs

| Service | URL |
|---------|-----|
| Web UI | `http://localhost:3000` |
| Backend API | `http://localhost:4000` |
| MCP Endpoint | `http://localhost:4000/mcp` |
| Swagger Docs | `http://localhost:4000/api/docs` |
| Health Check | `http://localhost:4000/health` |

---

## Local Development

Run PostgreSQL in Docker, frontend and backend locally with hot reload.

### Prerequisites

- **Node.js** 22+
- **npm** 9+
- **Docker** and **Docker Compose** (for PostgreSQL)

### Setup

```bash
cd anythingmcp
cp .env.example .env
```

Edit `.env` for local development (note: PostgreSQL on port 5433):

```env
NODE_ENV=development
PORT=4000
POSTGRES_PASSWORD=your-local-password
DATABASE_URL=postgresql://atmcp:your-local-password@localhost:5433/anythingmcp
# REDIS_URL=redis://localhost:6379  # Optional — enables caching and rate limiting
JWT_SECRET=local-dev-secret-at-least-32-chars!!
ENCRYPTION_KEY=local-dev-key-exactly-32-chars!!
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=local-dev-nextauth-secret-32-chars!!
CORS_ORIGIN=http://localhost:3000
```

```bash
# Start PostgreSQL (dev overlay disables the app container)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

# Install dependencies
npm install

# Symlink .env into package directories (Prisma & Next.js need it)
ln -sf ../../.env packages/backend/.env
ln -sf ../../.env packages/frontend/.env

# Export env vars (Prisma CLI reads DATABASE_URL from shell)
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Run migrations and generate Prisma client
cd packages/backend
npx prisma migrate dev
npx prisma generate
cd ../..

# Start both backend and frontend
npm run dev
```

Or run separately:

```bash
npm run dev:backend   # Terminal 1 — NestJS with hot reload
npm run dev:frontend  # Terminal 2 — Next.js with Turbopack
```

### Useful Commands

```bash
npm test                                             # Run all tests
cd packages/backend && npm test                      # Backend tests only
cd packages/backend && npx prisma studio             # DB browser
cd packages/backend && npx prisma migrate dev --name describe_change  # New migration
cd packages/backend && npx prisma migrate reset      # Reset DB
npm run build                                        # Production build
docker compose -f docker-compose.yml -f docker-compose.dev.yml down    # Stop
docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v # Stop + wipe DB
```

---

## Production Deployment

### With Docker (Recommended)

```bash
cp .env.example .env
# Set strong values for: JWT_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD, NEXTAUTH_SECRET
# Set MCP_BEARER_TOKEN or MCP_API_KEY for MCP endpoint auth
docker compose up -d --build
curl http://localhost:4000/health
```

The container runs `prisma migrate deploy` on startup, then launches both backend and frontend.

### Without Docker

```bash
# Ensure PostgreSQL 17+ is running externally
# Configure .env with correct DATABASE_URL
# Optionally run Redis 7+ and set REDIS_URL for caching and rate limiting

# Build
cd packages/backend && npm ci && npx prisma generate && npm run build
cd packages/frontend && npm ci && npm run build

# Migrate
cd packages/backend && npx prisma migrate deploy

# Start
cd packages/backend && node dist/main.js
cd packages/frontend && npm start
```

---

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    # Frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:4000;
    }

    # MCP endpoint
    location /mcp {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:4000;
    }
}
```

---

## Authentication

### MCP Auth Modes

Configure `MCP_AUTH_MODE` in `.env`:

| Mode | Description |
|------|-------------|
| `oauth2` | OAuth 2.0 Authorization Code (PKCE) + Client Credentials **(default)** |
| `legacy` | Static Bearer Token (`MCP_BEARER_TOKEN`) or API Key (`MCP_API_KEY`) |
| `both` | Accepts either OAuth2 or legacy tokens |
| `none` | No authentication (development only) |

### Legacy Auth

Set in `.env`:
```env
MCP_AUTH_MODE=legacy
MCP_BEARER_TOKEN=your-secure-bearer-token
MCP_API_KEY=your-secure-api-key
```

### OAuth2

The OAuth2 discovery endpoint is at:
```
GET http://your-server:4000/.well-known/oauth-authorization-server
```

Supports:
- **Authorization Code + PKCE** — For interactive clients
- **Client Credentials** — For server-to-server integrations

### Per-User API Keys

Generate in the UI or via API:
```bash
curl -s http://localhost:4000/api/mcp-api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Key"}'
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret (min 32 chars) |
| `ENCRYPTION_KEY` | Yes | AES-256-GCM key (exactly 32 chars) |
| `PORT` | No | Backend port (default: 4000) |
| `REDIS_URL` | No | Redis URL (optional — enables response caching and rate limiting) |
| `CORS_ORIGIN` | No | Allowed origin (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | No | Backend URL for frontend (default: `http://localhost:4000`) |
| `NEXTAUTH_URL` | No | NextAuth callback URL (default: `http://localhost:3000`) |
| `NEXTAUTH_SECRET` | No | NextAuth secret for frontend |
| `FRONTEND_URL` | No | Frontend URL for email links (default: `http://localhost:3000`) |
| `MCP_AUTH_MODE` | No | MCP auth: `none`, `legacy`, `oauth2`, `both` (default: `oauth2`) |
| `MCP_BEARER_TOKEN` | No | Bearer token for legacy MCP auth |
| `MCP_API_KEY` | No | API key for legacy MCP auth |
| `SERVER_URL` | No | Server URL for OAuth2 metadata (default: `http://localhost:4000`) |
| `MCP_RATE_LIMIT_PER_MINUTE` | No | Rate limit per client (default: 60) |

---

[Back to README](../README.md) | [API Reference](api-reference.md) | [Integration Guides](../README.md#connect-your-ai-client)
