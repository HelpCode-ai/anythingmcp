### Is there a Dolibarr MCP server?
Yes, this one. It exposes Dolibarr's REST API as 10 MCP tools (third parties, customer invoices, customer orders, commercial proposals, supplier invoices, products and stock per warehouse, plus a status check) through AnythingMCP, on AnythingMCP Cloud or on your own Docker host. The adapter follows Dolibarr's documented REST API and has not been run against a live installation yet; a report of what works is very welcome.

### How do I connect Dolibarr to Claude?
As an administrator, enable **Setup → Modules → Web Services API REST** (it is off by default), then generate an API key on the user card of the user the AI should act as. Install the connector with `DOLIBARR_URL` (your installation root, without `/api`) and `DOLIBARR_API_KEY`, and add your MCP server URL to Claude as a custom connector. `dolibarr_get_status` is the quickest way to check that the module is on and the key works.

### Can the AI change data in Dolibarr?
Not with this connector: all 10 tools are HTTP GET requests, so the AI can read but cannot create or change records. The key carries the rights of its Dolibarr user, module by module, so create a dedicated user with only the read permissions the AI needs.

### Why does the AI get an empty list or a 403?
Dolibarr's permissions are per module. A user without *read invoices* gets a 403 on invoices, and one without *read third parties* sees an empty list instead of an error. Check the rights of the user the API key belongs to.

### My Dolibarr runs on an internal server. Can I still use it?
Yes, with a self-hosted AnythingMCP on the same network: add the Dolibarr hostname to `SSRF_ALLOWED_HOSTS`. AnythingMCP Cloud can only reach an installation on a public hostname with a valid TLS certificate; a self-signed certificate fails.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor, Claude Code and any other MCP client.
