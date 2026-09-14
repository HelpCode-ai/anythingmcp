<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — give your AI safe access to the software your company already runs." width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <strong>Give Claude, ChatGPT and Copilot safe access to the software your company already runs.</strong><br/>
  188 ready connectors, any REST/SOAP/GraphQL/SQL system without code, self-hosted — and it learns how your systems connect.
</p>

<p align="center">
  <a href="https://cloud.anythingmcp.com"><img src="docs/assets/cloud-button.svg" alt="Try on Cloud" height="40"></a>
</p>

<p align="center">
  <a href="#try-it-in-claude-right-now">Try it in Claude now</a> &nbsp;·&nbsp;
  <a href="#run-it-yourself">Run it yourself</a> &nbsp;·&nbsp;
  <a href="https://anythingmcp.com/guides">Setup guides</a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

```bash
curl -fsSL https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml -o docker-compose.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d   # → http://localhost:3000
```

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="Claude answering a question about field-service visits by calling tools served by AnythingMCP" width="100%" />
</p>

- **188 connectors ship with it** — Deutsche Bahn, DATEV, weclapp, DHL, Shopware, Personio, Handelsregister and 181 more. **26 need no API key at all**; the rest ask for your credentials at import.
- **Anything else takes minutes, not weeks.** Point it at an OpenAPI spec, a Postman collection, a WSDL, a GraphQL endpoint, a cURL command or a database, and the tools exist. No SDK, no MCP server to write.
- **It runs on your infrastructure, so you decide what leaves it.** Per-tool response mapping drops PII and secrets before the model ever sees them; the audit log keeps the full upstream response on your side. OAuth2, RBAC, SSO and SCIM included.

**In production at [KOCH Freiburg GmbH](https://www.kochfreiburg.de/)**, where it connects AI assistants to 15+ internal systems — ERP, CRM, SOAP services and on-prem databases. AnythingMCP was extracted from that system by [helpcode.ai](https://helpcode.ai) in Freiburg, Germany, and open-sourced because a connector catalog grows faster as a community than as a product.

<details>
<summary><strong>📖 Table of contents</strong></summary>

- [Try it in Claude right now](#try-it-in-claude-right-now)
- [Run it yourself](#run-it-yourself)
- [Key features](#key-features)
- [How AnythingMCP compares](#how-anythingmcp-compares)
- [Knowledge Graph &amp; AI skills](#knowledge-graph--ai-skills)
- [Control what the model sees](#control-what-the-model-sees)
- [Build custom Claude connectors — no code](#build-custom-claude-connectors--no-code)
- [Turn your API into a ChatGPT app](#turn-your-api-into-a-chatgpt-app)
- [Why AnythingMCP](#why-anythingmcp)
- [Pre-built adapters](#pre-built-adapters)
- [Guides, client setup &amp; FAQ](#guides-client-setup--faq)
- [Community &amp; support](#community--support)
- [Contributing](#contributing)
- [License](#license)

</details>

---

## Try it in Claude right now

No install, no signup. In Claude, go to **Settings → Connectors → Add custom connector** and paste:

```
https://cloud.anythingmcp.com/mcp/demo
```

Then ask:

> *"What's the next ICE from Freiburg to Berlin, is it delayed, and which Bundesland is postal code 79211 in?"*

Both answers come from live public APIs — Deutsche Bahn and OpenPLZ — served through a real AnythingMCP instance. The demo endpoint is read-only, rate-limited and holds no customer data; it exists so you can see the thing work before you install anything.

---

## Run it yourself

> **Requires** Docker 24+ and `openssl`. On macOS, start Docker Desktop first.

```bash
curl -fsSL https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml -o docker-compose.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open <http://localhost:3000> and register — **the first account becomes admin**. Keep the generated `.env`: `ENCRYPTION_KEY` is what decrypts the credentials you store, so losing it means re-entering every one of them.

*Measured on a fresh MacBook (Apple Silicon, Docker Desktop): 31 s to pull the image, 24 s to a healthy API and a login page. The published image is amd64 only for now — on Apple Silicon the compose file pins the platform and Docker runs it under emulation.*

| Service | Default URL |
|---|---|
| Web UI | `http://localhost:3000` |
| MCP endpoint | `http://localhost:4000/mcp` |
| Swagger docs | `http://localhost:4000/api/docs` |

**For an instance that other people or a cloud AI client can reach**, clone the repo and run `./setup.sh` instead. It asks for a domain, gets HTTPS certificates through Caddy, generates the secrets, and sets the MCP auth mode and optional SMTP/Redis — see the [Deployment Guide](docs/deployment.md). The quickstart above binds to `127.0.0.1` on purpose: it has no TLS in front of it.

**Or deploy it in one click:**

[![Try on Cloud](docs/assets/cloud-button.svg)](https://cloud.anythingmcp.com)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

---

## Key features

### Connect

- **5 connector types** — [REST](docs/connectors/rest.md), [SOAP](docs/connectors/soap.md), [GraphQL](docs/connectors/graphql.md), [Database](docs/connectors/database.md) (PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite), [MCP-to-MCP bridge](docs/connectors/mcp-bridge.md)
- **5 import formats + live discovery** — OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection, plus tool discovery straight from a running MCP server
- **188 pre-built adapters** — logistics, ERP, HR, e-commerce, payments, public data — [see the catalog](#pre-built-adapters)
- **Visual tool editor** — map parameters to path, query, body and headers; rename and describe tools so the AI reads them the way you meant
- **Dynamic MCP server** — tools register at runtime, no restart
- **Environment variables** — per-connector `{{VAR}}` interpolation, hidden from the AI

### Govern

- **[Response shaping](#control-what-the-model-sees)** — declare per tool exactly which fields reach the model; drop PII, secrets and noise before they leave your network, with a live before/after preview
- **Full auth** — OAuth2 (PKCE + Client Credentials), Bearer, API Key, Basic, WS-Security, client certificates, [LOGIN_TOKEN](docs/connectors/login-token-auth.md) and OAuth 1.0a handshakes
- **Audit logging** — every tool call recorded with input, output, duration and status
- **Roles &amp; access control** — tool-level whitelisting per custom role, per-user MCP API keys
- **[Single sign-on](docs/sso.md)** — Microsoft Entra ID, Google, Okta, Auth0 and generic OIDC; roles synced from your directory groups on every sign-in, so joiners and leavers are handled where they already are (self-hosted only)
- **[SCIM provisioning](docs/scim-entra-setup.md)** — Entra ID creates, updates and deactivates accounts on its own. Disable someone in the directory and their workspace access and MCP API keys die with it, without waiting for a sign-in (self-hosted only)

### Learn

- **[Knowledge Graph](docs/knowledge-graph.md)** — a per-workspace, PII-safe map of how your connectors' data relates, served back to the agent as an MCP tool so it chains calls across systems correctly
- **[AI skills](docs/knowledge-graph.md)** — recurring usage turned into small reusable rules and composed into the server's instructions, so they guide the agent without adding a tool call (optional, opt-in)

---

## How AnythingMCP compares

The projects AnythingMCP gets compared with are mostly MCP gateways: they federate, scope and secure MCP servers you already have. AnythingMCP starts one step earlier, because most companies have no MCP servers at all — they have a REST API, a SOAP service from 2009 and a database nobody wants to expose. Every project below solves a real problem; they just don't solve the same one.

| | What it is | Choose it instead if… |
|---|---|---|
| **[ContextForge](https://github.com/IBM/mcp-context-forge)** (IBM) | A federating gateway and registry in front of MCP servers you already have | Your tools are already MCP servers and what you need is federation, virtual servers and a registry |
| **[Docker MCP Gateway](https://github.com/docker/mcp-gateway)** | Runs catalog MCP servers as containers behind one endpoint, with secret handling | You want vendor-published MCP servers sandboxed in Docker and you're happy with the catalog as it stands |
| **[MetaMCP](https://github.com/metatool-ai/metamcp)** | Aggregates MCP servers into namespaced endpoints with a middleware layer | You mainly need to group and re-scope existing MCP servers per client |
| **[Composio](https://github.com/ComposioHQ/composio)** | A hosted catalog of 250+ managed integrations with auth handled for you | You want someone else to host it and hold the credentials, and the apps you need are already in their catalog |
| **AnythingMCP** | Turns the APIs, SOAP services and databases you already run into MCP tools, on your own infrastructure | Your systems are **not** MCP servers yet — they're REST, SOAP/WSDL, GraphQL or SQL — and the credentials have to stay with you |

Side-by-side pages with the full feature tables: [anythingmcp.com/vs](https://anythingmcp.com/vs).

---

## Knowledge Graph &amp; AI skills

A gateway that only forwards calls leaves the hard part to the agent: knowing
which tool to call next, and what your business actually means by "open order"
or "active customer". AnythingMCP learns both — **how the data in your
connectors relates**, and **how your team really uses the tools** — then feeds
that back to the AI client as context rather than as extra tool calls.

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
- **AI skills, written from real usage** — with intent capture on, each tool
  call can record *why* it was made. An AI pass turns recurring patterns into
  small reusable rules (e.g. *"today's revenue includes order statuses 2, 3 and
  4"*), scoped to a connector or a whole server. You **Apply / Edit / Dismiss**
  each one, or let **auto-apply** take the high-confidence ones (≥ 0.90)
  unattended. Applied skills are composed into the MCP server's **instructions**
  at serve time, so they guide the agent **without adding a single tool call**,
  and editing one takes effect on the next request. **Consolidate with AI**
  merges overlapping rules back into a tight set as they accumulate.
  The knowledge your team builds up by using the system stops living in
  someone's head.

The AI passes (graph enrichment, skill generation, scheduled extension) work
with OpenAI, OpenRouter or Anthropic and are **off by default** — opt-in with a
global env flag *and* a per-workspace switch. The graph, manual editing and the
MCP tool work with no LLM key at all.

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
- **Fails safe.** A broken mapping returns the raw response and logs a warning
  rather than breaking a working tool — unless you explicitly opt out.

Two payoffs at once: sensitive fields never reach the model, and every field you
drop is a field you don't pay for in the context window.

```json
{
  "transform": {
    "mode": "select",
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

1. Import your API spec (OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection) or pick a pre-built adapter
2. Adjust tool names, descriptions and parameters in the **visual editor** — what the AI sees is up to you
3. Add the gateway URL to Claude as a custom connector (OAuth 2.0 supported out of the box)

Your credentials stay on your infrastructure (AES-256-GCM at rest), every tool call lands in the audit log, and role-based access controls which users see which tools. [Step-by-step guide →](docs/integrations/claude.md)

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
| You need an MCP server for Deutsche Bahn / DHL / weclapp / … | **188 pre-built adapters** — 26 of them need no API key |
| You can't ship credentials to a SaaS gateway | **Runs on your infrastructure** — credentials AES-256-GCM at rest |
| You need auth, audit logs and RBAC | Built-in **OAuth2, audit log and role-based access** — no DIY |
| A third-party model would see every field your API returns | **[Per-tool response mapping](#control-what-the-model-sees)** — drop or reshape fields before they leave your network |
| Your agent calls tools in the wrong order, or misses how two systems connect | **[Knowledge Graph &amp; AI skills](#knowledge-graph--ai-skills)** — chaining hints and learned business rules, served as context |

**Typical use cases** — search train schedules and live delays with [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) · talk to your ERP from Claude ([weclapp](https://anythingmcp.com/guides/weclapp-erp-to-mcp), [Xentral](https://anythingmcp.com/guides/xentral-to-mcp)) · track parcels with AI ([DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp), [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp)) · validate invoices ([VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp), [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp)) · let agents query production databases safely · bridge legacy SOAP to modern AI · import a Postman collection and get MCP tools instantly.

---

## Pre-built adapters

AnythingMCP ships **188 pre-built adapters**, exposing 1,800+ tools. **26 of them need no API key**; the rest ask for your credentials at import time and the tools become available immediately. Every adapter has a setup guide on [anythingmcp.com/guides](https://anythingmcp.com/guides), in seven languages.

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

Missing one? [Request an adapter](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml) — we prioritise by 👍 — or [build it yourself](CONTRIBUTING.md): an adapter is a single JSON file.

---

## Guides, client setup &amp; FAQ

Connecting an AI client, the connector types you can build, full documentation and the FAQ all live in one place:

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor setup · REST / SOAP / GraphQL / Database / MCP-bridge connector guides · API reference &amp; deployment docs · FAQ.

Looking for a specific service? Every adapter has a step-by-step guide at **[anythingmcp.com/guides](https://anythingmcp.com/guides)**.

---

## Community &amp; support

- 💬 **Questions &amp; discussions** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions) — vote on the next adapter, share what you've built
- 🐛 **Bugs / 💡 features** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 🏢 Built by [helpcode.ai](https://helpcode.ai) in Freiburg, Germany. AI-assisted development, human-reviewed: see [AUTHORS.md](AUTHORS.md).

> ⭐ **Like what you see?** [Star this repo](https://github.com/HelpCode-ai/anythingmcp/stargazers) — every star helps another developer discover AnythingMCP.

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

## Contributing

We welcome contributions! Please read our [Contributing guide](CONTRIBUTING.md) before submitting a PR. For security issues, see [SECURITY.md](SECURITY.md).

## License

AnythingMCP is **open source**, licensed under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Cloud-operator code under `ee/` directories is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).
