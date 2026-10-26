### Is there an ERPNext MCP server?
Yes, this one. It exposes the Frappe REST API as 11 MCP tools through AnythingMCP, on AnythingMCP Cloud or on your own Docker host: list, read, count and describe any DocType (including your custom ones), convenience tools for customers, sales orders, sales invoices, items and stock per warehouse, a key check, and one tool that creates documents. The adapter follows Frappe's documented REST API and has not been run against a live instance yet; a report of what works is very welcome.

### How do I connect ERPNext to Claude?
In ERPNext, open the user the AI should act as, go to **Settings → API Access** and click *Generate Keys*; the API secret is shown only once. Install the connector with `ERPNEXT_URL` (your instance root, no trailing slash), `ERPNEXT_API_KEY` and `ERPNEXT_API_SECRET`, and add your MCP server URL to Claude as a custom connector. AnythingMCP sends them as `token key:secret`; `erpnext_get_logged_user` is the quickest way to check that the key works.

### Can the AI change data in ERPNext?
Yes, if you let it: `erpnext_create_document` creates a real document in any DocType and fires ERPNext's server scripts, notifications and stock ledger entries. It cannot update or delete. To stay read-only, give the AI a role that leaves this tool out, and create the API key for an ERPNext user whose roles cannot create documents.

### Why does the AI only see document names, or fewer rows than expected?
Without a `fields` list, ERPNext returns only each document's `name`, so the AI has to ask for the fields it needs. Fewer rows than expected is usually a permissions answer: ERPNext filters rows by the API user's roles and permissions instead of returning an error.

### My ERPNext runs on an internal server. Can I still use it?
Yes, with a self-hosted AnythingMCP on the same network: add the ERPNext hostname to `SSRF_ALLOWED_HOSTS`. AnythingMCP Cloud can only reach an instance on a public hostname with a valid TLS certificate; a self-signed certificate fails.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor, Claude Code and any other MCP client.
