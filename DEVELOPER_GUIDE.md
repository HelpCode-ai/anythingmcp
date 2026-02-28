# AnythingToMCP — Developer Guide

> Guida tecnica completa per continuare lo sviluppo di AnythingToMCP.
> Questo documento e pensato per un agente AI o sviluppatore che deve capire
> lo stato attuale del progetto e come procedere.

---

## 1. Cos'e AnythingToMCP

AnythingToMCP e una piattaforma open-source self-hosted che converte qualsiasi API
(REST, SOAP, GraphQL, altri MCP server, database, webhook) in un server MCP dinamico.
L'utente interagisce con una web UI per configurare connettori, e il sistema espone
automaticamente un endpoint MCP consumabile da Claude Desktop, ChatGPT, Cursor, ecc.

**Flusso principale:**
1. Utente fa login nella web UI (Next.js)
2. Crea un "Connector" (es. una REST API con OpenAPI spec)
3. Il sistema (opzionalmente con AI) genera "McpTool" da quella API
4. Il MCP server dinamico espone quei tools su `/mcp`
5. Claude/ChatGPT si connette a `http://host:4000/mcp` e usa i tools

---

## 2. Architettura

```
anything-to-mcp/
├── package.json                  # Root monorepo (npm workspaces)
├── docker-compose.yml            # Full stack: frontend + backend + postgres + redis
├── docker-compose.dev.yml        # Solo postgres + redis (dev locale)
├── Dockerfile                    # Backend NestJS (multi-stage)
├── Dockerfile.frontend           # Frontend Next.js (standalone)
├── .env.example                  # Template variabili d'ambiente
├── CONCEPT.md                    # Documento concettuale del prodotto
│
├── packages/
│   ├── backend/                  # NestJS 11 + Prisma + MCP SDK
│   │   ├── package.json
│   │   ├── nest-cli.json
│   │   ├── tsconfig.json
│   │   ├── prisma/schema.prisma  # Database schema (PostgreSQL)
│   │   └── src/
│   │       ├── main.ts           # Bootstrap: porta 4000, Swagger su /api/docs
│   │       ├── app.module.ts     # Root module
│   │       ├── common/           # PrismaModule, encryption
│   │       ├── auth/             # JWT + API key + MCP guard
│   │       ├── users/            # User CRUD
│   │       ├── connectors/       # Connector CRUD + 6 engines + 3 parsers
│   │       ├── mcp-server/       # Dynamic MCP server + tool registry
│   │       ├── ai/               # AI-assisted config (Claude + OpenAI)
│   │       ├── audit/            # Tool invocation logging
│   │       └── health/           # Health check endpoint
│   │
│   └── frontend/                 # Next.js 15 (App Router, standalone)
│       ├── package.json
│       ├── next.config.ts        # output: 'standalone', API proxy
│       ├── postcss.config.js     # @tailwindcss/postcss (Tailwind v4)
│       └── src/
│           ├── app/              # Pages (dashboard, connectors, MCP, AI, logs, settings, login)
│           ├── components/       # Directory structure creata, componenti da implementare
│           └── lib/api.ts        # Client API per il backend
```

---

## 3. Tech Stack

| Componente | Tecnologia | Versione | Note |
|---|---|---|---|
| Backend | NestJS | 11.x | Framework principale |
| MCP SDK | @rekog/mcp-nest | 1.9.x | Integrazione MCP per NestJS |
| MCP Protocol | @modelcontextprotocol/sdk | 1.27.x | Peer dep di mcp-nest |
| Schema Validation | Zod | 4.x | **Obbligatorio v4** per compatibilita con @rekog/mcp-nest |
| ORM | Prisma | 6.x | PostgreSQL, genera client tipizzato |
| Auth | @nestjs/jwt + passport-jwt | 11.x / 4.x | JWT Bearer + API key |
| Encryption | Node.js crypto | built-in | AES-256-GCM per credenziali |
| HTTP Client | Axios | 1.13.x | Per connector engines |
| AI (Claude) | @anthropic-ai/sdk | 0.39.x | Per generazione tool |
| AI (OpenAI) | openai | 4.85.x | Alternativa a Claude |
| Frontend | Next.js | 15.x | App Router, standalone output |
| UI | Tailwind CSS | 4.x | Con @tailwindcss/postcss |
| UI Components | Radix UI | vari | Base per shadcn/ui (da setup-are) |
| Database | PostgreSQL | 17 | Via Docker |
| Cache | Redis | 7 | Via Docker (non ancora wired) |

---

## 4. Stato di Implementazione — Dettaglio per Modulo

### LEGENDA
- **DONE** = Implementato e funzionante, build passa
- **STUB** = File esiste, struttura corretta, ma logica interna e placeholder/TODO
- **MISSING** = Non ancora creato

---

### 4.1 Backend — `packages/backend/`

#### `src/common/` — Infrastruttura
| File | Stato | Descrizione |
|---|---|---|
| `prisma.service.ts` | **DONE** | PrismaClient wrapper con OnModuleInit/Destroy |
| `prisma.module.ts` | **DONE** | Global module, esportato |
| `crypto/encryption.util.ts` | **DONE** | `encrypt()` / `decrypt()` con AES-256-GCM. Unit test in `.spec.ts` |
| `redis.service.ts` | **DONE** | Redis client wrapper con graceful fallback (app funziona anche senza Redis) |
| `redis.module.ts` | **DONE** | Global module, esportato |

#### `src/auth/` — Autenticazione
| File | Stato | Descrizione |
|---|---|---|
| `auth.module.ts` | **DONE** | Importa UsersModule, JwtModule, PassportModule |
| `auth.service.ts` | **DONE** | hashPassword, comparePassword, generateToken, verifyToken |
| `auth.controller.ts` | **DONE** | POST `/api/auth/login` e `/api/auth/register` con Prisma |
| `jwt.strategy.ts` | **DONE** | Passport JWT strategy |
| `mcp-auth.guard.ts` | **DONE** | Guard per endpoint `/mcp`: JWT, API key, bearer statico |

**Note:** Il primo utente registrato diventa automaticamente ADMIN. Login restituisce JWT + dati utente.

#### `src/users/` — Gestione Utenti
| File | Stato | Descrizione |
|---|---|---|
| `users.module.ts` | **DONE** | Modulo base |
| `users.service.ts` | **DONE** | findByEmail, findById, create, count, findAll, update, updateAiConfig |
| `users.controller.ts` | **DONE** | `GET /me`, `PUT /me`, `PUT /me/password`, `PUT /me/ai-config` con JWT auth |

#### `src/connectors/` — Connector Engine
| File | Stato | Descrizione |
|---|---|---|
| `connectors.module.ts` | **DONE** | Importa McpServerModule, registra tutti engines e parsers |
| `connectors.service.ts` | **DONE** | CRUD completo con Prisma, encrypted auth, testConnection, executeConnectorCall |
| `connectors.controller.ts` | **DONE** | CRUD endpoints con DTO validati (CreateConnectorDto, UpdateConnectorDto) |
| `tools.controller.ts` | **DONE** | CRUD per McpTool per connettore, con auto-reload MCP server |

**Engines:**

| File | Stato | Descrizione |
|---|---|---|
| `engines/rest.engine.ts` | **DONE** | Path interpolation, query/body mapping, auth injection (API_KEY, BEARER, BASIC, OAUTH2). OAuth2 token refresh con retry automatico. Unit test in `.spec.ts` |
| `engines/graphql.engine.ts` | **DONE** | GraphQL query/mutation con variabili, auth injection |
| `engines/soap.engine.ts` | **DONE** | SOAP via `soap` npm. Auth: BasicAuth, WSSecurity, Bearer. Body mapping con $param |
| `engines/mcp-client.engine.ts` | **DONE** | MCP bridge via `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport |
| `engines/database.engine.ts` | **DONE** | SQL read-only via Prisma. Blocca INSERT/UPDATE/DELETE/DROP. Max 1000 righe, SQL injection protection |
| `engines/webhook.engine.ts` | **DONE** | HTTP webhook con HMAC signature, Bearer, API key auth |

**Parsers:**

| File | Stato | Descrizione |
|---|---|---|
| `parsers/openapi.parser.ts` | **DONE** | Parsing OpenAPI/Swagger spec con `swagger-parser`. Genera tools da paths+methods con operationId, params, body mapping |
| `parsers/wsdl.parser.ts` | **DONE** | Parsing WSDL via `soap.createClientAsync()`. Genera tools da SOAP operations |
| `parsers/graphql.parser.ts` | **DONE** | Parsing schema via GraphQL introspection query. Genera tools da Query e Mutation fields |

#### `src/mcp-server/` — Dynamic MCP Server
| File | Stato | Descrizione |
|---|---|---|
| `mcp-server.module.ts` | **DONE** | Registra McpServerService, ToolRegistry, DynamicMcpTools, tutti i 6 engines |
| `mcp-server.service.ts` | **DONE** | `onModuleInit()` carica tutti i tools dal DB. `reloadConnectorTools()` ricarica per connettore |
| `tool-registry.ts` | **DONE** | Map in-memory di tools registrati. register/unregister/get/getAll |
| `dynamic-mcp-tools.ts` | **DONE** | Due @Tool MCP: `list_available_tools` e `invoke_tool` (meta-tools). Routing corretto per connectorType |

**Come funziona il bridge MCP:**
1. All'avvio, `McpServerService.onModuleInit()` carica tutti i connectors attivi + tools abilitati dal DB
2. Ogni tool viene registrato nel `ToolRegistry` (in-memory Map)
3. `DynamicMcpTools` espone due MCP tools statici via `@rekog/mcp-nest`:
   - `list_available_tools` — Claude chiama questo per scoprire i tools disponibili
   - `invoke_tool(tool_name, params)` — Claude chiama questo per eseguire un tool
4. `invoke_tool` cerca il tool nel registry, seleziona l'engine corretto (REST/SOAP/GraphQL/MCP/Database/Webhook) tramite switch su `connectorType`, esegue la chiamata, logga il risultato

#### `src/ai/` — AI-Assisted Configuration
| File | Stato | Descrizione |
|---|---|---|
| `ai.module.ts` | **DONE** | Registra AiService + providers |
| `ai.service.ts` | **DONE** | `generateToolDefinitions()`, `improveToolDescription()`, `configureFromNaturalLanguage()` |
| `ai.controller.ts` | **DONE** | POST endpoints: `/api/ai/generate-tools`, `/api/ai/improve-description`, `/api/ai/configure` |
| `providers/claude.provider.ts` | **DONE** | Usa `@anthropic-ai/sdk`, modello `claude-sonnet-4-20250514` |
| `providers/openai.provider.ts` | **DONE** | Usa `openai`, modello `gpt-4o` |

**Note:** L'API key viene passata per-request (non da env). L'utente fornisce la propria key nel frontend.

#### `src/audit/` — Audit Logging
| File | Stato | Descrizione |
|---|---|---|
| `audit.module.ts` | **DONE** | Global module, include AuditController |
| `audit.service.ts` | **DONE** | `logInvocation()` persiste su Prisma. `getRecentInvocations()` con filtri e paginazione. `getStats()` con conteggi 24h/7d. Unit test in `.spec.ts` |
| `audit.controller.ts` | **DONE** | `GET /api/audit/invocations` e `GET /api/audit/stats` |

#### `src/health/` — Health Check
| File | Stato | Descrizione |
|---|---|---|
| `health.module.ts` | **DONE** | Usa @nestjs/terminus |
| `health.controller.ts` | **DONE** | `GET /health` con check per Database (Prisma `SELECT 1`) e Redis |

---

### 4.2 Frontend — `packages/frontend/`

| File | Stato | Descrizione |
|---|---|---|
| `src/app/layout.tsx` | **DONE** | Root layout con Providers wrapper |
| `src/app/providers.tsx` | **DONE** | Client-side AuthProvider wrapper |
| `src/app/globals.css` | **DONE** | CSS variables per light/dark mode, Tailwind v4 import |
| `src/app/page.tsx` | **DONE** | Dashboard con stats live da API (connettori, tools, invocazioni 24h, errori) |
| `src/app/login/page.tsx` | **DONE** | Login/Register toggle, chiama auth.login()/register(), salva token, redirect |
| `src/app/connectors/page.tsx` | **DONE** | Lista connettori da API, Import Spec, Delete, link a dettaglio |
| `src/app/connectors/new/page.tsx` | **DONE** | Wizard completo, crea connettore, auto-import spec, test connection |
| `src/app/connectors/[id]/page.tsx` | **DONE** | Dettaglio/edit connettore, gestione tools (crea, abilita/disabilita, elimina), import spec, test |
| `src/app/mcp-server/page.tsx` | **DONE** | Status con tools attivi da API, endpoint URL dinamico |
| `src/app/ai-assistant/page.tsx` | **DONE** | Chat funzionante con API ai.configure(), selezione provider/key |
| `src/app/logs/page.tsx` | **DONE** | Audit log da API con filtro per status |
| `src/app/settings/page.tsx` | **DONE** | Profilo (edit name), AI config (provider + API key), MCP auth info |
| `src/lib/api.ts` | **DONE** | Client API completo con tipi: auth, users, connectors, tools, audit, ai |
| `src/lib/auth-context.tsx` | **DONE** | React context con token/user, localStorage + cookie, auto-redirect a /login |
| `src/middleware.ts` | **DONE** | Next.js middleware per protezione route server-side (redirect a /login se non autenticato) |

**STATO FRONTEND:** Tutte le pagine sono collegate al backend via API. Auth flow completo (login → token → cookie + localStorage). Route protette sia lato client (AuthProvider) che server (middleware).

**Componenti mancanti:** Le directory `components/ui/`, `components/connector-wizard/`, etc. esistono ma sono vuote. shadcn/ui non e ancora stato inizializzato (`npx shadcn@latest init`).

---

### 4.3 Database — Prisma Schema

**Tabelle (8):**
1. `users` — email, passwordHash, role (ADMIN/EDITOR/VIEWER), aiProvider, aiApiKey
2. `connectors` — userId, name, type (REST/SOAP/GRAPHQL/MCP/DATABASE/WEBHOOK), baseUrl, authType, authConfig (encrypted), specUrl, specData, headers, config
3. `mcp_tools` — connectorId, name, description, parameters (JSON), endpointMapping (JSON), responseMapping (JSON), isEnabled
4. `mcp_resources` — connectorId, uri, name, description, mimeType, fetchConfig
5. `mcp_prompts` — connectorId, name, description, template, arguments
6. `mcp_server_configs` — userId, name, version, authType, authConfig, transport, endpoint
7. `tool_invocations` — toolId, userId, input, output, status, durationMs, error, clientInfo

**STATO:** Schema definito e Prisma client generato. **Non sono state create le migration**. Per far partire il progetto serve:
```bash
npx prisma migrate dev --name init
```

---

### 4.4 Docker

| File | Stato |
|---|---|
| `Dockerfile` (backend) | **DONE** — multi-stage, node:22-alpine, prisma generate + build |
| `Dockerfile.frontend` | **DONE** — multi-stage, standalone output |
| `docker-compose.yml` | **DONE** — 4 servizi: frontend(:3000), backend(:4000), postgres(:5432), redis(:6379), health checks |
| `docker-compose.dev.yml` | **DONE** — solo postgres + redis per sviluppo locale |
| `.env.example` | **DONE** — tutte le variabili documentate |

**NON TESTATO:** Il Docker Compose non e mai stato avviato end-to-end. Il Dockerfile backend e stato corretto (rimossa copia duplicata node_modules, aggiunto prisma migrate deploy nel CMD).

---

## 5. Come Avviare il Progetto (Sviluppo Locale)

```bash
cd anything-to-mcp

# 1. Avvia postgres e redis
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis

# 2. Crea .env
cp .env.example .env
# Modifica DATABASE_URL per puntare a localhost:5432

# 3. Backend
cd packages/backend
npm install                      # gia fatto
npx prisma migrate dev --name init  # MANCANTE — da fare
npx prisma generate              # gia fatto
npm run dev                      # nest start --watch

# 4. Frontend (in un altro terminale)
cd packages/frontend
npm install                      # gia fatto
npm run dev                      # next dev --port 3000
```

---

## 6. API Endpoints Esistenti

### Auth (nessun guard)
- `POST /api/auth/register` — `{ email, password, name }` → `{ accessToken, user }`
- `POST /api/auth/login` — `{ email, password }` → `{ accessToken, user }`

### Connectors (JWT required)
- `GET /api/connectors` — Lista connettori dell'utente
- `POST /api/connectors` — Crea connettore `{ name, type, baseUrl, authType?, authConfig?, specUrl?, headers? }`
- `GET /api/connectors/:id` — Dettaglio connettore (include tools, resources, prompts)
- `PUT /api/connectors/:id` — Aggiorna connettore
- `DELETE /api/connectors/:id` — Elimina connettore (cascade su tools)
- `POST /api/connectors/:id/test` — Test connessione

### Tools (JWT required)
- `GET /api/connectors/:connectorId/tools` — Lista tools di un connettore
- `POST /api/connectors/:connectorId/tools` — Crea tool `{ name, description, parameters, endpointMapping, responseMapping? }`
- `PUT /api/connectors/:connectorId/tools/:toolId` — Aggiorna tool
- `DELETE /api/connectors/:connectorId/tools/:toolId` — Elimina tool

### AI (JWT required)
- `POST /api/ai/generate-tools` — `{ apiSpec, provider, apiKey }` → array di tool definitions
- `POST /api/ai/improve-description` — `{ toolName, currentDescription, apiContext, provider, apiKey }` → descrizione migliorata
- `POST /api/ai/configure` — `{ message, existingConnectors, provider, apiKey }` → configurazione suggerita

### MCP (MCP auth guard)
- `POST /mcp` — Endpoint MCP Streamable HTTP (gestito da @rekog/mcp-nest)
- Tools disponibili via MCP: `list_available_tools`, `invoke_tool`

### Health
- `GET /health` — Health check (da completare con DB/Redis indicators)

### Swagger
- `GET /api/docs` — Swagger UI

---

## 7. Formato Dati Chiave

### endpointMapping (come un tool mappa a un'API)
```json
{
  "method": "GET",
  "path": "/users/{id}",
  "queryParams": {
    "limit": "$limit",
    "search": "$q"
  },
  "bodyMapping": {
    "name": "$name",
    "email": "$email"
  },
  "headers": {
    "X-Custom": "value"
  }
}
```
Il prefisso `$` nei valori indica un riferimento ai parametri del tool MCP. Es. `"$limit"` prende il valore dal parametro `limit` passato da Claude.

### parameters (schema parametri tool)
```json
{
  "type": "object",
  "properties": {
    "q": { "type": "string", "description": "Search query" },
    "limit": { "type": "number", "description": "Max results" }
  },
  "required": ["q"]
}
```

### authConfig (salvato encrypted nel DB)
```json
// API_KEY
{ "headerName": "X-API-Key", "apiKey": "sk-..." }

// BEARER_TOKEN
{ "token": "eyJ..." }

// BASIC_AUTH
{ "username": "user", "password": "pass" }

// OAUTH2
{ "accessToken": "...", "refreshToken": "...", "tokenUrl": "..." }
```

---

## 8. Prossimi Passi — Roadmap Dettagliata

### COMPLETATI

I seguenti task sono stati completati e funzionano:

- ~~Completare AuditService con Prisma~~ → **DONE** (logInvocation, getRecentInvocations, getStats)
- ~~Completare UsersController~~ → **DONE** (GET/PUT /me, PUT /me/password, PUT /me/ai-config)
- ~~Aggiungere endpoint audit~~ → **DONE** (AuditController con invocations e stats)
- ~~Implementare OpenApiParser~~ → **DONE** (swagger-parser, genera tools da spec)
- ~~Implementare WSDL/GraphQL parsers~~ → **DONE**
- ~~Implementare SOAP, MCP, Database, Webhook engines~~ → **DONE** (tutti e 6 gli engines funzionanti)
- ~~Fix routing engine in DynamicMcpTools~~ → **DONE** (switch su connectorType)
- ~~Implementare HealthController completo~~ → **DONE** (DB + Redis health checks)
- ~~Wire Redis~~ → **DONE** (RedisModule global con graceful fallback)
- ~~Collegare frontend al backend~~ → **DONE** (tutte le pagine connesse via API)
- ~~Auth flow frontend~~ → **DONE** (AuthProvider + middleware + cookie)
- ~~Connettore detail page~~ → **DONE** (connectors/[id] con edit, tools, import spec)
- ~~Fix Dockerfile~~ → **DONE** (rimossa copia duplicata, aggiunto prisma migrate)
- ~~OAuth2 token refresh~~ → **DONE** (auto-refresh su 401, token caching)
- ~~Unit test~~ → **DONE** (encryption, auth, rest engine, audit — 20 test)
- ~~CI/CD~~ → **DONE** (GitHub Actions: test, build backend/frontend, docker build)

### Priorita 1: Far Funzionare End-to-End

1. **Creare prima migration Prisma**
   - `cd packages/backend && npx prisma migrate dev --name init`
   - Verificare che tutte le tabelle vengano create
   - Richiede PostgreSQL attivo

2. **Testare Docker Compose end-to-end**
   - `docker compose up --build`
   - Verificare che postgres si avvia, backend fa migrate, frontend serve

### Priorita 2: UI/UX Miglioramenti

3. **Setup shadcn/ui**
   - `cd packages/frontend && npx shadcn@latest init`
   - Aggiungere componenti: Button, Input, Select, Dialog, Tabs, Toast, Table
   - Sostituire i form inline con componenti shadcn

4. **Admin panel per gestione utenti**
   - Lista utenti, cambio ruoli, inviti (ADMIN only)
   - Endpoint: `GET /api/users`, `PUT /api/users/:id/role`

### Priorita 3: Produzione

5. **Rate limiting granulare**
   - Usare Redis per rate limit per-user sull'endpoint MCP
   - Configurabile via env: `MCP_RATE_LIMIT_PER_MINUTE`

6. **Caching spec con Redis**
   - Cache delle spec OpenAPI/WSDL parsate
   - TTL configurabile per evitare re-fetch ad ogni import

7. **Pubblicazione Docker Hub**
   - `docker push kochfreiburg/anything-to-mcp:latest`
   - Tag automatici in CI/CD

---

## 9. Convenzioni del Codice

- **Backend**: NestJS standard con decoratori. Controllers in `*.controller.ts`, services in `*.service.ts`, modules in `*.module.ts`
- **MCP Tools**: Decoratore `@Tool({ name, description, parameters })` da `@rekog/mcp-nest`. Parameters con Zod v4. Return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`
- **Zod**: Usare `zod` v4 (NON v3). Per i decoratori @Tool, aggiungere `as any` per evitare type mismatch con @rekog/mcp-nest
- **Auth**: Tutte le route API (tranne /auth e /health) richiedono `@UseGuards(AuthGuard('jwt'))`. L'endpoint MCP usa `McpAuthGuard` (JWT o API key o bearer statico)
- **Credenziali**: Mai salvare in chiaro. Usare `encrypt()` / `decrypt()` da `common/crypto/encryption.util.ts`
- **Prisma**: PrismaService e global, iniettabile ovunque. Non servono import di modulo
- **Frontend**: Next.js App Router. Pagine interattive hanno `'use client'` in cima. CSS con variabili custom (`var(--background)`, etc.)

---

## 10. Variabili d'Ambiente

```env
# Obbligatorie
DATABASE_URL=postgresql://atmcp:password@localhost:5432/anythingtomcp
JWT_SECRET=almeno-32-caratteri-random
ENCRYPTION_KEY=esattamente-32-caratteri-random

# Backend
PORT=4000
CORS_ORIGIN=http://localhost:3000
REDIS_URL=redis://localhost:6379

# Frontend
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=random-string

# Opzionali (MCP server auth)
MCP_BEARER_TOKEN=token-per-claude-desktop
MCP_API_KEY=api-key-per-mcp-clients
```

---

## 11. Comandi Utili

```bash
# Backend
cd packages/backend
npm run dev                       # Avvia con hot reload
npm run build                     # Compila TypeScript → dist/
npx prisma migrate dev --name xyz # Crea migration
npx prisma generate               # Rigenera Prisma client
npx prisma studio                  # UI per esplorare il DB
npx prisma db push                 # Sync schema senza migration (dev)

# Frontend
cd packages/frontend
npm run dev                       # Next.js dev server, porta 3000
npm run build                     # Build production (standalone)

# Docker
docker compose up -d              # Avvia tutto
docker compose up --build         # Rebuild e avvia
docker compose logs -f backend    # Vedi log backend
docker compose down               # Ferma tutto
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d  # Solo DB + Redis
```

---

## 12. Problemi Noti

1. **Prisma migration non creata** — La prima cosa da fare e `npx prisma migrate dev --name init` (richiede PostgreSQL)
2. **Zod v4 cast** — I parametri `@Tool` necessitano di `as any` per compatibilita con @rekog/mcp-nest che usa tipi Zod v3 internamente
3. **ESLint** — Il frontend build mostra warning perche trova eslint.config.mjs del monorepo parent (Koch-to-n8n). Non blocca il build
4. **shadcn/ui non inizializzato** — Le directory components/ui/ esistono ma sono vuote. L'UI usa inline Tailwind
5. **Docker Compose non testato end-to-end** — I Dockerfiles buildano ma lo stack completo non e stato verificato
