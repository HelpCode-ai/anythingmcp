<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — Build custom MCP connectors for your company. For Claude, ChatGPT and Copilot." width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <strong>The self-hosted MCP gateway for legacy &amp; modern APIs.</strong><br/>
  Turn REST, SOAP/WSDL, GraphQL and SQL endpoints into MCP tools — on your infrastructure, with full audit.
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2563eb?labelColor=0b1220" alt="License"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/badge/docker-ready-2563eb?logo=docker&logoColor=white&labelColor=0b1220" alt="Docker Ready"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/commits/main"><img src="https://img.shields.io/github/last-commit/HelpCode-ai/anythingmcp?color=2563eb&labelColor=0b1220" alt="Last Commit"></a>
</p>

<p align="center">
  <a href="https://cloud.anythingmcp.com"><strong>Try on Cloud →</strong></a> &nbsp;·&nbsp;
  <a href="https://anythingmcp.com/en/video-promo"><strong>Watch 90-sec demo →</strong></a> &nbsp;·&nbsp;
  <a href="https://anythingmcp.com/guides"><strong>Setup guides →</strong></a>
</p>

<p align="center">
  <strong>⭐ Star this repo</strong> if you find it useful &middot; <strong>👀 Watch</strong> to get notified about new adapters and releases &middot;
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docs/assets/demo.gif" alt="AnythingMCP demo — turning a REST API into an MCP server with no code" />
</p>

---

> **🏭 Origin story.** AnythingMCP started inside a German industrial group that needed AI agents to talk to 15+ legacy systems (ERP, CRM, custom SOAP, on-prem Postgres). Writing one MCP server per system would have taken weeks each; we extracted the common gateway after the third rewrite and have been running it in production for ~6 months. We open-sourced it because the catalog grows faster as a community than as a single vendor. Built by a small team using AI coding assistants — see [AUTHORS.md](AUTHORS.md).

<details>
<summary><strong>📖 Table of contents</strong></summary>

- [What is AnythingMCP?](#what-is-anythingmcp)
- [Get started in 60 seconds](#get-started-in-60-seconds)
- [Use cases](#use-cases)
- [Why AnythingMCP](#why-anythingmcp)
- [How it compares](#how-it-compares)
- [Key features](#key-features)
- [Pre-configured MCP connectors](#pre-configured-mcp-connectors)
- [Quick Start](#quick-start)
- [Connect your AI client](#connect-your-ai-client)
- [Connector guides](#connector-guides)
- [Architecture](#architecture)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Tech stack](#tech-stack)
- [Community &amp; support](#community--support)
- [Star history](#star-history)
- [License](#license)

</details>

---

## What is AnythingMCP?

**AnythingMCP** is a self-hosted, open-source **MCP server** and **API gateway** that turns your existing APIs into [Model Context Protocol](https://modelcontextprotocol.io/) tools. Connect **any** API — REST, SOAP, GraphQL, databases, or other MCP servers — and expose them to **Claude**, **ChatGPT**, **Gemini**, **Copilot**, **Cursor**, and any other MCP-compatible client.

No SDK. No code changes. Point, configure, connect.

**Built-in adapters** ship with the catalog so you get an instant MCP server for popular SaaS and public APIs — DHL, DPD, GLS, Shipcloud, Sendcloud, Deutsche Bahn, DATEV, Weclapp, Xentral, Shopware 6, Personio, Handelsregister, VIES VAT, OpenPLZ, HERE Geocoding, Oxomi and more ([full list below](#pre-configured-mcp-connectors)).

---

## Get started in 60 seconds

> **Requires** Docker 24+, `bash`, `openssl`. On macOS, start Docker Desktop first.

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp && ./setup.sh
# When setup finishes, open http://localhost:3000 and register
# the first user — they automatically become the admin.
```

> ⚠️ **Register immediately after setup.** The first account to register becomes Admin. If your instance is reachable from the internet during setup, configure firewall rules or bind the UI to `127.0.0.1` until you've created the admin account.

### Or one-click deploy

[![Try on Cloud](docs/assets/cloud-button.svg)](https://cloud.anythingmcp.com)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

---

## Use cases

- **Talk to your ERP from Claude Desktop** — connect SAP, Oracle, [Weclapp](https://anythingmcp.com/guides/weclapp-erp-to-mcp), [Xentral](https://anythingmcp.com/guides/xentral-to-mcp), [DATEV](https://anythingmcp.com/guides/datev-to-mcp) or any REST/SOAP ERP and query it conversationally
- **Track parcels with AI** — built-in MCP servers for [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp), [DPD](https://anythingmcp.com/guides/dpd-germany-to-mcp), [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp), [Shipcloud](https://anythingmcp.com/guides/shipcloud-to-mcp) and [Sendcloud](https://anythingmcp.com/guides/sendcloud-to-mcp)
- **Automate B2B compliance** — pre-flight every invoice with [VIES VAT validation](https://anythingmcp.com/guides/vies-vat-to-mcp) and [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) lookups
- **Let AI agents query your production database safely** — read-only database connectors with audit logging
- **Bridge legacy SOAP services to modern AI workflows** — automatic WSDL parsing, no code changes
- **Aggregate multiple MCP servers behind one gateway** — MCP-to-MCP bridge for unified tool access
- **Import your Postman collection and get MCP tools instantly** — zero-config API onboarding

---

## Why AnythingMCP

| Problem | Solution |
|---|---|
| You have REST APIs but AI clients speak MCP | **REST → MCP** conversion with OpenAPI / Swagger import |
| You have legacy SOAP/WSDL services | **SOAP → MCP** bridge with automatic WSDL parsing |
| You need to query databases from AI agents | **DB → MCP** with auto-generated query tools |
| You want one MCP gateway for all your APIs | **MCP middleware** that aggregates multiple connectors |
| You need an MCP server for DHL/DPD/DATEV/Weclapp/… | **36+ pre-built adapters** — install in one click |
| You need auth, audit logs, and RBAC | Built-in **auth, audit log, and RBAC** |
| You can't ship credentials to a SaaS gateway | **Runs on your infrastructure** — credentials AES-256-GCM at rest |
| You have SOAP/WSDL or on-prem databases AI clients can't speak | **First-class SOAP &amp; SQL** — not just REST integrations |

---

## How it compares

| Feature | AnythingMCP | Custom MCP server | Hosted MCP gateways |
|---|:-:|:-:|:-:|
| No-code setup | ✅ Visual editor | ❌ Write code | ⚠️ Config files |
| SOAP / WSDL support | ✅ Built-in | ❌ Manual | ❌ Rarely supported |
| Database connectors | ✅ 7 engines | ❌ Build yourself | ⚠️ Limited |
| Visual tool editor | ✅ | ❌ | ❌ |
| Auth &amp; audit trail | ✅ OAuth2, RBAC, logs | ❌ DIY | ⚠️ Partial |
| Where credentials live | ✅ Your infra (AES-256-GCM) | ✅ Your code | ⚠️ Gateway provider |
| Self-hosted option | ✅ Docker / Railway / DO / [Cloud](https://cloud.anythingmcp.com) | ✅ | ⚠️ Often SaaS-only |
| Pre-built SaaS adapters | ✅ 36+ ready-to-use | ❌ Build each | ⚠️ Few |
| Multi-client support | ✅ Claude, ChatGPT, Gemini, Copilot, Cursor | ✅ | ⚠️ Varies |

---

## Key features

- **5 connector types** — [REST](docs/connectors/rest.md), [SOAP](docs/connectors/soap.md), [GraphQL](docs/connectors/graphql.md), [Database](docs/connectors/database.md) (PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite), [MCP-to-MCP bridge](docs/connectors/mcp-bridge.md)
- **6 import formats** — OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL introspection, custom JSON
- **36+ pre-built adapters** — logistics, ERP, HR, public data, payments, e-commerce, messaging — [see catalog](#pre-configured-mcp-connectors)
- **Dynamic MCP server** — tools registered at runtime, no restart
- **Visual tool editor** — map parameters to path, query, body, headers visually
- **Database auto-tools** — schema introspection + dynamic query execution out of the box
- **Environment variables** — per-connector `{{VAR}}` interpolation, hidden from AI
- **Full auth** — OAuth2 (PKCE + Client Credentials), Bearer, API Key, Basic, Query, WS-Security, Certificates
- **Audit logging** — every tool call logged with input, output, duration, status
- **Roles &amp; access control** — tool-level whitelisting per custom role
- **Per-user MCP API keys** — individual keys with usage tracking
- **Docker ready** — `docker compose up` and you're running

---

## Pre-configured MCP connectors

AnythingMCP ships with **37+ ready-to-use adapters** — DACH-rooted but reaching the UK, India, Brasil, Nigeria, Japan and the global gaming web3 space. Provide your API credentials at import time and the tools become available immediately. Each adapter has its own setup guide on [anythingmcp.com](https://anythingmcp.com/guides) (English, German, Italian).

> 📍 **Catalog heads-up.** The starting set leans DACH (Germany / Austria / Switzerland) because that's where this was built in production first, with first-wave international coverage now landing across 🇬🇧 UK, 🇮🇳 India, 🇧🇷 Brasil, 🇳🇬 Nigeria and 🇯🇵 Japan. US/APAC SaaS adapters are very welcome as community PRs — there's a [good-first-issue](https://github.com/HelpCode-ai/anythingmcp/issues/150) walking you through adding one in ~30 minutes (single JSON file).

### 🎮 Gaming & Web3 — featured

<p align="center">
  <img src="docs/assets/icons/sorare.svg" alt="Sorare" width="220" />
</p>

| Connector | Description | Guides |
|---|---|---|
| **Sorare Fantasy Football** ⚽🌍 | NFT fantasy football, baseball & basketball — **18 tools** over cards, players, So5 lineups, wallet, scoring history and the live transfer market. Bcrypt-salted login + 30-day JWT caching handled for you. | [Sorare → MCP](docs/guides/sorare-to-mcp.md) · [Claude](docs/guides/connect-sorare-to-claude.md) · [ChatGPT](docs/guides/connect-sorare-to-chatgpt.md) · [Copilot](docs/guides/connect-sorare-to-copilot.md) · [OpenClaw](docs/guides/connect-sorare-to-openclaw.md) · [Cloud](docs/guides/connect-sorare-to-cloud.md) |

Sorare is also the reference implementation of AnythingMCP's new **`LOGIN_TOKEN`** AuthType — a declarative spec for any API that requires a custom bcrypt-style sign-in handshake before issuing a long-lived bearer. Reuse the pattern for any other crypto / fintech / gaming API with non-OAuth auth: see [`docs/connectors/login-token-auth.md`](docs/connectors/login-token-auth.md).

### 📦 Logistics &amp; shipping

| Connector | Description | Guide |
|---|---|---|
| **DHL Tracking** | Worldwide DHL shipment tracking via Unified Tracking API | [→](https://anythingmcp.com/guides/dhl-tracking-to-mcp) |
| **DPD Germany Tracking** | Public DPD parcel-life-cycle tracking, no API key | [→](https://anythingmcp.com/guides/dpd-germany-to-mcp) |
| **GLS Track &amp; Trace** | EU-wide GLS parcel tracking, no API key | [→](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| **Shipcloud** | Multi-carrier shipping &amp; label aggregator (DHL, DPD, GLS, Hermes, UPS, FedEx) | [→](https://anythingmcp.com/guides/shipcloud-to-mcp) |
| **Sendcloud** | Multi-carrier EU shipping platform — 40+ carriers under one API | [→](https://anythingmcp.com/guides/sendcloud-to-mcp) |
| **Deutsche Bahn Fahrplan** | Train timetables, departures, journey planning | [→](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |

### 💼 ERP, accounting &amp; invoicing

| Connector | Description | Guide |
|---|---|---|
| **DATEV** | Buchhaltung &amp; tax — used by 90% of German tax consultants | [→](https://anythingmcp.com/guides/datev-to-mcp) |
| **Weclapp** | Cloud ERP for German SMBs — customers, orders, articles | [→](https://anythingmcp.com/guides/weclapp-erp-to-mcp) |
| **Scopevisio** | German cloud ERP/CRM — contacts, invoices, projects | [→](https://anythingmcp.com/guides/scopevisio-to-mcp) |
| **Xentral** | SaaS ERP for e-commerce, wholesale, manufacturing | [→](https://anythingmcp.com/guides/xentral-to-mcp) |
| **Billomat** | Online invoicing &amp; bookkeeping for DE SMBs | [→](https://anythingmcp.com/guides/billomat-to-mcp) |
| **FastBill** | Invoicing tool for German freelancers and SMBs | [→](https://anythingmcp.com/guides/fastbill-to-mcp) |

<details>
<summary><strong>🛍️ E-commerce, 👥 HR, 🏛️ Government, 🏦 Banking, 🏗️ Construction, 💬 Messaging — expand</strong></summary>

#### 🛍️ E-commerce &amp; catalog

| Connector | Description | Guide |
|---|---|---|
| **Shopware 6** | Storefront API — products, categories, search | [→](https://anythingmcp.com/guides/shopware-6-to-mcp) |
| **Oxomi** | Baustoff catalog &amp; media portal (datasheets, CAD, safety sheets) | [→](https://anythingmcp.com/guides/oxomi-to-mcp) |
| **ImmobilienScout24** | German real-estate listings | [→](https://anythingmcp.com/guides/immobilienscout24-to-mcp) |
| **Mercado Libre** 🌎 | LATAM marketplace (BR, AR, MX, CL, CO, PE, UY) | [→](https://anythingmcp.com/guides/mercado-libre-to-mcp) |

#### 👥 HR &amp; field service

| Connector | Description | Guide |
|---|---|---|
| **Personio** | Dominant HR platform for DACH SMBs | [→](https://anythingmcp.com/guides/personio-to-mcp) |
| **Kenjo HR** | Modern HR platform — employees, departments, recruiting | [→](https://anythingmcp.com/guides/kenjo-to-mcp) |
| **MFR Mobile Field Report** | Field-service operations — work orders, technicians, time tracking | [→](https://anythingmcp.com/guides/mfr-fieldservice-to-mcp) |

#### 🏛️ Government &amp; public data

| Connector | Description | Guide |
|---|---|---|
| **VIES VAT Validation** | Validate EU VAT numbers — official European Commission API | [→](https://anythingmcp.com/guides/vies-vat-to-mcp) |
| **Handelsregister** | German commercial register — companies, shareholders, documents | [→](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| **UK Companies House** 🇬🇧 | UK companies register — search, profiles, officers, filings | [→](https://anythingmcp.com/guides/uk-companies-house-to-mcp) |
| **OpenPLZ Germany** | Postal codes, localities, streets, federal districts (BKG data) | [→](https://anythingmcp.com/guides/openplz-to-mcp) |
| **Bundesbank Statistics** | Exchange rates, monetary, financial markets | [→](https://anythingmcp.com/guides/bundesbank-to-mcp) |
| **DESTATIS Genesis** | Federal Statistical Office — demographics, economy, trade | [→](https://anythingmcp.com/guides/destatis-genesis-to-mcp) |
| **NINA Warnung** | Official German emergency alerts — weather, civil protection | [→](https://anythingmcp.com/guides/nina-warnung-to-mcp) |

#### 🏦 Banking, payments &amp; remote

| Connector | Description | Guide |
|---|---|---|
| **N26 Open Banking** | PSD2 access — balances, transactions, payment initiation | [→](https://anythingmcp.com/guides/n26-openbanking-to-mcp) |
| **Wise** 🇬🇧 | International money transfers (sandbox available) | [→](https://anythingmcp.com/guides/wise-to-mcp) |
| **PAYONE** | Payment processing — transactions, refunds, status | [→](https://anythingmcp.com/guides/payone-to-mcp) |
| **Razorpay** 🇮🇳 | India's leading payment gateway — UPI, cards, netbanking | [→](https://anythingmcp.com/guides/razorpay-to-mcp) |
| **Paystack** 🇳🇬 | Leading African payment processor (NG, GH, ZA, KE) | [→](https://anythingmcp.com/guides/paystack-to-mcp) |
| **TeamViewer** | Remote-access devices, sessions, users | [→](https://anythingmcp.com/guides/teamviewer-to-mcp) |

#### 🏗️ Construction &amp; mapping

| Connector | Description | Guide |
|---|---|---|
| **PlanRadar** | Construction &amp; real-estate project management | [→](https://anythingmcp.com/guides/planradar-to-mcp) |
| **HERE Geocoding** | Worldwide geocoding, autocomplete, place discovery | [→](https://anythingmcp.com/guides/here-geocoding-to-mcp) |

#### 💬 Messaging &amp; communication

| Connector | Description | Guide |
|---|---|---|
| **LINE Messaging API** 🇯🇵 | Dominant chat platform in JP/TW/TH — push, reply and broadcast | [→](https://anythingmcp.com/guides/line-messaging-to-mcp) |

</details>

**Want to add your own?** Drop a JSON adapter in `packages/backend/src/adapters/` (organised by region — e.g. `de/`), register it in `catalog.ts`, and it becomes available to every user. The `catalog.spec.ts` parametrised test validates every adapter at build time. See the existing adapters and the [Tool Definition Format](docs/tool-definition.md) for the expected schema.

> 👀 **Don't see your favourite SaaS?** [Open a discussion](https://github.com/HelpCode-ai/anythingmcp/discussions/categories/ideas) — we prioritise the next adapter by community demand. ⭐ Star and 👀 Watch to be notified when it ships.

---

## Quick Start

```bash
git clone https://github.com/HelpCode-ai/anythingmcp.git
cd anythingmcp
./setup.sh        # interactive setup — generates .env, starts Docker
```

The setup script configures everything interactively: deployment mode, domain/SSL, auth, email, Redis. All secrets are auto-generated. First user to register becomes Admin.

**What `setup.sh` handles**

- **Domain &amp; HTTPS** — for production domains, enables Caddy reverse proxy with automatic Let's Encrypt SSL
- **Secrets** — generates JWT, encryption keys, and database passwords
- **MCP authentication mode** — OAuth 2.0, API Key, or both
- **Optional** — SMTP and Redis configuration

> **Prefer manual setup?** Copy `.env.example` to `.env`, edit the values, and run `docker compose up -d`. See the [Deployment Guide](docs/deployment.md).

| Service | Default URL |
|---|---|
| Web UI | `http://localhost:3000` (or `https://yourdomain.com` with Caddy) |
| Backend API | `http://localhost:4000` |
| MCP endpoint | `http://localhost:4000/mcp` |
| Swagger docs | `http://localhost:4000/api/docs` |

> **Next** — create a connector, import your API spec, and connect your AI client. See [Connector guides](#connector-guides) below.

---

## Connect your AI client

AnythingMCP works with any MCP-compatible client. Pick yours:

| Client | Guide | Transport |
|---|---|---|
| **Claude Desktop** | [Setup →](docs/integrations/claude.md) | Streamable HTTP |
| **Claude Code** | [Setup →](docs/integrations/claude.md#claude-code) | Streamable HTTP |
| **ChatGPT** | [Setup →](docs/integrations/chatgpt.md) | Streamable HTTP |
| **Google Gemini** | [Setup →](docs/integrations/gemini.md) | HTTP / SSE |
| **GitHub Copilot** | [Setup →](docs/integrations/copilot.md) | Streamable HTTP |
| **Cursor** | [Setup →](docs/integrations/claude.md#cursor) | Streamable HTTP |
| **Any MCP client** | [Setup →](docs/integrations/claude.md#any-mcp-client) | Streamable HTTP |

---

## Connector guides

| Connector | Use case | Docs |
|---|---|---|
| **REST** | HTTP APIs, OpenAPI/Swagger, Postman | [Guide →](docs/connectors/rest.md) |
| **SOAP** | WSDL web services, WCF, legacy enterprise APIs | [Guide →](docs/connectors/soap.md) |
| **GraphQL** | GraphQL endpoints with introspection | [Guide →](docs/connectors/graphql.md) |
| **Database** | PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite | [Guide →](docs/connectors/database.md) |
| **MCP Bridge** | Aggregate multiple MCP servers into one | [Guide →](docs/connectors/mcp-bridge.md) |
| **LOGIN_TOKEN auth** | APIs that POST credentials → return long-lived bearer (bcrypt-salted handshakes, Sorare-style) | [Guide →](docs/connectors/login-token-auth.md) |

### Featured adapter walkthroughs

- 🎮 **Sorare Fantasy Football** — [Sorare → MCP](docs/guides/sorare-to-mcp.md) · [Connect Sorare to Claude](docs/guides/connect-sorare-to-claude.md) · [Connect Sorare to ChatGPT](docs/guides/connect-sorare-to-chatgpt.md) · [Connect Sorare to GitHub Copilot](docs/guides/connect-sorare-to-copilot.md) · [Connect Sorare to OpenClaw](docs/guides/connect-sorare-to-openclaw.md) · [Connect Sorare to AnythingMCP Cloud](docs/guides/connect-sorare-to-cloud.md)

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.png" alt="AnythingMCP architecture — your systems on the left connect through the AnythingMCP gateway to your AI clients on the right" width="100%" />
</p>

**How it works**

1. **Create a connector** — point to your API (REST base URL, WSDL endpoint, GraphQL URL, DB connection string) or pick a pre-built adapter from the catalog
2. **Import or define tools** — auto-import from OpenAPI / Postman / WSDL / GraphQL or define manually (pre-built adapters skip this step)
3. **Connect AI clients** — point your MCP client to `http://your-server:4000/mcp`
4. **AI calls tools** — AnythingMCP translates MCP tool calls into actual API requests and returns results

---

## FAQ

<details>
<summary><strong>What is an MCP server?</strong></summary>

An MCP server exposes tools to an AI agent over the [Model Context Protocol](https://modelcontextprotocol.io/) — an open standard from Anthropic. Once connected, the AI can call those tools to read data, run queries, or perform actions on your behalf. AnythingMCP is a self-hosted MCP server that wraps your existing APIs so you don't have to write one from scratch.
</details>

<details>
<summary><strong>How is AnythingMCP different from writing my own MCP server?</strong></summary>

You don't write code. AnythingMCP imports your OpenAPI / Postman / WSDL spec (or you point it at a database) and generates the MCP tools automatically. You also get auth, audit logging, RBAC, and a visual editor on top — features that would take weeks to build per service.
</details>

<details>
<summary><strong>Can I use it with Claude / ChatGPT / Gemini / Copilot / Cursor?</strong></summary>

Yes. Any client that speaks MCP works. See [Connect your AI client](#connect-your-ai-client) for direct setup guides.
</details>

<details>
<summary><strong>Is AnythingMCP really open source?</strong></summary>

Yes. AnythingMCP is licensed under the [GNU AGPL v3](LICENSE), an OSI-approved open-source license — the same model as Twenty, Cal.com, Grafana and Plausible. You can read, fork, modify, self-host and even offer it as a service; the AGPL's network copyleft simply requires that modifications to the software stay open. The only exception is code under `ee/` directories (cloud-operator features like onboarding emails), which is commercially licensed and not needed for self-hosting. See the [License FAQ](docs/license-faq.md).
</details>

<details>
<summary><strong>Is AnythingMCP free?</strong></summary>

Yes. AnythingMCP is free software under the AGPL v3 — free for internal company use, personal use, development, testing, evaluation and academic use. If you modify it and run it as a network service for others, the AGPL requires you to make your modified source available to those users. For commercial licensing without copyleft obligations: [licensing@helpcode.ai](mailto:licensing@helpcode.ai).
</details>

<details>
<summary><strong>Can I self-host?</strong></summary>

Yes — it ships as a Docker image and runs on your own infrastructure. Run `./setup.sh` or use the [Railway](https://railway.com/deploy/8-X4WD?referralCode=k30bPV) and [DigitalOcean](https://marketplace.digitalocean.com/apps/anythingmcp) one-click installs. There's also a managed [Cloud version](https://cloud.anythingmcp.com) if you'd rather not run it yourself.
</details>

<details>
<summary><strong>Is there an MCP server for DHL / DATEV / Personio / Handelsregister / …?</strong></summary>

Yes — see [Pre-configured MCP connectors](#pre-configured-mcp-connectors). Each adapter has its own setup guide on [anythingmcp.com](https://anythingmcp.com/guides). If your service isn't there yet, you can add it in ~10 minutes by copying an existing JSON adapter and adapting the endpoints.
</details>

<details>
<summary><strong>What about SOAP and WSDL?</strong></summary>

Built-in. AnythingMCP automatically parses WSDL documents and generates one MCP tool per SOAP operation. Useful for legacy enterprise APIs (SAP, Oracle, .NET WCF, banking middleware) that no AI client speaks natively.
</details>

<details>
<summary><strong>Is MCP dead now that agents use CLI tools?</strong></summary>

No — but the question conflates two problems. CLI is the right call when the model already knows the tool from training (`git`, `docker`, `kubectl`, `aws`, `gh`), the agent is acting for the builder, and a CLI actually exists. MCP wins when you need per-user auth, scoped permissions, audit logs, multi-tenant isolation, typed contracts, or SaaS integrations without a CLI (Salesforce, Workday, Notion, Linear, internal tools).

The mature pattern in 2026 is **hybrid**: CLI for local/dev/popular tools, MCP for SaaS / multi-tenant / compliance-bound integrations. AnythingMCP covers the MCP side — you keep using `git` and `docker` directly, the gateway handles everything else with proper auth and audit. Full decision matrix on [anythingmcp.com/vs/cli](https://anythingmcp.com/vs/cli).
</details>

<details>
<summary><strong>Can the AI access my production database directly?</strong></summary>

Yes, with safety. PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB and SQLite are supported. Each tool is whitelisted, every invocation is audit-logged, and you can scope a connector to read-only credentials. See the [Database Connector Guide](docs/connectors/database.md).
</details>

<details>
<summary><strong>How is auth handled?</strong></summary>

OAuth2 (PKCE + Client Credentials), Bearer Token, API Key, Basic Auth, query-parameter auth, WS-Security and TLS client certificates are all supported. Credentials are stored AES-256-GCM encrypted at rest. Per-user MCP API keys are issued on top so each AI client gets its own key with usage tracking.
</details>

---

## Documentation

| Topic | Description |
|---|---|
| [API reference](docs/api-reference.md) | Full REST API for connectors, tools, auth, audit |
| [Tool definition format](docs/tool-definition.md) | Parameters, endpoint mapping, response mapping |
| [Deployment guide](docs/deployment.md) | Docker, production setup, reverse proxy, env vars |
| [Authentication](docs/deployment.md#authentication) | OAuth2, JWT, API keys, MCP auth modes |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4 |
| Backend | NestJS 11, TypeScript |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP |
| Database | PostgreSQL 17, Prisma 7 |
| Cache | Redis 7 (optional) |
| Reverse proxy | Caddy 2 (optional — automatic HTTPS via Let's Encrypt) |
| Auth | JWT, OAuth2, AES-256-GCM |
| Deploy | Docker + Docker Compose |

### Local development

```bash
./setup.sh    # choose "Local development"
npm run dev
```

Or see the [Deployment guide](docs/deployment.md#local-development) for manual setup.

---

## Community &amp; support

- 💬 **Questions &amp; discussions** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions) — vote on the next adapter, share what you've built, ask for help
- 🐛 **Bug reports** — [Open an issue](https://github.com/HelpCode-ai/anythingmcp/issues)
- 💡 **Feature requests** — [Request a feature](https://github.com/HelpCode-ai/anythingmcp/issues/new?labels=enhancement&template=feature_request.md)
- 🆘 **Need help?** — see [SUPPORT.md](SUPPORT.md) for the full list of channels
- 🏢 Built by [helpcode.ai](https://helpcode.ai) — an independent team in Freiburg, Germany

---

## Star history

<a href="https://www.star-history.com/#HelpCode-ai/anythingmcp&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" />
    <img alt="AnythingMCP star history chart" src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" />
  </picture>
</a>

> ⭐ **Like what you see?** [Star this repo](https://github.com/HelpCode-ai/anythingmcp/stargazers) — every star helps another developer discover AnythingMCP.

---

## Contributing

We welcome contributions! Please read our [Contributing guide](CONTRIBUTING.md) before submitting a PR. For security issues, see [SECURITY.md](SECURITY.md).

---

## License

AnythingMCP is **open source** under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only) — see the [License FAQ](docs/license-faq.md) for a plain-language explanation.

- ✅ **Free for** — internal use, personal use, development, testing, evaluation, academic use, self-hosting
- 🔄 **Copyleft** — if you modify AnythingMCP and offer it over a network, you must share your modified source with those users
- 🏢 **`ee/` directories** — cloud-operator code under `ee/` is licensed under the [AnythingMCP Commercial License](packages/backend/src/ee/LICENSE) and is not required for self-hosting

Releases published before the AGPL adoption remain under the Business Source License 1.1 (converting to Apache 2.0 on 2030-03-04). For commercial licensing: [licensing@helpcode.ai](mailto:licensing@helpcode.ai)

> **Transparency note** — AnythingMCP makes optional network calls to `anythingmcp.com` for license verification and email delivery when SMTP is not configured. No API credentials or tool invocation data is ever sent. See [External services](docs/deployment.md#external-services) for full details.

Copyright © 2026 helpcode.ai GmbH
