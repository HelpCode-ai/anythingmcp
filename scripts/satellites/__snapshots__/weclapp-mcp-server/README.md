# weclapp MCP Server

**English** · [Deutsch](docs/README.de.md)

**Connect weclapp to Claude, ChatGPT and Copilot: customers, sales orders, invoices, articles, quotations and opportunities as MCP tools.** Powered by [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp).

weclapp MCP Server gives Claude, ChatGPT, Copilot and Cursor 11 tools for weclapp: customers, sales orders, invoices, articles, quotations and opportunities. Every tool only reads. It runs on AnythingMCP: one click on AnythingMCP Cloud, or self-hosted with Docker. Credentials are stored encrypted and every call is audited.

**Last verified:** 2026-09-26 against the weclapp REST API v2 (production traffic on AnythingMCP Cloud: more than 1,000 successful tool calls in the last 90 days).  
**Adapter synced:** <!-- synced -->2026-09-26

Maintained by [KOCH Freiburg GmbH](https://www.kochfreiburg.de/), which runs AnythingMCP in production. Built on [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp) by helpcode.ai.

## Quick start (AnythingMCP Cloud)

1. Sign in at [cloud.anythingmcp.com](https://cloud.anythingmcp.com) and open the [install link](https://cloud.anythingmcp.com/connectors/store?install=weclapp).
2. Enter `WECLAPP_TENANT`, `WECLAPP_API_TOKEN` (see [Authentication](#authentication)).
3. Copy the URL of your MCP server under **MCP Servers** and add it to your AI client ([below](#connect-claude-chatgpt-copilot-or-cursor)).

AnythingMCP Cloud is the same open-source code, operated by helpcode.ai in Frankfurt, Germany.

## Self-hosted (Docker)

Needs Docker 24+, openssl and Node 18+.

```bash
git clone https://github.com/kochfreiburg/weclapp-mcp-server.git
cd weclapp-mcp-server
./scripts/install.sh
```

`install.sh` writes `.env` with fresh secrets, starts AnythingMCP, creates the first admin, installs the connector if `WECLAPP_TENANT` and `WECLAPP_API_TOKEN` are set in `.env` and creates an MCP API key. Without credentials it prints the install link instead: `http://localhost:3000/connectors/store?install=weclapp`. Then check the whole chain:

```bash
npm install && node scripts/smoke.mjs
```

## Connect Claude, ChatGPT, Copilot or Cursor

- **Claude (claude.ai, Desktop, mobile):** *Customize → Connectors → Add custom connector*, paste your MCP server URL and sign in. Claude connects from Anthropic's cloud, so the URL must be public HTTPS: your AnythingMCP Cloud URL, or your own instance behind TLS.
- **Claude Code:**

  ```bash
  claude mcp add --transport http weclapp-mcp-server http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"
  ```
- **Cursor** (`.cursor/mcp.json`) and **VS Code / GitHub Copilot** (`.vscode/mcp.json`, key `servers` instead of `mcpServers`, plus `"type": "http"`):

  ```json
  { "mcpServers": { "weclapp-mcp-server": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }
  ```
- **ChatGPT:** add the public HTTPS URL as a connector (app) in ChatGPT's settings. A `localhost` URL does not work there.

## Tools

11 tools, generated from [`adapter/weclapp.json`](adapter/weclapp.json). **read** tools cannot change anything in the source system.

<!-- tools:start (generated from adapter/*.json, do not edit) -->
| Tool | What it does | Access |
|---|---|---|
| `weclapp_list_customers` | List parties (customers/suppliers/contacts) from weclapp ERP. | read |
| `weclapp_get_customer` | Get a specific party (customer/supplier/contact) by ID. | read |
| `weclapp_list_sales_orders` | List sales orders from weclapp ERP. | read |
| `weclapp_list_invoices` | List sales invoices from weclapp ERP. | read |
| `weclapp_list_articles` | List articles (products) from weclapp ERP. | read |
| `weclapp_get_article` | Get a specific article (product) by ID, including stock, pricing, and warehouse data. | read |
| `weclapp_list_quotations` | List sales quotations (Angebote) from weclapp ERP. | read |
| `weclapp_get_quotation` | Get a single sales quotation (Angebot) by ID, including positions, amounts and status. | read |
| `weclapp_list_recurring_invoices` | List recurring invoices (wiederkehrende Rechnungen / Abo-Rechnungen) from weclapp ERP — the templates that periodically generate sales invoices. | read |
| `weclapp_get_recurring_invoice` | Get a single recurring invoice (wiederkehrende Rechnung) by ID, including its interval, next execution date and template positions. | read |
| `weclapp_list_opportunities` | List sales opportunities (Verkaufschancen) from weclapp CRM. | read |
<!-- tools:end -->

## Example prompts

- Which customers have sales orders over 5,000 EUR that are still open?
- Show the last five invoices for Müller GmbH and whether they are paid.
- Which invoices are overdue, and by how many days?
- List the quotations we sent this month that the customer has not accepted yet.
- What is the stock of article 10045, and what does it cost?
- Which articles are running low on stock?

More in [examples/prompts.md](examples/prompts.md).

## Authentication

The connector needs two values:

| Variable | Where to find it |
|---|---|
| `WECLAPP_TENANT` | The subdomain of your weclapp URL: `yourcompany` in `yourcompany.weclapp.com` |
| `WECLAPP_API_TOKEN` | weclapp → **My Settings → API Tokens** → generate a token |

The token is sent as the `AuthenticationToken` header to `https://<tenant>.weclapp.com/webapp/api/v2`. It acts with the rights of the weclapp user who created it, so create it with a user that sees only the data the AI should see.

## Security

- **Read or write is your choice.** All 11 tools only read. Assign the connector to an MCP server whose role whitelists only the tools you want, and the rest are invisible to that client.
- **Credentials** are encrypted with AES-256-GCM and never shown to the model.
- **Response mapping** drops or reshapes fields per tool before they reach the model, e.g. bank details or personal data.
- **Audit log:** every call is recorded with input, output, duration and status, in your own database when self-hosted.
- **SSO, RBAC and SCIM** are included in the self-hosted build.

## FAQ

### Is there a weclapp MCP server?
Yes, this one. It exposes weclapp's REST API v2 as 11 MCP tools (parties, sales orders, invoices, articles, quotations, recurring invoices and opportunities) through AnythingMCP, on AnythingMCP Cloud or on your own Docker host.

### How do I connect weclapp to Claude?
Install the connector (one click on AnythingMCP Cloud, or `./scripts/install.sh`), paste your tenant and API token, then add your MCP server URL to Claude as a custom connector. Claude Code and Cursor take the local URL with an API key header.

### Where do I find the weclapp API token?
In weclapp, open **My Settings → API Tokens** and generate a token. The tenant is the subdomain of your weclapp URL: `yourcompany` in `yourcompany.weclapp.com`.

### Can the AI change data in weclapp?
Not with this connector: all 11 tools are HTTP GET requests, so Claude can read but cannot create or change records. The token still carries the rights of the weclapp user who created it, so use a user that sees only what the AI should see.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (as an app or connector, which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Does weclapp data leave my infrastructure?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use. Response mapping lets you drop fields, such as bank details, before they reach the model.

## Troubleshooting

| Problem | Fix |
|---|---|
| `401` / `403` from the vendor | The credentials are wrong or lack rights. Re-enter them on the connector page; the import runs a test call and shows the result. |
| Tools missing in the AI client | The connector is not assigned to the MCP server the client uses. Check **MCP Servers**, then run `node scripts/smoke.mjs`. |
| The host is on your internal network | Self-host AnythingMCP on that network and add the hostname to `SSRF_ALLOWED_HOSTS`, or the outbound guard blocks the call. |
| Works locally, fails on AnythingMCP Cloud | The system must be reachable from the internet with a valid TLS certificate. |
| Every call fails and the URL shows `.weclapp.com.weclapp.com` | `WECLAPP_TENANT` is only the subdomain: `acme`, not `acme.weclapp.com` or the full URL. |
| `401` with a token that works in the browser | The token must be an API token from **My Settings → API Tokens**, not your password or a session cookie. |

## Related

- [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server): ERP MCP server: connect 16 ERPs (SAP, Odoo, JTL-Wawi, Xentral, weclapp, ERPNext…) to Claude & ChatGPT. Self-hosted or cloud.
- [xentral-mcp-server](https://github.com/kochfreiburg/xentral-mcp-server): Xentral MCP server: connect Xentral ERP to Claude & ChatGPT. Articles, customers, sales orders, invoices and stock as AI tools.
- [billbee-mcp-server](https://github.com/kochfreiburg/billbee-mcp-server): Billbee MCP server: connect Billbee order management to Claude & ChatGPT. Orders, products, customers and shipping providers.
- [sap-business-one-mcp-server](https://github.com/HelpCode-ai/sap-business-one-mcp-server): SAP Business One MCP server: Claude & ChatGPT read partners, items, orders, invoices and quotations, and create sales orders.
- [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp): the open-source MCP server and gateway this repository is built on.

## License

Not decided yet.
