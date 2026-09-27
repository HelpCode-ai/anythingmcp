# SOAP to MCP

**Turn any SOAP/WSDL web service into MCP tools for Claude, ChatGPT and Copilot.** Powered by [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp).

SOAP to MCP turns any SOAP/WSDL web service into MCP tools that Claude, ChatGPT, Copilot and Cursor can call, without code. Point AnythingMCP at a WSDL and every operation becomes a tool; it builds the envelopes and parses the replies. This repository runs the whole chain locally against a demo inventory service in five minutes.

**Last verified:** 2026-09-26 against the bundled demo SOAP service (examples/inventory.wsdl) (docker compose up + scripts/smoke.mjs).  
**Adapter synced:** <!-- synced -->2026-09-26

Maintained by [helpcode.ai](https://helpcode.ai), the team that builds and maintains [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp).

## Try it in five minutes

Needs Docker 24+, openssl and Node 18+.

```bash
git clone https://github.com/HelpCode-ai/soap-to-mcp.git
cd soap-to-mcp
./scripts/install.sh
npm install && node scripts/smoke.mjs
```

`install.sh` starts AnythingMCP and a small SOAP service ([`examples/soap-demo`](examples/soap-demo): a warehouse inventory with three operations), creates the first admin, creates a SOAP connector from the demo WSDL and an MCP API key. `smoke.mjs` then connects as an MCP client, lists the tools and calls one:

| WSDL operation | MCP tool | What it answers |
|---|---|---|
| `GetItem` | `inventoryservice_getitem` | One article by SKU: stock on hand, reorder level, price |
| `ListLowStock` | `inventoryservice_listlowstock` | Articles at or below their reorder level |
| `GetOrderStatus` | `inventoryservice_getorderstatus` | Status and promised date of a sales order |

Tool names are `<service>_<operation>` in lower case. Rename them and rewrite their descriptions in the visual editor so the model picks the right one; the WSDL only gives it the operation name.

## Use your own SOAP service

1. Open **Connectors → New connector → SOAP** in the AnythingMCP UI (`http://localhost:3000`, or [AnythingMCP Cloud](https://cloud.anythingmcp.com) for a service reachable from the internet).
2. Set the base URL to the service endpoint and import the WSDL (`https://…/Service.svc?wsdl`). Every operation becomes a tool.
3. Pick the auth: HTTP Basic, a bearer token or an API-key header. WS-Security SOAP headers and TLS client certificates are not implemented yet.
4. Assign the connector to an MCP server, ideally with a role that whitelists only the read operations.

The same through the API:

```bash
curl -s http://localhost:4000/api/connectors -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"CRM","type":"SOAP","baseUrl":"https://crm.example.com/CustomerService.svc"}'
curl -s http://localhost:4000/api/connectors/$ID/import -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"source":"wsdl","url":"https://crm.example.com/CustomerService.svc?wsdl"}'
```

A service on your internal network needs a self-hosted AnythingMCP that can reach it, with its hostname in `SSRF_ALLOWED_HOSTS` (the [`docker-compose.yml`](docker-compose.yml) here does that for `soap-demo`).

## Connect Claude, ChatGPT, Copilot or Cursor

- **Claude (claude.ai, Desktop, mobile):** *Customize → Connectors → Add custom connector*, paste your MCP server URL and sign in. Claude connects from Anthropic's cloud, so the URL must be public HTTPS: your AnythingMCP Cloud URL, or your own instance behind TLS.
- **Claude Code:**

  ```bash
  claude mcp add --transport http soap-to-mcp http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"
  ```
- **Cursor** (`.cursor/mcp.json`) and **VS Code / GitHub Copilot** (`.vscode/mcp.json`, key `servers` instead of `mcpServers`, plus `"type": "http"`):

  ```json
  { "mcpServers": { "soap-to-mcp": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }
  ```
- **ChatGPT:** add the public HTTPS URL as a connector (app) in ChatGPT's settings. A `localhost` URL does not work there.

## Example prompts

- Which articles are at or below their reorder level?
- Which articles in the Basel warehouse need reordering?
- How many DR-1001 steel doors do we have, and what do they cost?
- What is the status of order SO-24044, and when did we promise it?
- Which low-stock articles would cost the most to reorder up to twice their reorder level?
- Is order SO-24031 going to be late if production takes another two weeks?

More in [examples/prompts.md](examples/prompts.md).

## Security

- **Only the operations you allow.** A role on the MCP server whitelists tools; an AI client never sees the rest.
- **Credentials** are encrypted with AES-256-GCM and never shown to the model.
- **Response mapping** drops or reshapes fields of a SOAP reply before they reach the model.
- **Audit log:** every call is recorded with input, output, duration and status in your own database.

## FAQ

### Can Claude call a SOAP web service?
Not directly: Claude, ChatGPT and other AI clients speak MCP, not SOAP. AnythingMCP sits in between. It reads the WSDL, exposes each SOAP operation as an MCP tool, and builds and parses the XML envelopes on every call.

### How do I convert a WSDL to an MCP server?
Create a SOAP connector in AnythingMCP with the WSDL URL and import it; every operation in the WSDL becomes a tool on your MCP server. `scripts/install.sh` does exactly that against the demo service, so you can see the result before pointing it at your own WSDL.

### Does it support WCF services and WS-Security?
WCF services, yes: the WSDL parameter order they are strict about is preserved. For auth the connector sends HTTP Basic, a bearer token or an API-key header. WS-Security SOAP headers and TLS client certificates are not implemented yet, so a service that requires them cannot be called today.

### Do I have to write code or an adapter?
No. The WSDL is the definition. You can rename operations, rewrite their descriptions and hide fields in the visual editor so the model picks the right tool, but none of that is code.

### Can I stop the AI from calling operations that change data?
Yes. Assign the SOAP connector to an MCP server whose role whitelists only the read operations; the other tools are then not visible to that client at all. Every call is also recorded in the audit log.

### What about SOAP services on my internal network?
Self-host AnythingMCP on a machine that can reach them and add their hostnames to `SSRF_ALLOWED_HOSTS`, as the `docker-compose.yml` here does for the demo service.

## Troubleshooting

| Problem | Fix |
|---|---|
| The import finds no operations | Open the WSDL URL in a browser. `?wsdl` vs `?singleWsdl` matters for WCF services that split their schema across files. |
| Calls go to the wrong host | The WSDL advertises an address AnythingMCP cannot reach. AnythingMCP replaces its host with the connector's base URL, so set the base URL to the address you can reach. |
| "SSRF" or "blocked host" errors | The service is on a private network. Add its hostname to `SSRF_ALLOWED_HOSTS` on a self-hosted instance. |
| The service rejects the call with a security fault | It expects WS-Security headers or a client certificate, which are not implemented yet. |
| The service answers "unknown operation" or a schema fault | AnythingMCP sends document/literal *wrapped* requests: the body element is named after the operation (`<GetItem>`), which is what WCF and JAX-WS generate. A WSDL whose input element has a different name (`<GetItemRequest>`), or whose parameters are nested complex types, is not supported yet. |
| The model sends the wrong parameters | Rewrite the tool description and parameter descriptions in the editor; the WSDL types are all the model has to go on. |

## Related

- [openapi-to-mcp](https://github.com/HelpCode-ai/openapi-to-mcp): OpenAPI to MCP: turn any OpenAPI/Swagger or REST API into an MCP server for Claude & ChatGPT. Every endpoint a tool, no code.
- [sql-to-mcp](https://github.com/HelpCode-ai/sql-to-mcp): SQL to MCP: connect PostgreSQL, MySQL, SQL Server, Oracle or MongoDB to Claude & ChatGPT. Read-only, audited, no code.
- [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server): ERP MCP server: connect 16 ERPs (SAP, Odoo, JTL-Wawi, Xentral, weclapp, ERPNext…) to Claude & ChatGPT. Self-hosted or cloud.
- [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp): the open-source MCP server and gateway this repository is built on.

## License

Not decided yet.
