# Odoo MCP Server

**Connect Odoo to Claude, ChatGPT and Copilot: partners, sales orders, invoices, products and any other model as MCP tools.** Powered by [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp).

Odoo MCP Server gives Claude, ChatGPT, Copilot and Cursor 11 tools for Odoo: partners, sales orders, invoices, products and any other model. 8 tools read and 3 can change data. It runs on AnythingMCP: one click on AnythingMCP Cloud, or self-hosted with Docker. Credentials are stored encrypted and every call is audited.

**Status:** not yet verified against a live system. The adapter follows the vendor's API documentation; please report what you find.  
**Adapter synced:** <!-- synced -->2026-09-26

Maintained by [@keysersoft](https://github.com/keysersoft), an AnythingMCP maintainer. Built on [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp) by helpcode.ai.

## Quick start (AnythingMCP Cloud)

1. Sign in at [cloud.anythingmcp.com](https://cloud.anythingmcp.com) and open the [install link](https://cloud.anythingmcp.com/connectors/store?install=odoo).
2. Enter `ODOO_URL`, `ODOO_DB`, `ODOO_API_KEY` (see [Authentication](#authentication)).
3. Copy the URL of your MCP server under **MCP Servers** and add it to your AI client ([below](#connect-claude-chatgpt-copilot-or-cursor)).

AnythingMCP Cloud is the same open-source code, operated by helpcode.ai in Frankfurt, Germany.

## Self-hosted (Docker)

Needs Docker 24+, openssl and Node 18+.

```bash
git clone https://github.com/keysersoft/odoo-mcp-server.git
cd odoo-mcp-server
./scripts/install.sh
```

`install.sh` writes `.env` with fresh secrets, starts AnythingMCP, creates the first admin, installs the connector if `ODOO_URL` and `ODOO_DB` and `ODOO_API_KEY` are set in `.env` and creates an MCP API key. Without credentials it prints the install link instead: `http://localhost:3000/connectors/store?install=odoo`. Then check the whole chain:

```bash
npm install && node scripts/smoke.mjs
```

## Connect Claude, ChatGPT, Copilot or Cursor

- **Claude (claude.ai, Desktop, mobile):** *Customize → Connectors → Add custom connector*, paste your MCP server URL and sign in. Claude connects from Anthropic's cloud, so the URL must be public HTTPS: your AnythingMCP Cloud URL, or your own instance behind TLS.
- **Claude Code:**

  ```bash
  claude mcp add --transport http odoo-mcp-server http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"
  ```
- **Cursor** (`.cursor/mcp.json`) and **VS Code / GitHub Copilot** (`.vscode/mcp.json`, key `servers` instead of `mcpServers`, plus `"type": "http"`):

  ```json
  { "mcpServers": { "odoo-mcp-server": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }
  ```
- **ChatGPT:** add the public HTTPS URL as a connector (app) in ChatGPT's settings. A `localhost` URL does not work there.

## Tools

11 tools, generated from [`adapter/odoo.json`](adapter/odoo.json). **read** tools cannot change anything in the source system.

<!-- tools:start (generated from adapter/*.json, do not edit) -->
| Tool | What it does | Access |
|---|---|---|
| `odoo_search_read` | Search and read any Odoo model in one call. | read |
| `odoo_read` | Read specific records of a model by their ids — the follow-up call when a search has returned ids and you now want the detail of a few of them. | read |
| `odoo_search_count` | Count the records of a model matching a domain, without transferring them. | read |
| `odoo_fields_get` | Describe a model's fields: name, type, label, whether it is required or readonly, and the related model for relational fields. | read |
| `odoo_list_partners` | List partners — Odoo's customers, suppliers and contacts — with name, e-mail, phone, city and country. | read |
| `odoo_list_sale_orders` | List sales orders with their customer, date, state and total. | read |
| `odoo_list_invoices` | List customer invoices and vendor bills with their partner, date, due date, state and residual amount — the answer to 'what is still unpaid'. | read |
| `odoo_list_products` | List products with their internal reference, sale price, cost, on-hand quantity and product type. | read |
| `odoo_create` | Create a record in any Odoo model. | write |
| `odoo_write` | Update existing records in any Odoo model. | write |
| `odoo_call_method` | Call an arbitrary public method on an Odoo model — the escape hatch for workflow actions such as action_confirm on a sale order or action_post on an invoice. | write |
<!-- tools:end -->

## Example prompts

- Which confirmed sales orders over 10,000 EUR were created this month?
- List the customer invoices that are overdue, with the residual amount per partner.
- Which vendor bills are due in the next 14 days?
- What is the on-hand quantity and cost of product FURN_8220?
- How many open CRM leads do we have per salesperson?
- Show the fields of the `stock.picking` model so we can query deliveries.

More in [examples/prompts.md](examples/prompts.md).

## Authentication

**Getting an API key**
1. In Odoo open your user menu → **My Profile → Account Security** and create a new **API key**. Odoo shows it once.
2. Put it in `ODOO_API_KEY`, your instance URL in `ODOO_URL` (e.g. `https://mycompany.odoo.com`, no trailing slash) and the database name in `ODOO_DB`. On Odoo Online the database name is usually the subdomain.

**This adapter uses the JSON-2 API**, which Odoo introduced in 19 and which is the only Odoo HTTP surface a generic REST engine can speak: `POST {url}/json/2/{model}/{method}` with the key as a bearer token and the database in an `X-Odoo-Database` header. On **Odoo 18 and older** that route does not exist — those versions only offer XML-RPC and the older `/jsonrpc` endpoint, neither of which this connector can call. For an older instance, build a custom connector against `/jsonrpc` (POST, `{"jsonrpc":"2.0","method":"call","params":{"service":"object","method":"execute_kw","args":[db, uid, key, model, method, args]}}`) or install the OCA REST API module.

**Domains are Odoo's query language.** A domain is a list of triples: `[["state","=","sale"],["amount_total",">",1000]]`, implicitly AND-ed. `|` and `!` prefix operators express OR and NOT. `odoo_search_read` takes one verbatim, which is what makes this connector able to answer questions the purpose-built tools do not cover.

**Always pass `fields`.** Odoo models have hundreds of columns and omitting `fields` returns all of them, which will exhaust the agent's context on a handful of rows. Start with `odoo_fields_get` to see what exists.

**Permissions follow the user.** The API key inherits its owner's access rights and record rules. A restricted user sees fewer rows, not an error — so an agent reporting 'no open orders' may simply be looking through the wrong account.

**Self-hosted, which is the thing to plan for.**
- On **AnythingMCP Cloud** the instance must be reachable from the public internet on a real hostname with a valid TLS certificate. A self-signed certificate will fail: the connector offers no trust-anything switch.
- On an internal host (`odoo.intern`, `10.0.0.x`), self-host AnythingMCP on the same network and add that host to `SSRF_ALLOWED_HOSTS`, or the outbound guard refuses the call before it is made.

**Writes**: `odoo_create` and `odoo_write` change the live database, and Odoo's automations (mail, stock moves, accounting entries) fire as if a person had done it.

## Security

- **Read or write is your choice.** 8 of the tools only read; `odoo_create`, `odoo_write`, `odoo_call_method` can change data. Assign the connector to an MCP server whose role whitelists only the tools you want, and the rest are invisible to that client.
- **Credentials** are encrypted with AES-256-GCM and never shown to the model.
- **Response mapping** drops or reshapes fields per tool before they reach the model, e.g. bank details or personal data.
- **Audit log:** every call is recorded with input, output, duration and status, in your own database when self-hosted.
- **SSO, RBAC and SCIM** are included in the self-hosted build.

## FAQ

### Is there an Odoo MCP server that works with Odoo Online?
Yes. This one talks to Odoo's JSON-2 API, which Odoo Online, Odoo.sh and self-hosted Odoo 19 and newer all expose. Odoo 18 and older do not have that API; see Troubleshooting.

### How do I connect Odoo to Claude?
Create an API key in Odoo (**My Profile → Account Security → New API Key**), install the connector with your URL, database and key, and add your MCP server URL to Claude as a custom connector. Claude Code and Cursor take the local URL with an API key header.

### Which Odoo models can the AI use?
Any model the API key's user can access. `odoo_search_read`, `odoo_read`, `odoo_search_count` and `odoo_fields_get` work on every model (CRM, sales, purchase, inventory, accounting, projects…); four convenience tools cover partners, sales orders, invoices and products.

### Can the AI change data in Odoo?
Yes, if you let it: `odoo_create`, `odoo_write` and `odoo_call_method` write to the live database and trigger Odoo's automations. To start read-only, give the AI a role that whitelists only the read tools, and create the API key with a user whose access rights are limited.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Why does the AI say there are no records when I know there are?
The API key inherits its owner's access rights and record rules. A restricted user sees fewer rows rather than an error, so check which user created the key.

## Troubleshooting

| Problem | Fix |
|---|---|
| `401` / `403` from the vendor | The credentials are wrong or lack rights. Re-enter them on the connector page; the import runs a test call and shows the result. |
| Tools missing in the AI client | The connector is not assigned to the MCP server the client uses. Check **MCP Servers**, then run `node scripts/smoke.mjs`. |
| The host is on your internal network | Self-host AnythingMCP on that network and add the hostname to `SSRF_ALLOWED_HOSTS`, or the outbound guard blocks the call. |
| Works locally, fails on AnythingMCP Cloud | The system must be reachable from the internet with a valid TLS certificate. |
| `404` on every call | The instance is Odoo 18 or older, which has no JSON-2 API (`/json/2`). Upgrade to 19+, or build a custom connector against `/jsonrpc`. |
| The AI finds no records you know exist | The API key's user lacks access rights or record rules hide the rows. Check which user created the key. |
| Answers are cut off or the model loses track | A `search_read` without `fields` returns every column. Ask for specific fields, or run `odoo_fields_get` first. |

## Related

- [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server): ERP MCP server: connect 16 ERPs (SAP, Odoo, JTL-Wawi, Xentral, weclapp, ERPNext…) to Claude & ChatGPT. Self-hosted or cloud.
- [erpnext-mcp-server](https://github.com/keysersoft/erpnext-mcp-server): ERPNext MCP server: connect ERPNext/Frappe to Claude & ChatGPT. Read and write any DocType: customers, orders, invoices, stock.
- [dolibarr-mcp-server](https://github.com/keysersoft/dolibarr-mcp-server): Dolibarr MCP server: connect Dolibarr ERP & CRM to Claude & ChatGPT. Third parties, invoices, orders, proposals and stock.
- [sap-business-one-mcp-server](https://github.com/HelpCode-ai/sap-business-one-mcp-server): SAP Business One MCP server: Claude & ChatGPT read partners, items, orders, invoices and quotations, and create sales orders.
- [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp): the open-source MCP server and gateway this repository is built on.

## License

Not decided yet.
