# Deployment Guide

> Docker setup, production deployment, local development, reverse proxy, and environment configuration.

[Back to README](../README.md)

---

## One-Click Deploy

The fastest way to get AnythingMCP running — no local setup required:

| Platform | Link |
|----------|------|
| **Railway** | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **DigitalOcean Marketplace** | [![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp) |

- **Railway** builds the container and provisions a managed PostgreSQL database automatically. Fill in the environment variables and click Deploy.
- **DigitalOcean Marketplace** creates a pre-configured Droplet with AnythingMCP installed. Choose your droplet size and region, then open the droplet IP in your browser.

In both cases, the first user to register becomes **Admin**.

---

## Quick Start (Docker)

The fastest way to get started — the interactive setup script handles everything:

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp
./setup.sh
```

The script asks a few questions and then:
- Generates `.env` with all secrets (JWT, encryption keys, DB password)
- For production domains: generates a `Caddyfile` and enables Caddy reverse proxy with automatic HTTPS
- Starts all services via Docker Compose
- Waits for the health check to pass

The first user to register becomes **Admin**.

> **Prefer manual setup?** Copy `.env.example` to `.env`, edit the values, and run `docker compose up -d`.

### Docker Services

| Container | Description | Port |
|-----------|-------------|------|
| `amcp-app` | Next.js 16 + NestJS 11 (single image) | 3000, 4000 |
| `amcp-postgres` | PostgreSQL 17 | 5432 |
| `amcp-caddy` | Caddy 2 reverse proxy (optional — HTTPS) | 80, 443 |
| `amcp-redis` | Redis 7 (optional) | 6379 |

> **Note:** Frontend and backend run in a single container since both are Node.js. A lightweight startup script (`start.sh`) manages both processes. Caddy is optional and only starts when `COMPOSE_PROFILES=proxy` is set.

### Service URLs

| Service | URL (localhost) | URL (with Caddy) |
|---------|-----------------|-------------------|
| Web UI | `http://localhost:3000` | `https://yourdomain.com` |
| Backend API | `http://localhost:4000` | `https://yourdomain.com/api` |
| MCP Endpoint | `http://localhost:4000/mcp` | `https://yourdomain.com/mcp` |
| Swagger Docs | `http://localhost:4000/api/docs` | `https://yourdomain.com/api/docs` |
| Health Check | `http://localhost:4000/health` | `https://yourdomain.com/health` |

---

## Local Development

Run PostgreSQL in Docker, frontend and backend locally with hot reload.

### Prerequisites

- **Node.js** 22+
- **npm** 9+
- **Docker** and **Docker Compose** (for PostgreSQL)

### Setup (Automated)

The easiest way — use the setup script and choose "Local development":

```bash
cd anythingmcp
./setup.sh    # Choose option 2: "Local development"
npm run dev
```

The script generates `.env` with auto-generated secrets, starts PostgreSQL in Docker, installs npm dependencies, and runs database migrations.

### Setup (Manual)

```bash
cd anythingmcp
cp .env.example .env
```

Edit `.env` for local development (note: PostgreSQL on port 5433):

```env
NODE_ENV=development
PORT=4000
POSTGRES_PASSWORD=your-local-password
DATABASE_URL=postgresql://amcp:your-local-password@localhost:5433/anythingmcp
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

### With Docker + Setup Script (Recommended)

```bash
./setup.sh    # Choose Docker mode, enter your domain, enable HTTPS
```

When you enter a domain (not `localhost`), the script offers to enable **Caddy** reverse proxy with automatic Let's Encrypt SSL. This generates a `Caddyfile` and sets `COMPOSE_PROFILES=proxy` in `.env` so Caddy starts automatically.

### With Docker (Manual)

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

## Reverse Proxy & HTTPS

### Caddy (Recommended — Automatic SSL)

The setup script (`./setup.sh`) automatically generates a `Caddyfile` and enables Caddy when you choose HTTPS for a production domain. Caddy handles:

- **Automatic Let's Encrypt certificates** — no manual cert management
- **HTTP → HTTPS redirect** — all traffic encrypted
- **Path-based routing** — backend API, MCP, OAuth2 endpoints routed to port 4000; everything else to the frontend

The generated `Caddyfile` looks like:

```caddyfile
yourdomain.com {
    tls admin@yourdomain.com

    # Backend API, MCP, OAuth2, health
    reverse_proxy /api/*          app:4000
    reverse_proxy /mcp/*          app:4000
    reverse_proxy /health/*       app:4000
    reverse_proxy /.well-known/*  app:4000
    reverse_proxy /authorize      app:4000
    reverse_proxy /token          app:4000
    reverse_proxy /register       app:4000
    reverse_proxy /auth/*         app:4000

    # Frontend (catch-all)
    reverse_proxy app:3000
}
```

To enable Caddy manually (without the setup script), add these to your `.env`:

```env
COMPOSE_PROFILES=proxy
DOMAIN=yourdomain.com
ACME_EMAIL=admin@yourdomain.com
APP_BIND_IP=127.0.0.1
```

Then create a `Caddyfile` in the project root (see example above) and run `docker compose up -d`.

> **Note:** When Caddy is enabled, `APP_BIND_IP=127.0.0.1` restricts the app's ports (3000/4000) to localhost only. All external traffic goes through Caddy on ports 80/443.

### nginx (Alternative)

If you prefer nginx, configure it to route backend paths to port 4000 and everything else to port 3000:

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    # Backend API, MCP, OAuth2
    location /api/ {
        proxy_pass http://localhost:4000;
    }
    location /mcp {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
    }
    location /health {
        proxy_pass http://localhost:4000;
    }
    location /.well-known/ {
        proxy_pass http://localhost:4000;
    }
    location /authorize {
        proxy_pass http://localhost:4000;
    }
    location /token {
        proxy_pass http://localhost:4000;
    }
    location /auth/ {
        proxy_pass http://localhost:4000;
    }

    # Frontend (catch-all)
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
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
| `COMPOSE_PROFILES` | No | Set to `proxy` to enable Caddy reverse proxy |
| `DOMAIN` | No | Domain for Caddy SSL certificate (e.g., `example.com`) |
| `ACME_EMAIL` | No | Email for Let's Encrypt certificate notifications |
| `APP_BIND_IP` | No | Bind IP for app ports (default: `0.0.0.0`, set `127.0.0.1` behind Caddy) |

---

## External Services

AnythingMCP is fully self-hosted, but makes **optional** network calls to `anythingmcp.com` in two specific cases. This section documents exactly what is sent and when, so you can make an informed decision.

### License Verification

**When:** Only if you activate a license key (community or commercial). Not called if no license key is configured.

**What happens:**
- On startup (at most once every 24 hours), the backend verifies the license key against `anythingmcp.com/api/license/verify`
- When you activate a license, a request is sent to `anythingmcp.com/api/license/activate`
- When you request a community license, a request is sent to `anythingmcp.com/api/license/register`

**Data sent:**
- License key
- Instance ID (a random UUID generated on first startup, used to identify the installation)
- Email and name (only during community license registration)

**Data NOT sent:** No API credentials, connector configurations, tool definitions, user data, audit logs, or any operational data.

**If the service is unreachable:** The application continues to work normally. License verification failures are logged as warnings and do not block functionality.

### Email Fallback

**When:** Only if SMTP is **not** configured and the application needs to send an email (invitations, welcome emails, email verification).

**What happens:**
- The backend sends the email content to `anythingmcp.com/api/email/*` endpoints
- The external service delivers the email on behalf of the instance

**Data sent:**
- Recipient email address
- Email content (invitation URL, verification code, welcome message, license key)
- License key (if configured)

**How to disable:** Configure SMTP in your `.env` or via the admin UI. When SMTP is configured, the external email fallback is never used. Password reset emails are **never** sent through the external fallback, only via SMTP.

### Network Diagram

```
AnythingMCP Instance                    anythingmcp.com
┌──────────────────┐                   ┌──────────────────┐
│                  │── license/verify ──►│                  │
│  License Service │── license/activate ►│  License API     │
│                  │── license/register ►│                  │
│                  │                    │                  │
│  Email Service   │── email/invite ────►│  Email Relay     │
│  (SMTP fallback) │── email/welcome ───►│  (fallback only) │
│                  │── email/verify ────►│                  │
└──────────────────┘                   └──────────────────┘
        │
        │  Your API credentials, tool definitions,
        │  audit logs, and user data NEVER leave
        │  your instance.
        │
```

### Fully Offline Mode

To run AnythingMCP with zero external calls:

1. **Skip license activation** — The application works without a license key (community features)
2. **Configure SMTP** — Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` in your environment or via the admin Settings page

With both of these in place, AnythingMCP makes no outbound connections to `anythingmcp.com`.

---

[Back to README](../README.md) | [API Reference](api-reference.md) | [Integration Guides](../README.md#connect-your-ai-client)
