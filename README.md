<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — 258 connectors, 21 of them with no API key. Your REST, SOAP/WSDL, GraphQL, SQL and MCP systems become tools for Claude, ChatGPT, Copilot and Gemini." width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>Give Claude, ChatGPT and Copilot safe access to the software your company already runs.</strong><br/>
  258 ready adapters, any REST/SOAP/GraphQL/SQL system without code, on your own infrastructure — and it learns how your systems connect.
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

**Claude answering a question no chatbot could answer**, because the data lives in a field-service system that speaks REST, not MCP:

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="Claude asked which companies a technician visited last week, calling tools served by AnythingMCP against a live field-service system" width="100%" />
</p>

**Run it yourself** — three lines, no clone, [details below](#run-it-yourself):

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d   # → http://localhost:3000
```

---

Three words appear throughout and mean three different things:

- an **adapter** is one of the 255 JSON definitions that ship in this repo — DATEV, weclapp, DHL, Deutsche Bahn, Shopware, Personio, Handelsregister and the rest. 21 of them need no API key at all; the others ask for your credentials at import.
- a **connector** is an adapter, or your own OpenAPI spec / Postman collection / WSDL / GraphQL endpoint / database, once you have configured it in your workspace. Anything you can point at, in minutes, without writing an MCP server.
- an **MCP server** is the URL you hand to Claude. It exposes the connectors you assign to it, and nothing else.

Everything runs on your infrastructure, so you decide what leaves it. Per-tool response mapping declares which fields ever reach the model; credentials are AES-256-GCM at rest; the audit log keeps the full upstream response on your side. OAuth2, RBAC, SSO and SCIM are in the self-hosted build, not held back for a paid tier.

**In production at [KOCH Freiburg GmbH](https://www.kochfreiburg.de/)**, where it connects AI assistants to 15+ internal systems — ERP, CRM, SOAP services and on-prem databases. AnythingMCP was extracted from that system by [helpcode.ai](https://helpcode.ai) in Freiburg, Germany, and open-sourced because an adapter catalog grows faster as a community than as a product.

---

## Run it yourself

**The recommended path**, and the one measured below. Requires Docker 24+ and `openssl`; on macOS, start Docker Desktop first.

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open <http://localhost:3000> and register — **the first account becomes admin**.

> **Keep the generated `.env`.** `ENCRYPTION_KEY` is what decrypts the credentials you store. Lose it and every connector has to be re-credentialed; back it up wherever you keep your other secrets.

| Service | Default URL |
|---|---|
| Web UI | `http://localhost:3000` |
| MCP endpoint | `http://localhost:4000/mcp` |
| Swagger docs | `http://localhost:4000/api/docs` |

*Measured on amd64: 31 s to pull the image, 24 s to a healthy API and a login page. The published image is amd64 only for now — the compose file pins the platform so it also runs on Apple Silicon under Docker Desktop's emulation, where the same boot took 24 s on an M-series laptop but can take a few minutes on older hardware.*

The quickstart binds to `127.0.0.1` on purpose: nothing in front of it terminates TLS. **For an instance other people or a cloud AI client can reach**, clone the repo and run `./setup.sh` — it asks for a domain, gets certificates through Caddy, generates the secrets and sets the MCP auth mode. See the [Deployment Guide](docs/deployment.md).

<details>
<summary><strong>Other ways to deploy</strong> — managed cloud, Railway, DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) is the same AGPL code, operated by us in **Frankfurt, Germany**. Start there to see it work on your own APIs without provisioning anything, and move it in-house when you want the credentials to stop travelling — the connectors are the same either way. DPA/AVV on request via [info@helpcode.ai](mailto:info@helpcode.ai). SSO and SCIM are self-hosted only.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

## What it connects, governs and learns

### Connect

- **5 connector types** — [REST](docs/connectors/rest.md), [SOAP](docs/connectors/soap.md), [GraphQL](docs/connectors/graphql.md), [Database](docs/connectors/database.md), [MCP-to-MCP bridge](docs/connectors/mcp-bridge.md). Seven database engines: PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite.
- **Import from what you already have** — OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection, or tool discovery straight from a running MCP server.
- **The adapter catalog** — [see what ships](#the-adapter-catalog).
- **Visual tool editor** — map parameters to path, query, body and headers; rename and describe tools so the AI reads them the way you meant.
- **Dynamic MCP server** — tools register at runtime, no restart. Per-connector `{{VAR}}` interpolation, hidden from the AI.

### Govern

- **[Response shaping](#control-what-the-model-sees)** — declare per tool exactly which fields reach the model, with a live before/after preview.
- **Read-only where it matters.** Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`), derived from the operation and overridable per tool, so a client can show the difference between reading an invoice and issuing a credit note. Role-based tool whitelisting lets you publish an MCP server that can only read — which is how most people should start with an ERP.
- **Every auth scheme you will meet** — OAuth2 (PKCE and Client Credentials), Bearer, API Key, Basic, WS-Security, client certificates, [LOGIN_TOKEN](docs/connectors/login-token-auth.md) and OAuth 1.0a.
- **Audit logging** — every tool call recorded with input, output, duration and status, in your own database.
- **[SSO](docs/sso.md) and [SCIM](docs/scim-entra-setup.md)** — Entra ID, Google, Okta, Auth0, generic OIDC. Roles sync from your directory groups on every sign-in; disable someone in the directory and their workspace access and MCP API keys die with it (self-hosted only).

### Learn

- **[Knowledge Graph](docs/knowledge-graph.md)** — a per-workspace, PII-safe map of how your connectors' data relates, served back to the agent as an MCP tool so it chains calls across systems correctly.
- **[AI skills](docs/knowledge-graph.md)** — recurring usage turned into small reusable rules and composed into the server's instructions, so they guide the agent without adding a tool call (optional, opt-in).

---

## Knowledge Graph &amp; AI skills

Forwarding calls leaves the hard part to the agent: knowing which tool to call
next, and what your business actually means by "open order" or "active
customer". AnythingMCP learns both — **how the data in your connectors
relates**, and **how your team really uses the tools** — then feeds that back to
the AI client as context rather than as extra tool calls.

- **Knowledge Graph** — a per-workspace map of *entities* (customers, orders,
  products…) and their *relationships*. It builds itself from tool names,
  parameters and the input/output of real calls; an optional AI pass infers the
  cross-connector links heuristics miss. It stays **PII-safe**: it stores
  entity/field *names* and relationship metadata, never the values.
- **Build it visually** — a graph editor lets you create, edit and delete
  entities and connections by hand, add descriptions, and curate what the AI
  proposed.
- **Served over MCP** — each server exposes a `kg_how_to_obtain` tool, so the
  *customer's* agent can ask "how do I get from a Shopware order to a DHL
  tracking number?" and receive chaining hints across connectors.
- **AI skills, written from real usage** — with intent capture on, each tool
  call can record *why* it was made. An AI pass turns recurring patterns into
  small reusable rules (e.g. *"today's revenue includes order statuses 2, 3 and
  4"*). You Apply, Edit or Dismiss each one, or let auto-apply take the
  high-confidence ones unattended. Applied skills are composed into the MCP
  server's **instructions** at serve time, so they guide the agent **without
  adding a single tool call**. The knowledge your team builds up by using the
  system stops living in someone's head.

The AI passes are **off by default** — opt in with a global env flag *and* a
per-workspace switch, using OpenAI, OpenRouter or Anthropic. The graph, manual
editing and the MCP tool work with no LLM key at all.

➡️ **[Knowledge Graph &amp; AI skills guide →](docs/knowledge-graph.md)**

---

## Control what the model sees

Every tool can declare **exactly which fields leave your infrastructure**. The
mapping is attached per tool and applied on the way out, so the AI client — and
the third-party model behind it — only ever receives the shape you approved.

- **Drop what should never travel.** List the paths to remove and they are
  stripped before the response reaches the agent: a customer's IBAN, an
  employee's salary, an access token an API hands back alongside the data.
- **Or declare the whole output.** A `select` template names the fields to keep
  and what to call them; a JMESPath expression covers the reshaping a template
  can't express. Where an agent is better served by a stable shape, swap the
  value for a placeholder (`"iban": "= [redacted]"`) instead of removing the
  field.
- **See it before you save it.** The editor runs the mapping against a real
  response and shows the before/after side by side, with the size difference. A
  shipped adapter measures **12,172 B → 1,072 B (−91%)** on a four-train result.
- **It fails open by default, and this says so.** If a mapping breaks at
  runtime, the raw response is returned and a warning is logged, so one bad
  expression cannot take a working tool offline. That default is wrong for
  fields that must never travel: set **`"fallbackToRaw": false`** on those
  tools and a broken mapping fails the call instead of leaking through it.

Two payoffs at once: sensitive fields never reach the model, and every field you
drop is a field you don't pay for in the context window.

```json
{
  "transform": {
    "mode": "select",
    "fallbackToRaw": false,
    "exclude": ["customer.iban", "customer.taxId"],
    "select": { "order": "$.id", "total": "$.amounts.gross", "status": "$.state" }
  }
}
```

> The audit log still records the full upstream response inside your own
> database. Shaping what the agent sees never costs you the evidence of what the
> API actually returned.

➡️ **[Response mapping reference →](docs/tool-definition.md#3-response-mapping-optional)**

---

## Build custom Claude connectors — no code

Claude supports **custom connectors**: remote MCP servers you add once in *Settings → Connectors*, and that work across Claude.ai, Claude Desktop and Claude Code. AnythingMCP creates that connector **from any API you already have** — without writing an MCP server:

1. Import your API spec, or pick a pre-built adapter
2. Adjust tool names, descriptions and parameters in the **visual editor** — what the AI sees is up to you
3. Add your MCP server's URL to Claude as a custom connector (OAuth 2.0 supported out of the box)

Your credentials stay on your infrastructure, every tool call lands in the audit log, and role-based access controls which users see which tools. [Step-by-step guide →](docs/integrations/claude.md)

---

## Turn your API into a ChatGPT app

**Apps in ChatGPT are built on MCP**, and AnythingMCP gives you that MCP backend without writing one. Point it at your REST, SOAP, GraphQL or database endpoint and you get a ChatGPT-ready connector: add it in ChatGPT's settings (or use it as the tool layer of an Apps SDK app) and ChatGPT can read and act on your business data.

The same connector works simultaneously in **Claude, ChatGPT, Gemini, Copilot and Cursor** — build once, connect everywhere. [ChatGPT setup guide →](docs/integrations/chatgpt.md)

---

## Why AnythingMCP

AI clients speak MCP, but your systems speak REST, SOAP, GraphQL and SQL. Writing and maintaining a bespoke MCP server per system — with auth, audit and access control — takes weeks each. AnythingMCP is the no-code layer in between:

| Problem | Solution |
|---|---|
| You have REST APIs but AI clients speak MCP | **REST → MCP** conversion with OpenAPI / Swagger import |
| You have legacy SOAP/WSDL services | **SOAP → MCP** bridge with automatic WSDL parsing |
| You need to query databases from AI agents | **DB → MCP** with auto-generated query tools (7 engines) |
| You want one endpoint for all your APIs | **MCP middleware** that aggregates multiple connectors |
| You need an MCP server for Deutsche Bahn / DHL / weclapp / … | **The adapter catalog** — install and credential it in a minute |
| You can't ship credentials to a third party | **Runs on your infrastructure** — credentials AES-256-GCM at rest |
| You need auth, audit logs and RBAC | Built-in **OAuth2, audit log and role-based access** — no DIY |
| A third-party model would see every field your API returns | **[Per-tool response mapping](#control-what-the-model-sees)** — drop or reshape fields before they leave your network |
| Your agent calls tools in the wrong order, or misses how two systems connect | **[Knowledge Graph &amp; AI skills](#knowledge-graph--ai-skills)** — chaining hints and learned business rules, served as context |

**What people actually build with it**

| | Guides |
|---|---|
| Ask about trains, live delays and routes | [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |
| Talk to the ERP from Claude | [weclapp](https://anythingmcp.com/guides/weclapp-to-mcp) · [Xentral](https://anythingmcp.com/guides/xentral-to-mcp) |
| Track parcels | [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp) · [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| Validate an invoice before paying it | [VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp) · [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| Let agents read a production database, read-only | [Database connectors](docs/connectors/database.md) |
| Bridge a SOAP service from 2009 to a 2026 model | [SOAP → MCP](https://anythingmcp.com/guides/soap-to-mcp) |

---

## The adapter catalog

258 adapters, exposing 1,800+ tools. **21 need no API key**; the rest ask for your credentials at import and the tools are available immediately. Every one has a setup guide on [anythingmcp.com/guides](https://anythingmcp.com/guides), in seven languages.

| Category | Examples |
|---|---|
| 📦 Logistics &amp; shipping | Deutsche Bahn, DHL, DPD, GLS, Shipcloud, Sendcloud |
| 💼 ERP, accounting &amp; invoicing | weclapp, Xentral, DATEV, Scopevisio, Billomat, FastBill |
| 🛍️ E-commerce | Amazon Seller, Etsy, Shopware 6, WooCommerce, Mercado Libre 🌎, Oxomi |
| 👥 HR &amp; field service | Personio, HRWorks, Kenjo, MFR Mobile Field Report |
| 🏛️ Government &amp; public data | VIES VAT, Handelsregister, UK Companies House 🇬🇧, DESTATIS, Bundesbank, OpenPLZ, NINA |
| 🏦 Banking &amp; payments | N26, Wise 🇬🇧, PAYONE, Razorpay 🇮🇳, Paystack 🇳🇬 |
| 💬 Messaging &amp; communication | WhatsApp, LINE 🇯🇵, TeamViewer |
| 🎾 Sports &amp; Web3 | Playtomic, Sorare |
| 🏗️ Construction &amp; mapping | PlanRadar, HERE Geocoding |

**An adapter is a single JSON file.** That is why the catalog is this size, and why adding one is a reasonable first contribution. Missing yours? [Request it](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml) — we prioritise by 👍 — or [build it](CONTRIBUTING.md).

---

## Guides, client setup &amp; FAQ

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor setup · REST / SOAP / GraphQL / Database / MCP-bridge connector guides · API reference &amp; deployment docs · FAQ.

Looking for a specific service? Every adapter has a step-by-step guide at **[anythingmcp.com/guides](https://anythingmcp.com/guides)**.

---

## How AnythingMCP compares

The projects it gets compared with are mostly MCP gateways: they federate, scope and secure MCP servers you already have. AnythingMCP starts one step earlier, because most companies have no MCP servers at all — they have a REST API, a SOAP service from 2009 and a database nobody wants to expose. Every project below solves a real problem; they just don't solve the same one.

| | What it is | Choose it instead if… |
|---|---|---|
| **[ContextForge](https://github.com/IBM/mcp-context-forge)** (IBM) | Federation and a registry in front of MCP servers you already have | Your tools are already MCP servers and what you need is federation, virtual servers and a registry |
| **[Docker MCP Gateway](https://github.com/docker/mcp-gateway)** | Runs catalog MCP servers as containers behind one endpoint, with secret handling | You want vendor-published MCP servers sandboxed in Docker and the published catalog covers you |
| **[MetaMCP](https://github.com/metatool-ai/metamcp)** | Aggregates MCP servers into namespaced endpoints with a middleware layer | You mainly need to group and re-scope existing MCP servers per client |
| **[Composio](https://github.com/ComposioHQ/composio)** | A hosted catalog of managed integrations with auth handled for you | A fixed managed catalog is enough and you never need to add your own SOAP service, in-house API or database |
| **AnythingMCP** | Turns the APIs, SOAP services and databases you already run into MCP tools | Your systems are **not** MCP servers yet, and you want the choice of holding the credentials yourself |

Side-by-side pages with the full feature tables: [anythingmcp.com/vs](https://anythingmcp.com/vs).

## Community &amp; support

- 💬 **Questions &amp; discussions** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions) — vote on the next adapter, share what you've built
- 🐛 **Bugs / 💡 features** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 👥 **Adopters** — [ADOPTERS.md](ADOPTERS.md) — who runs AnythingMCP in production, and how to add yourself
- 🔐 **Security** — please do not open a public issue; follow [SECURITY.md](SECURITY.md)
- 🏢 Built by [helpcode.ai](https://helpcode.ai) in Freiburg, Germany. AI-assisted development, human-reviewed — [AUTHORS.md](AUTHORS.md) says which parts and how.

## Contributing

Read the [Contributing guide](CONTRIBUTING.md) before opening a PR. The easiest useful contribution is an adapter: one JSON file, and there is a [walkthrough issue](https://github.com/HelpCode-ai/anythingmcp/issues/150) for it.

## License

**Open source** under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Commercial use inside your own company is included and always was; the copyleft obligation only starts if you modify AnythingMCP and offer the modified version to others over a network. Cloud-operator code under `ee/` is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).

---

<p align="center">
  <strong>⭐ If this saved you a week of writing MCP servers, star it.</strong><br/>
  <em>Stars are how the next person finds it — and how we decide which adapter to build next.</em>
</p>

<p align="center">
  <a href="https://star-history.com/#HelpCode-ai/anythingmcp&Date">
    <img src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" alt="Star history" width="70%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=HelpCode-ai/anythingmcp" alt="Contributors">
  </a>
</p>
