# AnythingMCP — Client setup, connector types & FAQ

Guides for connecting AI clients to AnythingMCP, the connector types you can build, and frequently asked questions. New here? Start with the [README](../README.md) and [Get started in 60 seconds](../README.md#get-started-in-60-seconds).

Per-adapter setup guides (English, German, Italian and more) live at **[anythingmcp.com/guides](https://anythingmcp.com/guides)**.

---

## Connect your AI client

| Client | Guide | Transport |
|---|---|---|
| **Claude Desktop / Claude Code** | [Setup →](integrations/claude.md) | Streamable HTTP |
| **ChatGPT** | [Setup →](integrations/chatgpt.md) | Streamable HTTP |
| **Google Gemini** | [Setup →](integrations/gemini.md) | HTTP / SSE |
| **GitHub Copilot** | [Setup →](integrations/copilot.md) | Streamable HTTP |
| **Cursor** | [Setup →](integrations/claude.md#cursor) | Streamable HTTP |
| **Any MCP client** | [Setup →](integrations/claude.md#any-mcp-client) | Streamable HTTP |

---

## Connector guides

| Connector | Use case | Docs |
|---|---|---|
| **REST** | HTTP APIs, OpenAPI/Swagger, Postman | [Guide →](connectors/rest.md) |
| **SOAP** | WSDL web services, WCF, legacy enterprise APIs | [Guide →](connectors/soap.md) |
| **GraphQL** | GraphQL endpoints with introspection | [Guide →](connectors/graphql.md) |
| **Database** | PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite | [Guide →](connectors/database.md) |
| **MCP Bridge** | Aggregate multiple MCP servers into one | [Guide →](connectors/mcp-bridge.md) |
| **LOGIN_TOKEN auth** | APIs that POST credentials → return long-lived bearer | [Guide →](connectors/login-token-auth.md) |

---

## Documentation

| Topic | Description |
|---|---|
| [API reference](api-reference.md) | Full REST API for connectors, tools, auth, audit |
| [Tool definition format](tool-definition.md) | Parameters, endpoint mapping, response mapping |
| [Deployment guide](deployment.md) | Docker, production setup, reverse proxy, env vars |
| [Authentication](deployment.md#authentication) | OAuth2, JWT, API keys, MCP auth modes |
| [License FAQ](license-faq.md) | Plain-language AGPL explanation |

---

## FAQ

<details>
<summary><strong>How do I create a custom connector for Claude?</strong></summary>

Run AnythingMCP (self-hosted or [Cloud](https://cloud.anythingmcp.com)), import your API spec or pick a pre-built adapter, then add the gateway URL in Claude under *Settings → Connectors*. No code required — the [Claude guide](integrations/claude.md) walks through it in ~5 minutes.
</details>

<details>
<summary><strong>Can I build a ChatGPT app from my existing API?</strong></summary>

Yes. As of December 2025, OpenAI calls these **apps in ChatGPT** (the term now covers both interactive apps and data connectors), and they're built on MCP via the Apps SDK. AnythingMCP generates the MCP backend from your existing API — add it as an app/connector in ChatGPT, or use it as the tool layer of an Apps SDK app. See [Turn your API into a ChatGPT app](../README.md#turn-your-api-into-a-chatgpt-app).
</details>

<details>
<summary><strong>Do I need to know how to code?</strong></summary>

No. Importing an OpenAPI/Postman/WSDL spec, editing tools in the visual editor, and connecting Claude or ChatGPT are all point-and-click. Code only comes into play if you want to contribute a new adapter (a single JSON file) or self-host with custom infrastructure.
</details>

<details>
<summary><strong>What is an MCP server?</strong></summary>

An MCP server exposes tools to an AI agent over the [Model Context Protocol](https://modelcontextprotocol.io/) — an open standard from Anthropic. Once connected, the AI can call those tools to read data, run queries, or perform actions on your behalf. AnythingMCP is a self-hosted MCP server that wraps your existing APIs so you don't have to write one from scratch.
</details>

<details>
<summary><strong>How is AnythingMCP different from writing my own MCP server?</strong></summary>

You don't write code. AnythingMCP imports your OpenAPI / Postman / WSDL spec (or you point it at a database) and generates the MCP tools automatically. You also get auth, audit logging, RBAC, and a visual editor on top — features that would take weeks to build per service.
</details>

<details>
<summary><strong>Is AnythingMCP really open source?</strong></summary>

Yes. AnythingMCP is licensed under the [GNU AGPL v3](../LICENSE), an OSI-approved open-source license — the same model as Twenty, Cal.com, Grafana and Plausible. You can read, fork, modify, self-host and even offer it as a service; the AGPL's network copyleft simply requires that modifications to the software stay open. The only exception is code under `ee/` directories (cloud-operator features), which is commercially licensed and not needed for self-hosting. See the [License FAQ](license-faq.md).
</details>

<details>
<summary><strong>Is AnythingMCP free?</strong></summary>

Yes. AnythingMCP is free software under the AGPL v3 — free for internal company use, personal use, development, testing, evaluation and academic use. If you modify it and run it as a network service for others, the AGPL requires you to make your modified source available to those users. For commercial licensing without copyleft obligations: [info@helpcode.ai](mailto:info@helpcode.ai).
</details>

<details>
<summary><strong>Can I self-host?</strong></summary>

Yes — it ships as a Docker image and runs on your own infrastructure. Run `./setup.sh` or use the [Railway](https://railway.com/deploy/8-X4WD?referralCode=k30bPV) and [DigitalOcean](https://marketplace.digitalocean.com/apps/anythingmcp) one-click installs. There's also a managed [Cloud version](https://cloud.anythingmcp.com) if you'd rather not run it yourself.
</details>

<details>
<summary><strong>What about SOAP and WSDL?</strong></summary>

Built-in. AnythingMCP automatically parses WSDL documents and generates one MCP tool per SOAP operation. Useful for legacy enterprise APIs (SAP, Oracle, .NET WCF, banking middleware) that no AI client speaks natively.
</details>

<details>
<summary><strong>Is MCP dead now that agents use CLI tools?</strong></summary>

No — but the question conflates two problems. CLI is the right call when the model already knows the tool from training (`git`, `docker`, `kubectl`), the agent is acting for the builder, and a CLI actually exists. MCP wins when you need per-user auth, scoped permissions, audit logs, multi-tenant isolation, or SaaS integrations without a CLI. The mature pattern in 2026 is **hybrid**: CLI for local/dev tools, MCP for SaaS / multi-tenant / compliance-bound integrations. Full decision matrix on [anythingmcp.com/vs/cli](https://anythingmcp.com/vs/cli).
</details>

<details>
<summary><strong>Can the AI access my production database directly?</strong></summary>

Yes, with safety. PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB and SQLite are supported. Each tool is whitelisted, every invocation is audit-logged, and you can scope a connector to read-only credentials. See the [Database Connector Guide](connectors/database.md).
</details>

<details>
<summary><strong>How is auth handled?</strong></summary>

OAuth2 (PKCE + Client Credentials), Bearer Token, API Key, Basic Auth, query-parameter auth, WS-Security and TLS client certificates are all supported. Credentials are stored AES-256-GCM encrypted at rest. Per-user MCP API keys are issued on top so each AI client gets its own key with usage tracking.
</details>
