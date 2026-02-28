# AnythingToMCP

> Convert **any** API into an MCP server — self-hosted, open source, AI-assisted.

AnythingToMCP is a platform that lets you create dynamic [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers by connecting your existing APIs through a web interface or API calls. It acts as a **bridge** between any API (REST, SOAP, GraphQL, Database, Webhook, other MCP servers) and MCP-compatible AI clients like Claude Desktop, Claude Code, ChatGPT, Cursor, and more.

---

## Features

- **Universal Connectors**: REST (OpenAPI), SOAP (WSDL), GraphQL, MCP-to-MCP bridge, Database (read-only), Webhooks
- **6 Import Formats**: OpenAPI/Swagger, Postman Collections, cURL commands, WSDL, GraphQL introspection, custom JSON definitions
- **Dynamic MCP Server**: Tools registered at runtime — no restart required
- **Visual Tool Editor**: Define parameters and visually configure where each maps in the API request (path, query, body, header)
- **Environment Variables**: Per-connector `{{VAR_NAME}}` interpolation at runtime
- **AI-Assisted Configuration**: Claude or OpenAI auto-generates tool definitions from your API specs
- **Bulk API**: Create connectors and tools programmatically via REST API (for Claude Code, CI/CD, scripts)
- **Full Auth Support**: JWT + API key for admin, Bearer/OAuth2/API key for MCP clients, AES-256-GCM encrypted credentials
- **Audit Logging**: Every tool invocation is logged with input, output, duration, and status
- **Role-Based Access**: Admin, Editor, Viewer roles with per-route guards
- **Docker Ready**: `docker compose up` and you're running

---

## Table of Contents

- [Quick Start (Docker)](#quick-start-docker)
- [Local Development Setup](#local-development-setup)
- [Production Deployment](#production-deployment)
- [Connecting AI Clients](#connecting-ai-clients)
- [API Reference](#api-reference)
- [Tool Definition Format](#tool-definition-format)
- [Import Formats](#import-formats)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)

---

## Quick Start (Docker)

```bash
# 1. Clone the repo
git clone https://github.com/kochfreiburg/anything-to-mcp.git
cd anything-to-mcp

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum change JWT_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD

# 3. Start all services
docker compose up -d

# 4. Open the UI
open http://localhost:3000
```

The first user to register becomes **Admin**.

| Service | URL |
|---------|-----|
| Web UI | http://localhost:3000 |
| Backend API | http://localhost:4000 |
| MCP Endpoint | http://localhost:4000/mcp |
| Swagger Docs | http://localhost:4000/api/docs |
| Health Check | http://localhost:4000/health |

### Docker Services

| Container | Image | Port |
|-----------|-------|------|
| `atmcp-frontend` | Next.js 15 (standalone) | 3000 |
| `atmcp-backend` | NestJS 11 | 4000 |
| `atmcp-postgres` | PostgreSQL 17 | 5432 |
| `atmcp-redis` | Redis 7 | 6379 |

---

## Local Development Setup

### Prerequisites

- **Node.js** 22+
- **Docker** (for PostgreSQL and Redis)
- **npm** 9+

### Step-by-Step

```bash
cd anything-to-mcp

# 1. Start only PostgreSQL and Redis via Docker
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis

# 2. Create your .env file
cp .env.example .env
```

Edit `.env` for local development:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://atmcp:atmcp@localhost:5432/anythingtomcp
REDIS_URL=redis://localhost:6379
JWT_SECRET=local-dev-secret-at-least-32-chars!!
ENCRYPTION_KEY=local-dev-key-exactly-32-chars!!
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

```bash
# 3. Install dependencies
npm install

# 4. Setup database
cd packages/backend
npx prisma migrate dev --name init
npx prisma generate
cd ../..

# 5. Start backend (terminal 1)
npm run dev:backend

# 6. Start frontend (terminal 2)
npm run dev:frontend

# Or start both at once:
npm run dev
```

The backend runs on http://localhost:4000, the frontend on http://localhost:3000.

### Useful Commands

```bash
# Run all tests
npm test

# Run backend tests only
cd packages/backend && npm test

# Open Prisma Studio (DB browser)
cd packages/backend && npx prisma studio

# Create a new migration after schema changes
cd packages/backend && npx prisma migrate dev --name describe_change

# Build for production
npm run build
```

---

## Production Deployment

### With Docker (Recommended)

```bash
# 1. Configure production secrets
cp .env.example .env
# Set strong values for: JWT_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD, NEXTAUTH_SECRET
# Set MCP_BEARER_TOKEN or MCP_API_KEY to protect the MCP endpoint

# 2. Build and start
docker compose up -d --build

# 3. Check health
curl http://localhost:4000/health
```

The backend automatically runs `prisma migrate deploy` on startup to apply migrations.

### Without Docker

```bash
# 1. Ensure PostgreSQL 17+ and Redis 7+ are running externally
# 2. Configure .env with the correct DATABASE_URL and REDIS_URL
# 3. Build
cd packages/backend && npm ci && npx prisma generate && npm run build
cd packages/frontend && npm ci && npm run build

# 4. Run database migrations
cd packages/backend && npx prisma migrate deploy

# 5. Start backend
cd packages/backend && node dist/main.js

# 6. Start frontend
cd packages/frontend && npm start
```

### Reverse Proxy (nginx example)

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

## Connecting AI Clients

### Claude Desktop

Add this to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "anything-to-mcp": {
      "type": "url",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

### Claude Code

```bash
# Add AnythingToMCP as an MCP server
claude mcp add anything-to-mcp \
  --transport http \
  --url http://localhost:4000/mcp \
  --header "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
```

### Any MCP Client

The MCP endpoint supports **Streamable HTTP** transport at `POST /mcp`.

Authentication options (set in your `.env`):
- `MCP_BEARER_TOKEN` — Bearer token authentication
- `MCP_API_KEY` — API key via `X-API-Key` header
- Both can be set simultaneously

---

## API Reference

All API endpoints require JWT authentication (except auth and health). Get a token via `POST /api/auth/login`.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register (first user becomes Admin) |
| POST | `/api/auth/login` | Login, returns JWT token |

### Connectors

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connectors` | List all connectors |
| POST | `/api/connectors` | Create connector |
| GET | `/api/connectors/:id` | Get connector (with tools) |
| PUT | `/api/connectors/:id` | Update connector |
| DELETE | `/api/connectors/:id` | Delete connector (cascades tools) |
| POST | `/api/connectors/:id/test` | Test API connection |
| POST | `/api/connectors/:id/import-spec` | Auto-import tools from connector's spec URL |
| POST | `/api/connectors/:id/import` | Import tools from any source |
| PUT | `/api/connectors/:id/env-vars` | Set environment variables |

### Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connectors/:id/tools` | List tools for connector |
| POST | `/api/connectors/:id/tools` | Create a single tool |
| POST | `/api/connectors/:id/tools/bulk` | Bulk create tools |
| PUT | `/api/connectors/:id/tools/:toolId` | Update a tool |
| DELETE | `/api/connectors/:id/tools/:toolId` | Delete a tool |

### Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit/invocations` | List invocations (with filters) |
| GET | `/api/audit/stats` | Get invocation stats (24h, 7d, total) |

### AI

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ai/generate-tools` | AI-generate tool definitions from spec |
| POST | `/api/ai/improve-description` | AI-improve tool description |
| POST | `/api/ai/configure` | Natural language configuration |

### Examples

#### Create a connector + tools via API (e.g., from Claude Code or a script)

```bash
# 1. Login
TOKEN=$(curl -s http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.accessToken')

# 2. Create a REST connector
CONNECTOR_ID=$(curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "JSONPlaceholder",
    "type": "REST",
    "baseUrl": "https://jsonplaceholder.typicode.com",
    "authType": "NONE"
  }' | jq -r '.id')

# 3. Bulk create tools
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/tools/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tools": [
      {
        "name": "get_posts",
        "description": "Fetch all posts or filter by userId",
        "parameters": {
          "type": "object",
          "properties": {
            "userId": { "type": "integer", "description": "Filter by user ID" }
          }
        },
        "endpointMapping": {
          "method": "GET",
          "path": "/posts",
          "queryParams": { "userId": "$userId" }
        }
      },
      {
        "name": "get_post",
        "description": "Get a single post by ID",
        "parameters": {
          "type": "object",
          "properties": {
            "id": { "type": "integer", "description": "Post ID" }
          },
          "required": ["id"]
        },
        "endpointMapping": {
          "method": "GET",
          "path": "/posts/{id}"
        }
      },
      {
        "name": "create_post",
        "description": "Create a new post",
        "parameters": {
          "type": "object",
          "properties": {
            "title": { "type": "string", "description": "Post title" },
            "body": { "type": "string", "description": "Post body" },
            "userId": { "type": "integer", "description": "Author user ID" }
          },
          "required": ["title", "body", "userId"]
        },
        "endpointMapping": {
          "method": "POST",
          "path": "/posts",
          "bodyMapping": {
            "title": "$title",
            "body": "$body",
            "userId": "$userId"
          }
        }
      }
    ]
  }'

# 4. Import from a Postman collection via API
curl -s http://localhost:4000/api/connectors/$CONNECTOR_ID/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "postman",
    "url": "https://www.getpostman.com/collections/your-collection-id"
  }'
```

---

## Tool Definition Format

Every MCP tool in AnythingToMCP is defined by three JSON objects:

### 1. `parameters` — JSON Schema for tool inputs

What the AI model can pass as input when calling the tool:

```json
{
  "type": "object",
  "properties": {
    "user_id": { "type": "integer", "description": "The user's ID" },
    "include_details": { "type": "boolean", "description": "Include extra details" }
  },
  "required": ["user_id"]
}
```

### 2. `endpointMapping` — How parameters map to the API request

This is the **bridge configuration** that tells AnythingToMCP how to transform MCP tool call parameters into actual API requests.

```json
{
  "method": "GET",
  "path": "/users/{user_id}",
  "queryParams": {
    "details": "$include_details"
  },
  "bodyMapping": {
    "name": "$name",
    "email": "$email"
  },
  "headers": {
    "X-Custom-Header": "$api_token"
  }
}
```

#### Mapping Rules

| Pattern | Where | Example |
|---------|-------|---------|
| `{param}` in path | **Path parameter** — replaced in the URL | `/users/{id}` → `/users/123` |
| `"$param"` in queryParams | **Query parameter** — added to URL query string | `?search=value` |
| `"$param"` in bodyMapping | **Request body field** — included in JSON body | `{"name": "John"}` |
| `"$param"` in headers | **HTTP header** — sent as request header | `X-Token: abc123` |

The `$` prefix means "take the value from the tool input parameter with this name".

#### By Connector Type

| Connector | method | path | queryParams | bodyMapping | headers |
|-----------|--------|------|-------------|-------------|---------|
| **REST** | HTTP method (GET, POST, etc.) | URL path | Query string params | JSON body fields | HTTP headers |
| **GraphQL** | `query` or `mutation` | The GraphQL query string | GraphQL variables | — | HTTP headers |
| **SOAP** | SOAP operation name | Port/path | — | SOAP parameters | HTTP headers |
| **Database** | `query` | SQL template (`$param` interpolated) | — | — | — |
| **Webhook** | HTTP method | URL path | Query params | JSON body | HTTP headers |
| **MCP** | Tool name on remote server | — | — | Passed through | — |

### 3. `responseMapping` (Optional)

Transform the API response before returning to the AI:

```json
{
  "type": "json",
  "fields": ["id", "name", "email"]
}
```

---

## Import Formats

AnythingToMCP supports importing tool definitions from 6 sources:

### 1. OpenAPI / Swagger

Paste the spec JSON/YAML or provide a URL. Tools are auto-generated from each path+method with operationId, parameters, and request body.

### 2. Postman Collection (v2.1)

Paste the collection JSON or provide a URL (including Postman API export links). Supports nested folders, all auth types, body modes (raw JSON, form-data, urlencoded).

### 3. cURL Commands

Paste one or more cURL commands. Supports `-X` method, `-H` headers, `-d` body (JSON parsed), `-u` basic auth, multiline with `\` continuation.

```bash
curl -X POST https://api.example.com/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {{token}}' \
  -d '{"name": "John", "email": "john@example.com"}'
```

Variables using `{{name}}` pattern are auto-detected and added as tool parameters.

### 4. GraphQL Introspection

Provide the GraphQL endpoint URL. AnythingToMCP runs an introspection query and generates tools for each query and mutation field.

### 5. WSDL

Provide the WSDL URL. Tools are generated for each SOAP operation.

### 6. Custom JSON Definition

The most flexible format. Paste a JSON array of tool definitions directly:

```json
[
  {
    "name": "search_products",
    "description": "Search products by keyword and category",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search keyword" },
        "category": { "type": "string", "description": "Product category" },
        "limit": { "type": "integer", "description": "Max results (default 10)" }
      },
      "required": ["query"]
    },
    "endpointMapping": {
      "method": "GET",
      "path": "/api/products/search",
      "queryParams": {
        "q": "$query",
        "cat": "$category",
        "limit": "$limit"
      }
    }
  },
  {
    "name": "create_order",
    "description": "Place a new order",
    "parameters": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string" },
        "quantity": { "type": "integer" },
        "customer_token": { "type": "string", "description": "Customer auth token" }
      },
      "required": ["product_id", "quantity", "customer_token"]
    },
    "endpointMapping": {
      "method": "POST",
      "path": "/api/orders",
      "bodyMapping": {
        "productId": "$product_id",
        "qty": "$quantity"
      },
      "headers": {
        "X-Customer-Token": "$customer_token"
      }
    }
  }
]
```

You can also wrap the array in a `{ "tools": [...] }` object.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    AnythingToMCP                      │
│                                                      │
│  Next.js UI (3000) ◄────► NestJS Backend (4000)      │
│  - Dashboard              │                          │
│  - Connector CRUD         ├── Connector Engines      │
│  - Visual Tool Editor     │   REST / SOAP / GraphQL  │
│  - Import (6 formats)     │   MCP / Database / Hook  │
│  - Env Variables          │                          │
│  - Audit Logs             ├── Import Parsers         │
│  - AI Assistant           │   OpenAPI / Postman      │
│  - User Management        │   cURL / WSDL / GraphQL  │
│                           │   JSON definitions       │
│                           │                          │
│                           ├── Dynamic MCP Server     │
│                           │   /mcp (Streamable HTTP) │
│                           │                          │
│                           └── AI Service             │
│                               Claude / OpenAI API    │
│                                                      │
│  PostgreSQL 17          Redis 7                      │
└──────────────────────────────────────────────────────┘
         │
         ▼ MCP Protocol (Streamable HTTP)
  Claude Desktop / Claude Code / ChatGPT / Cursor
```

### How the MCP Bridge Works

1. You create a **Connector** (e.g., a REST API with base URL + auth)
2. You define **Tools** — each tool maps MCP input parameters to API request fields
3. On startup (or after changes), tools are loaded into the **ToolRegistry** (in-memory)
4. When an MCP client calls a tool, the system:
   - Looks up the tool in the registry
   - Interpolates environment variables (`{{VAR}}` patterns)
   - Maps `$param` references to actual input values
   - Sends the API request via the correct engine (REST/GraphQL/SOAP/etc.)
   - Returns the response to the MCP client

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, React 19, Tailwind CSS v4 |
| Backend | NestJS 11, TypeScript, @rekog/mcp-nest |
| MCP SDK | @modelcontextprotocol/sdk (Streamable HTTP) |
| Database | PostgreSQL 17 + Prisma ORM |
| Cache | Redis 7 (ioredis) |
| AI | Anthropic SDK (Claude) + OpenAI SDK |
| Validation | Zod v4, class-validator |
| Auth | JWT (passport-jwt), AES-256-GCM encryption |
| Deploy | Docker + Docker Compose |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret (min 32 chars) |
| `ENCRYPTION_KEY` | Yes | AES-256-GCM key (exactly 32 chars) |
| `PORT` | No | Backend port (default: 4000) |
| `REDIS_URL` | No | Redis URL (graceful fallback if unavailable) |
| `CORS_ORIGIN` | No | Allowed origin (default: http://localhost:3000) |
| `NEXT_PUBLIC_API_URL` | No | Backend URL for frontend (default: http://localhost:4000) |
| `NEXTAUTH_SECRET` | No | NextAuth secret for frontend |
| `MCP_BEARER_TOKEN` | No | Bearer token for MCP endpoint auth |
| `MCP_API_KEY` | No | API key for MCP endpoint auth |
| `MCP_RATE_LIMIT_PER_MINUTE` | No | Rate limit per client (default: 60) |
| `ANTHROPIC_API_KEY` | No | For AI-assisted configuration |
| `OPENAI_API_KEY` | No | Alternative AI provider |

---

## License

MIT — see [LICENSE](LICENSE)
