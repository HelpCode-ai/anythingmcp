[![MCP Toplist](https://mcptoplist.com/badge/io.github.keysersoft%2Fanythingmcp.svg)](https://mcptoplist.com/server/io.github.keysersoft%2Fanythingmcp)

<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — turn any API, database or MCP server into custom connectors for Claude, ChatGPT, Gemini, Copilot and Cursor." width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <strong>Turn any API, database or MCP server into custom connectors for Claude, ChatGPT and more — no code.</strong><br/>
  The self-hosted, <strong>AI-empowered MCP gateway</strong> that converts REST, SOAP/WSDL, GraphQL, SQL/NoSQL databases and other MCP servers into AI tools — then learns how their data connects and teaches your agents to use them, with auth and full audit.
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2563eb?labelColor=0b1220" alt="License"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/badge/docker-ready-2563eb?logo=docker&logoColor=white&labelColor=0b1220" alt="Docker Ready"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/commits/main"><img src="https://img.shields.io/github/last-commit/HelpCode-ai/anythingmcp?color=2563eb&labelColor=0b1220" alt="Last Commit"></a>
  <a href="https://glama.ai/mcp/servers/HelpCode-ai/anythingmcp"><img src="https://glama.ai/mcp/servers/HelpCode-ai/anythingmcp/badges/score.svg" alt="anythingmcp MCP server"></a>
</p>

<p align="center">
  <a href="https://cloud.anythingmcp.com"><strong>Try on Cloud →</strong></a> &nbsp;·&nbsp;
  <a href="https://anythingmcp.com/en/video-promo"><strong>Watch 90-sec demo →</strong></a> &nbsp;·&nbsp;
  <a href="https://anythingmcp.com/guides"><strong>Setup guides →</strong></a>
</p>

**AnythingMCP** is a self-hosted, open-source **smart, AI-empowered MCP gateway** and **MCP server** that turns the systems you already run into [Model Context Protocol](https://modelcontextprotocol.io/) tools — **REST and SOAP APIs, GraphQL, SQL & NoSQL databases, and even other MCP servers**. Import a spec or point it at a database, and expose it as a **custom connector** to **Claude**, **ChatGPT**, **Gemini**, **Copilot**, **Cursor** and any MCP-compatible client. No SDK, no code changes — point, configure, connect.

It ships with **175+ ready-to-use adapters** — including **Deutsche Bahn**, **weclapp ERP**, **Etsy**, **Shopware**, **DHL** and **Sendcloud** — so the most common integrations work in one click, while the visual editor and import tools (OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL) let you wrap any other API or database in minutes.

What makes it **smart**, not just a pipe: AnythingMCP builds a per-workspace **Knowledge Graph** of how your connectors' data relates, serves it back to the agent over MCP so it chains tools correctly across systems, and turns how your tools are actually used into reusable **AI skills**. A plain gateway forwards calls; AnythingMCP gives your agents the context to use them well. *(All AI features are optional and opt-in — the gateway works fully without them.)*

https://github.com/user-attachments/assets/2ae92f90-7012-4c00-8836-bae5a6422ca6

<p align="center">
  <em>90-second demo — <a href="https://anythingmcp.com/demo.mp4">direct link</a> if the player doesn't load.</em>
</p>

<details>
<summary><strong>📖 Table of contents</strong></summary>

- [Get started in 60 seconds](#get-started-in-60-seconds)
- [Key features](#key-features)
- [Knowledge Graph &amp; AI skills](#knowledge-graph--ai-skills)
- [Build custom Claude connectors — no code](#build-custom-claude-connectors--no-code)
- [Turn your API into a ChatGPT app](#turn-your-api-into-a-chatgpt-app)
- [Why AnythingMCP](#why-anythingmcp)
- [Pre-configured MCP connectors](#pre-configured-mcp-connectors)
- [Guides, client setup &amp; FAQ](#guides-client-setup--faq)
- [Community &amp; support](#community--support)
- [License](#license)

</details>

---

## Get started in 60 seconds

> **Requires** Docker 24+, `bash`, `openssl`. On macOS, start Docker Desktop first.

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh
# When setup finishes, open http://localhost:3000 and register
# the first user — they automatically become the admin.
```

The interactive setup handles everything: deployment mode, domain & HTTPS (automatic Let's Encrypt via Caddy), secrets, MCP auth mode, optional SMTP/Redis.

> ⚠️ **Register immediately after setup.** The first account to register becomes Admin. If your instance is reachable from the internet during setup, configure firewall rules or bind the UI to `127.0.0.1` until you've created the admin account.

| Service | Default URL |
|---|---|
| Web UI | `http://localhost:3000` |
| MCP endpoint | `http://localhost:4000/mcp` |
| Swagger docs | `http://localhost:4000/api/docs` |

**Or one-click deploy:**

[![Try on Cloud](docs/assets/cloud-button.svg)](https://cloud.anythingmcp.com)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

> **Prefer manual setup?** Copy `.env.example` to `.env` and run `docker compose up -d` — see the [Deployment Guide](docs/deployment.md).

---

## Key features

- **5 connector types** — [REST](docs/connectors/rest.md), [SOAP](docs/connectors/soap.md), [GraphQL](docs/connectors/graphql.md), [Database](docs/connectors/database.md) (PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite), [MCP-to-MCP bridge](docs/connectors/mcp-bridge.md)
- **6 import formats** — OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection, custom JSON
- **175+ pre-built adapters** — logistics, ERP, HR, e-commerce, payments, public data — [see catalog](#pre-configured-mcp-connectors)
- **Visual tool editor** — map parameters to path, query, body, headers; rename and describe tools for the AI
- **Dynamic MCP server** — tools registered at runtime, no restart
- **[Knowledge Graph &amp; AI skills](docs/knowledge-graph.md)** — a per-workspace, PII-safe map of how your connectors' data relates, served to the agent via an MCP tool, plus reusable AI skills composed into the server's instructions (optional, opt-in)
- **Full auth** — OAuth2 (PKCE + Client Credentials), Bearer, API Key, Basic, WS-Security, client certificates, [LOGIN_TOKEN](docs/connectors/login-token-auth.md) and OAuth 1.0a handshakes
- **Audit logging** — every tool call logged with input, output, duration, status
- **Roles &amp; access control** — tool-level whitelisting per custom role, per-user MCP API keys
- **Environment variables** — per-connector `{{VAR}}` interpolation, hidden from the AI
- **Docker ready** — `docker compose up` and you're running

---

## Knowledge Graph &amp; AI skills

Beyond exposing tools, AnythingMCP can map **how the data in your connectors
relates** — and feed that context back to the AI client so it chains tools
correctly across systems.

- **Knowledge Graph** — a per-workspace map of *entities* (customers, orders,
  products…) and their *relationships*. It builds itself from tool names,
  parameters and the input/output of real calls; an optional AI pass infers the
  cross-connector links heuristics miss. It stays **PII-safe**: it stores
  entity/field *names* and relationship metadata, never the values.
- **Build it visually** — a graph editor lets you **create, edit and delete
  entities and connections** by hand, add descriptions, and curate what the AI
  proposed. Zoom/fit controls, connectivity-based layout and hover focus make a
  large graph navigable.
- **Served over MCP** — each server exposes a `kg_how_to_obtain` tool so the
  *customer's* agent can ask "how do I get this?" and receive chaining hints
  across connectors.
- **AI skills** — reusable business rules captured from how the tools are
  actually used (e.g. *"today's revenue includes order statuses 2, 3 and 4"*),
  reviewed by a human, then composed into the MCP server's **instructions** — so
  they guide the agent **without adding any extra tool calls**. Search, status
  tabs and pagination keep them manageable at scale; optional **auto-apply** for
  high-confidence skills and an AI **"consolidate"** action merges overlapping
  ones into fewer rules.

The AI passes (graph enrichment, skill generation, scheduled extension) work
with OpenAI, OpenRouter or Anthropic and are **off by default** — opt-in with a
global env flag *and* a per-workspace switch. The graph, manual editing and the
MCP tool work with no LLM key at all.

➡️ **[Knowledge Graph &amp; AI skills guide →](docs/knowledge-graph.md)**

---

## Build custom Claude connectors — no code

Claude supports **custom connectors**: remote MCP servers you add once in *Settings → Connectors*, and that work across Claude.ai, Claude Desktop and Claude Code. AnythingMCP creates that connector **from any API you already have** — without writing an MCP server:

1. Import your API spec (OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection) or pick a pre-built adapter
2. Adjust tool names, descriptions and parameters in the **visual editor** — what the AI sees is up to you
3. Add the gateway URL to Claude as a custom connector (OAuth 2.0 supported out of the box)

Your credentials stay on your infrastructure (AES-256-GCM at rest), every tool call lands in the audit log, and role-based access controls which users see which tools. [Step-by-step guide →](docs/integrations/claude.md)

---

## Turn your API into a ChatGPT app

**Apps in ChatGPT — what OpenAI renamed connectors to in December 2025 — are built on MCP**, and AnythingMCP gives you that MCP backend without writing one. Point it at your REST, SOAP, GraphQL or database endpoint and you get a ChatGPT-ready connector: add it in ChatGPT's settings (or use it as the tool layer of an Apps SDK app) and ChatGPT can read and act on your business data.

The same connector works simultaneously in **Claude, ChatGPT, Gemini, Copilot and Cursor** — build once, connect everywhere. [ChatGPT setup guide →](docs/integrations/chatgpt.md)

---

## Why AnythingMCP

AI clients speak MCP, but your systems speak REST, SOAP, GraphQL and SQL. Writing and maintaining a bespoke MCP server per system — with auth, audit and access control — takes weeks each. AnythingMCP is the no-code layer in between:

| Problem | Solution |
|---|---|
| You have REST APIs but AI clients speak MCP | **REST → MCP** conversion with OpenAPI / Swagger import |
| You have legacy SOAP/WSDL services | **SOAP → MCP** bridge with automatic WSDL parsing |
| You need to query databases from AI agents | **DB → MCP** with auto-generated query tools (7 engines) |
| You want one MCP gateway for all your APIs | **MCP middleware** that aggregates multiple connectors |
| You need an MCP server for Deutsche Bahn / DHL / weclapp / … | **175+ pre-built adapters** — install in one click |
| You can't ship credentials to a SaaS gateway | **Runs on your infrastructure** — credentials AES-256-GCM at rest |
| You need auth, audit logs, and RBAC | Built-in **OAuth2, audit log, and role-based access** — no DIY |

**Typical use cases** — search train schedules and live delays with [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) · talk to your ERP from Claude ([weclapp](https://anythingmcp.com/guides/weclapp-erp-to-mcp), [Xentral](https://anythingmcp.com/guides/xentral-to-mcp)) · track parcels with AI ([DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp), [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp)) · validate invoices ([VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp), [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp)) · let agents query production databases safely · bridge legacy SOAP to modern AI · import a Postman collection and get MCP tools instantly.

---

## Pre-configured MCP connectors

AnythingMCP ships with **175+ ready-to-use adapters** — provide your API credentials at import time and the tools become available immediately. Every adapter has a setup guide on [anythingmcp.com/guides](https://anythingmcp.com/guides) (English, German, Italian).

| Category | Examples |
|---|---|
| 📦 Logistics &amp; shipping | Deutsche Bahn, DHL, DPD, GLS, Shipcloud, Sendcloud |
| 💼 ERP, accounting &amp; invoicing | weclapp, Xentral, Scopevisio, Billomat, FastBill |
| 🛍️ E-commerce | Etsy, Shopware 6, WooCommerce, Mercado Libre 🌎, ImmobilienScout24, Oxomi |
| 👥 HR &amp; field service | Personio, HRWorks, Kenjo, MFR Mobile Field Report |
| 🏛️ Government &amp; public data | VIES VAT, Handelsregister, UK Companies House 🇬🇧, DESTATIS, Bundesbank, OpenPLZ, NINA |
| 🏦 Banking &amp; payments | N26, Wise 🇬🇧, PAYONE, Razorpay 🇮🇳, Paystack 🇳🇬 |
| 💬 Messaging &amp; communication | WhatsApp, LINE 🇯🇵, TeamViewer |
| 🎾 Sports &amp; Web3 | Playtomic, Sorare |
| 🏗️ Construction &amp; mapping | PlanRadar, HERE Geocoding |

---

## Guides, client setup &amp; FAQ

Connecting an AI client, the connector types you can build, full documentation and the FAQ now live in one place:

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor setup · REST / SOAP / GraphQL / Database / MCP-bridge connector guides · API reference & deployment docs · FAQ.

Looking for a specific service? Every adapter has a step-by-step guide at **[anythingmcp.com/guides](https://anythingmcp.com/guides)**.

---

## Community &amp; support

- 💬 **Questions &amp; discussions** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions) — vote on the next adapter, share what you've built
- 🐛 **Bugs / 💡 features** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 🏢 Built by [helpcode.ai](https://helpcode.ai) in Freiburg, Germany — AnythingMCP was extracted from a production system connecting AI agents to 15+ legacy systems (ERP, CRM, SOAP, on-prem databases) in a German industrial group, and open-sourced because the catalog grows faster as a community. AI-assisted development, human-reviewed: see [AUTHORS.md](AUTHORS.md).

> ⭐ **Like what you see?** [Star this repo](https://github.com/HelpCode-ai/anythingmcp/stargazers) — every star helps another developer discover AnythingMCP.

## Contributing

We welcome contributions! Please read our [Contributing guide](CONTRIBUTING.md) before submitting a PR. For security issues, see [SECURITY.md](SECURITY.md).

## License

AnythingMCP is **open source**, licensed under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Cloud-operator code under `ee/` directories is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).
