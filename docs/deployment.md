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

### Coolify

[`docker-compose.coolify.yml`](../docker-compose.coolify.yml) runs AnythingMCP on a [Coolify](https://coolify.io) v4 server. It pulls the published image and starts PostgreSQL next to it.

1. In Coolify, create a **Docker Compose** resource. Either point it at this repository with `docker-compose.coolify.yml` as the compose file, or paste the file into an empty compose resource.
2. Under **Domains**, give the `app` service your domain with the `:3000` suffix, for example `https://mcp.example.com:3000`. The suffix tells Coolify's proxy which container port to use; visitors still connect on 443.
3. Fill in the required SMTP variables, then deploy: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Coolify blocks the deploy until they are set.

   The app's public URL is filled in from the domain automatically, without the port: the file uses Coolify's `SERVICE_URL_APP`, not `SERVICE_URL_APP_3000`, which keeps the `:3000` suffix and breaks the OAuth sign-in redirect. Set `PUBLIC_URL` (for example `https://mcp.example.com`) only to override it. Redeploy after you change the domain.

   Coolify generates `JWT_SECRET`, `COOKIE_SECRET`, `ENCRYPTION_KEY` and the database credentials, and keeps them across redeploys.
4. Open the domain and register the first account, which becomes **Admin**.

The UI, API, MCP endpoint (`/mcp`) and OAuth endpoints are all served from that one domain, because the frontend proxies backend routes. Coolify's proxy handles HTTPS. `MCP_AUTH_MODE` defaults to `both`: AI clients sign in with OAuth2 or use a per-user API key created in the UI. Leave `MCP_API_KEY` and `MCP_BEARER_TOKEN` empty unless you need them. They are instance-wide master credentials that reach every MCP server in every workspace.

> **Back up `ENCRYPTION_KEY`.** It decrypts every stored connector credential. When you move an existing instance to Coolify, set `JWT_SECRET`, `ENCRYPTION_KEY` and the database to the old values before the first deploy.

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

### Build provenance

When building the image yourself, pass the commit and build date so the UI and startup log show real values instead of `dev`:

```bash
docker build \
  --build-arg APP_COMMIT=$(git rev-parse HEAD) \
  --build-arg APP_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t anythingmcp:local .
```

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
| `both` | Accepts OAuth2 tokens, per-user MCP API keys, and the legacy static tokens when they are set |
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
| `DEPLOYMENT_MODE` | No | `self-hosted` (default) or `cloud`. Anything other than `cloud` is self-hosted, so an operator who never sets it keeps every self-hosted feature — including [single sign-on](sso.md) |
| `MCP_BEARER_TOKEN` | No | Bearer token for legacy MCP auth |
| `MCP_API_KEY` | No | API key for legacy MCP auth |
| `SERVER_URL` | No | Server URL for OAuth2 metadata (default: `http://localhost:4000`) |
| `MCP_RATE_LIMIT_PER_MINUTE` | No | Rate limit per client (default: 60) |
| `TOOL_MAX_RESPONSE_BYTES` | No | Largest upstream response body, in bytes after decompression, that one tool call reads from a REST, JSON-RPC, OData, GraphQL or SOAP API (default: `10485760`, 10 MB, on Cloud and self-hosted). A bigger response fails the call with code `TOOL_RESPONSE_TOO_LARGE` and a message that asks the model to narrow the request. The same limit applies to the text sent to the MCP client, for every connector type (database and MCP connectors too): a result over it is sent as compact JSON, and if that is still too big the call fails with the same code |
| `SMTP_HOST` | No | SMTP server for instance emails; used when no SMTP is configured in the admin Settings page |
| `SMTP_PORT` | No | SMTP port (default: 587) |
| `SMTP_SECURE` | No | `true` for implicit TLS (default: `false`; always on for port 465) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | Sender address (default: `AnythingMCP <SMTP_USER>`) |
| `SMTP_REPLY_TO` | No | Reply-To address, for when `SMTP_FROM` is a noreply address |
| `PLAN_CAPS_ENFORCE` | No | Cloud only: how hard the plans' caps on connectors, MCP servers and users are (see [Cloud plan limits](cloud-plans.md)). `dry-run` (default) logs what would be refused or paused, `on` enforces them, `off` does neither. The trial's cap on creating connectors and MCP servers is enforced in every mode. Ignored on self-hosted, which has none of these caps |
| `RETENTION_SMTP_HOST` | No | Cloud only: a second SMTP server for the trial lifecycle, win-back and blocked-call emails. Without it they go through the SMTP above, with `RETENTION_SMTP_REPLY_TO` as Reply-To when set. Self-hosted sends none of these emails |
| `RETENTION_SMTP_PORT` | No | Its port (default: 587). 465 or 2465 use implicit TLS, any other port STARTTLS |
| `RETENTION_SMTP_USER` | No | Its username |
| `RETENTION_SMTP_PASS` | No | Its password |
| `RETENTION_SMTP_FROM` | No | Its sender, e.g. `Your Name <support@example.com>` (default: the `SMTP_FROM` sender) |
| `RETENTION_SMTP_REPLY_TO` | No | Reply-To of those emails, with either sender |
| `COMPOSE_PROFILES` | No | Set to `proxy` to enable Caddy reverse proxy |
| `DOMAIN` | No | Domain for Caddy SSL certificate (e.g., `example.com`) |
| `ACME_EMAIL` | No | Email for Let's Encrypt certificate notifications |
| `APP_BIND_IP` | No | Bind IP for app ports (default: `0.0.0.0`, set `127.0.0.1` behind Caddy) |
| `METRICS_ENABLED` | No | Start a second, separate `/metrics` listener for Prometheus (default: `false`) — see [observability.md](operations/observability.md) |
| `METRICS_PORT` | No | Port for the metrics listener (default: `9464`) |
| `METRICS_HOST` | No | Bind host for the metrics listener (default: `0.0.0.0`) |
| `METRICS_TOKEN` | **Required when `METRICS_ENABLED=true`** | Bearer token required to scrape `/metrics`, compared with `timingSafeEqual` |
| `SOCIAL_GOOGLE_CLIENT_ID` / `SOCIAL_GOOGLE_CLIENT_SECRET` | No | Cloud only (ignored on self-hosted): enables "Continue with Google". Redirect URI `<FRONTEND_URL>/auth/social/google/callback` |
| `SOCIAL_MICROSOFT_CLIENT_ID` / `SOCIAL_MICROSOFT_CLIENT_SECRET` | No | Cloud only: enables "Continue with Microsoft" (personal and work accounts). Redirect URI `<FRONTEND_URL>/auth/social/microsoft/callback`; add the `email` and `xms_edov` optional ID-token claims |
| `SOCIAL_GITHUB_CLIENT_ID` / `SOCIAL_GITHUB_CLIENT_SECRET` | No | Cloud only: enables "Continue with GitHub". Callback URL `<FRONTEND_URL>/auth/social/github/callback` |
| `TIKTOK_SHOP_PLATFORM_APP_KEY` / `TIKTOK_SHOP_PLATFORM_APP_SECRET` / `TIKTOK_SHOP_PLATFORM_SERVICE_ID` | No | A public TikTok Shop app (TikTok Shop App Store) for the TikTok Shop connector, on Cloud and self-hosted alike. Set all three: a TikTok Shop connector whose App key is empty then signs, authorizes and renews with this app, the setup page stops asking for app keys, and an install from the App Store adds the connector to the seller's workspace after they sign in or sign up. A connector with its own App key keeps using it. Redirect URL `<SERVER_URL>/api/tiktok-shop/callback`. The secret is never stored on a connector or shown. Unset = every TikTok Shop connector needs the seller's own app |
| `WOOCOMMERCE_ONE_CLICK` | No | `true` adds "Connect with one click" to the WooCommerce setup page, on Cloud and self-hosted alike: the merchant approves a REST API key on their shop (`/wc-auth/v1/authorize`) and WooCommerce posts it to `<SERVER_URL>/api/woocommerce/callback`, where it is checked on the shop before it is stored. Offered only when `SERVER_URL` is a public https address the shop can reach; otherwise the setup page keeps the paste flow. Default: off |
| `META_PLATFORM_APP_ID` / `META_PLATFORM_APP_SECRET` / `META_PLATFORM_CONFIG_ID` | No | A Meta app for **Authorize with Provider** on the Instagram connector (`instagram`), on Cloud and self-hosted alike. With `META_PLATFORM_CONFIG_ID` (the Facebook Login for Business configuration id under *API setup with Unified login*, required for every Meta app created since autumn 2026) the sign-in uses Unified Login: users sign in with Instagram or Facebook, no Facebook Page needed, and the token (a Business Integration System User token) does not expire. Without it the app uses the classic Facebook Login. A connector without `META_APP_ID` / `META_APP_SECRET` of its own uses this app, and the setup page stops asking for one. Register `<SERVER_URL>/api/meta/callback` as the configuration's redirect URL (or Facebook Login's valid OAuth redirect URI). Accounts without a role on the app need Meta App Review (Advanced Access) and Live mode. The secret is never stored on a connector or shown. Unset = users enter an app of their own or paste a token. The Instagram Login connector (`instagram-login`) has no server app: new Meta apps cannot get Instagram Login |
| `META_PLATFORM_ORG_IDS` | No | Comma-separated organization ids the server's Meta app is offered to. Empty (default): every organization. Set it while the app is in Development mode or in App Review, when only its testers can finish the sign-in: every other organization then sees the Instagram connector as on a server without an app (an app of its own, or a pasted token). Same on Cloud and self-hosted. |
| `TELEGRAM_MANAGER_BOT_TOKEN` | No | The token of a Telegram "manager bot" of this server (a bot with **Bot Management Mode** enabled in @BotFather). With it and `TELEGRAM_MANAGER_WEBHOOK_SECRET`, a user who picks Telegram on the page after approving an AI client creates their own bot with one tap in Telegram instead of a chat with @BotFather and a pasted token; see [One-tap Telegram bot](#one-tap-telegram-bot). Default: off, the page is as before |
| `TELEGRAM_MANAGER_WEBHOOK_SECRET` | With the token | A secret of your own, 16 to 256 characters of `A-Z`, `a-z`, `0-9`, `_` and `-` (for example `openssl rand -hex 32`). Telegram sends it back with every update of the manager bot, to `<SERVER_URL>/api/telegram/manager-webhook`; a call without it is refused |
| `TELEGRAM_MANAGED_BOT_ORG_IDS` | No | Comma-separated organization ids the one-tap Telegram bot is offered to. Empty (default): every organization. Set it to try the feature on one workspace first: every other organization sees the page as before |
| `AUTHORIZE_CONNECTED_PAGE_TEST` | No | Cloud only: the page shown after approving an AI client into an empty workspace (see [Authorization page tests](#authorization-page-tests)). Unset: `next_step` for everyone. `split`: an equal split. `off`: the page as before for everyone, no arm recorded. `control` or `next_step`: that arm for everyone. Ignored on a self-hosted instance, which always shows the page as before |
| `AUTHORIZE_SIGNIN_PAGE_TEST` | No | Cloud only: the split test of the sign-in page inside an authorization (see [Sign-in page test](#sign-in-page-test)). Unset: an equal split. `off`: the page as before for everyone, no arm recorded. `control` or `buttons_first`: that arm for everyone. Ignored on a self-hosted instance |
| `METRICS_TOOL_LABELS` | No | Add `connector_id`/`tool` labels to tool-call metrics (default: `false`; ignored on Cloud) |
| `LICENSE_USAGE_REPORT` | No | Self-hosted only: `false` stops the licence check from sending the usage counts (active users, connectors, MCP servers, version) described under [License Verification](#license-verification); the key is still verified. Default: sent. Ignored on Cloud, which never sends them |

---

## One-tap Telegram bot

Optional and off by default. Without it, a user who picks Telegram on the page after approving an AI client gets a Telegram connector with no token: they create a bot with @BotFather, copy its token and paste it on the setup page. With a manager bot, the same page offers **Create your Telegram bot**: Telegram opens with a name and a username filled in, the user confirms with one tap, and the connector works at once. It uses Telegram's managed bots (Bot API 9.6).

Set it up once per server:

1. In Telegram, open @BotFather, send `/newbot` and create a bot for your server. This is the manager bot. It receives the notice that a user created a bot, and answers a `/start` in its own chat with one short line (see below); it sends nothing else.
2. Open that bot's settings in @BotFather's mini app and turn on **Bot Management Mode**.
3. Set `TELEGRAM_MANAGER_BOT_TOKEN` to its token and `TELEGRAM_MANAGER_WEBHOOK_SECRET` to a secret of your own (`openssl rand -hex 32`), then restart the backend.

At start-up the backend asks Telegram whether the bot can manage bots and registers `<SERVER_URL>/api/telegram/manager-webhook` as its webhook, for the update types `managed_bot` and `message`. The log then says `One-tap Telegram bot is on`. It stays off, with a warning in the log and the page as before, when the token or the secret is missing or malformed, when Bot Management Mode is off, or when `SERVER_URL` is not a public https address (Telegram only delivers to https). Telegram being unreachable never stops the server from starting: the registration is tried again, at most once a minute, the next time the page is shown.

How a new bot finds its connector: the username Telegram suggests carries a random code (`amcp_<8 hex>_bot`). The connector keeps a keyed hash of that code for 30 minutes, in its configuration; the token goes into the connector's variables, encrypted like every other credential.

The bot belongs to the user who created it: it appears in their own @BotFather list, and they can rename it, give it a picture, use it with their own customers, and revoke its token or delete it there. The page says so under the button.

### A username the user changed

A user who edits the suggested username in Telegram's creation screen creates a bot that carries no code. The page then offers **Changed the username? Link your bot** (as soon as the server sees such a bot, or 20 seconds after the click on the first button; a minute after Telegram was picked when only the QR code was used). It opens the manager bot's chat; pressing **Start** there sends `/start` with the setup's code and a check keyed with the webhook secret, from the user's own Telegram account. The server connects the setup to the bot that same account created through the manager bot:

- **Bot first, then Start**: the bot is connected at that moment, and the manager bot answers "Your bot is connected".
- **Start first, then the bot**: the setup now belongs to that Telegram account, and whatever bot the account creates through the manager bot in the setup's 30 minutes is connected, under any username.

A bot is only ever connected to a setup by the account that created it: Telegram says who created a bot and who sent a message, and the two must match. The first account that sends a setup's code keeps the setup; a second one is refused. An account with two bots that carry no code gets the newest one connected (the older one can still be connected by pasting its token). Everything after that is the same as for a bot found by its username. Pasting the token (**Already have a bot? Paste its token**) stays the last resort.

What is remembered between the two halves, without a schema change:

- on the connector, in its configuration: a keyed hash (HMAC with the webhook secret) of the Telegram account that pressed Start;
- in `site_settings`, for 30 minutes at most, one row per Telegram account under that same keyed hash: the id of the newest bot the account created that carries no code (`telegram_unmatched_bot:<hash>`), or the connector the account asked for (`telegram_claim:<hash>`); and the time of the last such bot (`telegram_unmatched_bot_at`), for the page's hint. Expired rows are deleted on a later write.

No Telegram account id, username or name is stored or logged; a bot's id is kept for those 30 minutes because Telegram needs it to hand out the token. The rows are in the database, not in memory or Redis, so both orders survive a restart and work with several backend processes. Changing `TELEGRAM_MANAGER_WEBHOOK_SECRET` drops every pending setup and link.

The manager bot answers a `/start` in its own chat with one line: connected (go back to the page and tap Continue), nothing to link yet, or the link is no longer valid (an unknown, expired or foreign code gets the same line whatever the reason). A plain `/start` from anyone gets one neutral line. It acts on at most 5 such messages a minute from one account and 120 a minute in all, per backend process; the rest get no answer.

### After the bot is connected

The AI client is not connected yet at that moment: its authorization is finished by **Continue** on the page. Three things say so and follow it up:

- **The page** shows "Telegram is connected" with "Last step: tap Continue to Claude below", and scrolls the button into view. It never follows the button for the user. The click on Continue also copies the example request to the clipboard ("Copied. Paste it in a new chat in Claude."), on every device: no chat tab is opened, because a second tab left the authorization unfinished (on phones first, later on computers). A refused clipboard changes nothing, and the click goes through as always.
- **The welcome message** the new bot sends its creator says the same: go back to the page and tap "Continue to Claude" (the client's name as the page shows it).
- **A second message** follows when the AI client really is connected: on the first `tools/list` that the user's client sends to the shared `/mcp` endpoint within 30 minutes of the bot being connected, the bot writes "Claude is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."". For Claude the message has a button that opens a new chat with that request typed in (`https://claude.ai/new?q=…`); for any other client it is the same sentence without a link. It is sent once per connector, only for a bot created in one tap by the user whose client it is, and only when the welcome could be delivered (the creator pressed **Start** in the bot's chat: a bot cannot write to someone who has not). It never delays or fails the MCP request: the endpoint only notes the request, and the check (one database read per workspace every five seconds at most, none while the feature is off) and the message happen in the background.

On Cloud, half of the pending authorizations see another version of this page (the `next_step` arm of the [authorization page test](#authorization-page-tests)): once the bot is connected and Start was pressed, the page counts down five seconds ("Telegram is connected. Going back to Claude in 5 s…") and then follows the Continue link itself, in the same tab, only while the tab is visible. **Stay on this page** stops the countdown.

What to know:

- **One manager bot per server.** A bot has one webhook: a second server started with the same token takes it over, and the first one stops receiving updates.
- **Trying it on one workspace.** Set `TELEGRAM_MANAGED_BOT_ORG_IDS` to a comma-separated list of organization ids: only those see the button.
- **The creator becomes the default chat.** Telegram says who created the bot; that person's chat id is stored as the connector's `TELEGRAM_DEFAULT_CHAT_ID` (a variable of the connector, encrypted like the others, shown and editable in its settings). The send tools write there when a call names no chat, so "send me a test message" works without looking up a chat id. A connector set up with a pasted token has no default chat until its owner enters one.
- **On a computer.** The button opens Telegram's own page for the link, which starts the Telegram app when one is installed. Beside it the page shows a QR code for the phone and **open Telegram Web in this browser**, the same link for Telegram's web client (`web.telegram.org/a`), for someone with neither the app nor the phone at hand. The QR code holds an address of this server, `/auth/first-app/telegram/qr/<code>`, which sends the phone on to Telegram: that is how a scan is counted. The address is public, like the Telegram link it stands for, and leads nowhere but to the creation screen of this server's manager bot. `telegram_bot_link_opened` says which way was used (`via`: `app`, `web` or `qr`).
- **The user's bot gets no webhook.** The connector's own `telegram_bot_get_updates` keeps working. To greet the user once after they press **Start**, the server reads the new bot's updates without confirming any of them.
- **Cloud and self-hosted.** The settings are read in both modes. The page that offers the button (shown after approving an AI client, to a workspace with no connectors) exists on Cloud only today, so a self-hosted instance sees no change yet: no setup is ever started there, so the manager bot has nothing to link and the second message has nobody to go to. Redis is not needed for any of it.
- **Outbound calls.** `api.telegram.org`, with the manager bot's token (start-up, once per created bot, and one answer per `/start` in its chat) and with the user's new bot's token (the welcome message and the "assistant is connected" message).
- **Events.** `telegram_bot_link_offered`, `telegram_bot_link_opened`, `telegram_bot_connected` (`kind: claim` when the bot was linked by its creator's Start), `telegram_bot_unmatched`, `telegram_bot_claim_offered`, `telegram_bot_claim` (`status`: `linked`, `waiting` or `refused`), `telegram_bot_client_notice` (`status`: `sent` or `failed`) and `telegram_bot_token_pasted`, in `product_events`. None holds a Telegram id, a username or a code.

## Authorization page tests

Cloud only. A self-hosted instance always shows the pages as before and records no arm.

The page shown after approving an AI client into an empty workspace says "Claude is connected" although the client is connected only after **Continue**: no authorization code exists yet. On Cloud everyone sees the `next_step` arm by default; `AUTHORIZE_CONNECTED_PAGE_TEST=split` runs the two as a split test:

| Arm | What the person sees |
|-----|----------------------|
| `control` | The page as before: "Claude is connected" |
| `next_step` | No visible heading (the tab title is "One more step: go back to Claude"): one line ("Press Continue to Claude to finish connecting."), then the picker, the example request and the Continue link. The copy button is "Copy & continue": it copies the request and presses Continue. After the one-tap Telegram bot is connected the page goes on by itself (see [After the bot is connected](#after-the-bot-is-connected)) |

The arm is chosen per pending authorization (a hash of its session, never stored) and stays the same through reloads, the round trip to Google and the sign-up detour. A new connection attempt from the AI client can get the other arm.

The events of one attempt carry the same `attempt` value, the `device` (`mobile` or `desktop`) and the arm as `connectedArm`:

| Event | Written when | Extra fields |
|-------|--------------|--------------|
| `authorize_page_viewed` | the sign-in page is opened inside an authorization | `lang`: the browser's first language if it is one of `en`, `de`, `it`, `es`, `zh`, `ja`, `ru`, else `other` |
| `authorize_action` | a button of the sign-in page is used, or one of the two links of the page after approving that are not Continue | `button`: `google`, `microsoft`, `github`, `sso`, `password`, `session`, `cancel`, `create_account`; `open_dashboard` ("Or add an app here first"), `payment_method` ("Add a payment method") |
| `authorization_signed_in` | the identity is settled and access allowed | `method`: the provider, `password`, `session`, `email_code`; `account`: `new` (created in the last 30 minutes) or `existing` |
| `empty_workspace_prompt` | the page of the test is shown | |
| `post_approve_app_picked` | an app is picked on it | |
| `post_approve_continue_clicked` | Continue is pressed on it | `button`: `continue`, `copy_continue` when "Copy & continue" pressed it, or `auto_continue` when the page went on by itself |
| `authorize_step_viewed` | a step between sign-in and the code is shown | `step`: `email-code` (code step for an unverified address), `servers` ("Choose what to connect"), `wrong-workspace` (the client asked for a server this account cannot reach) |
| `authorize_request_closed` | a browser reaches the flow without an open authorization and gets the "no longer open" page | `via`: `login`, `next` or `callback`; `device`. No account, no attempt |
| `authorization_code_issued` | the code is handed to the client's redirect | |
| `authorization_code_exchanged` | the client presents the code | `client` only: no browser is present |

`post_approve_continue_clicked` and the `create_account` button are reported by the page with `navigator.sendBeacon` to `POST /auth/beacon`, which never delays the click. That route writes one event, only for the pending authorization of the browser that names its own attempt, and always answers 204.

To read the test, compare the arms on attempts that have an `empty_workspace_prompt`: the share with an `authorization_code_issued` in the same attempt (the person came back to the client), and the share of those codes followed by an `authorization_code_exchanged` of the same user (the client really connected).

### What the flow does when something is off

- **The page after approving has its own address**, `GET /auth/next`. The request that finishes the sign-in answers with a redirect to it, and the page is rendered from signed cookies that live as long as the pause. Reload, the Back button and a tab restored by a phone show the page again; an app picked on it stays shown as added.
- **A request that is no longer open** (it expired after 30 minutes, its code was already issued, or the address was opened from a bookmark) gets one page on `/auth/login`, `/auth/next` and `/callback`: "This connection request is no longer open", with what to do (go back to the AI client; press Connect again if it is not shown as connected). `/callback` answers it with status 400, as the OAuth library's JSON did.
- **Continue works once.** A second press within five seconds is dropped on the page; the sign-in cookie is cleared as soon as the code is on its way to the client.
- **The sign-in is bound to one authorization.** `/callback` accepts the sign-in cookie only for the pending authorization it was issued for; another authorization started in the same browser asks for consent itself.
- **Cancel tells the client**: a redirect to its registered address with `error=access_denied`, its `state` and `iss`.
- **The rate limit answers a person with a page** ("Too many attempts", status 429); the routes that scripts call keep the JSON answer.
- **`GET /auth/pending`** tells the dashboard (same origin, Cloud) whether an authorization is waiting in this browser and whether "Allow" or only "Continue" is missing, so it can show a way back.
- ChatGPT's database plugin never gets the page after approving (it has no setup tools). A workspace whose free trial has ended gets it without the app picker and the example request.

### Sign-in page test

The sign-in page inside an authorization runs as a second split test, independent of the first (another hash of the same session), set with `AUTHORIZE_SIGNIN_PAGE_TEST`:

| Arm | What the person sees |
|-----|----------------------|
| `control` | The page as before, in English |
| `buttons_first` | The page in the browser's language (`en`, `de`, `it`, `es`, `zh`, `ja`, `ru`; English otherwise), one line on what the person gets, the Google / Microsoft / GitHub buttons right under the heading on every screen, the consent box after the buttons (a short form of its destination warning stays above them), and "Create an account with email" as a link under the form instead of the sign-up box |

Unset: an equal split. `off`: the page as before, no arm recorded. `control` or `buttons_first`: that arm for everyone. The arm is recorded on the same events as `signinArm`. To read it, compare the arms on attempts with an `authorize_page_viewed`: the share with any `authorize_action` (the person did something), and the share with an `authorization_code_issued` (the person came back to the client).

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
- Instance ID (a random UUID generated on first startup, used to identify the installation; sent on activation and registration)
- Email and name (only during community license registration)
- Usage counts, with each verification (`/api/license/verify`), as query parameters:

  | Parameter | Value |
  |-----------|-------|
  | `activeUsers` | Users with at least one active workspace membership, across the instance: the same count as the Community user limit |
  | `connectors` | Number of connectors on the instance |
  | `mcpServers` | Number of MCP servers on the instance |
  | `version` | The AnythingMCP version, e.g. `0.52.0` |

  Only numbers and the version: no names, emails, connector names or URLs. They tell us which Community instances are growing past the Community edition. Set `LICENSE_USAGE_REPORT=false` to send only the license key. If counting fails, the key is verified without the counts. AnythingMCP Cloud never sends them.

**Data NOT sent:** No API credentials, connector configurations, tool definitions, user data, audit logs, or any other operational data.

**File Search trial:** on Community, the 30-day File Search trial starts only with a registered license key. The free Community key counts: register it under **Settings → License**, and it arrives by email. A trial that was already running before this rule keeps File Search until it ends.

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

[Back to README](../README.md) | [API Reference](api-reference.md) | [Integration Guides](../README.md#use-it-from-claude-chatgpt-copilot-and-gemini)
