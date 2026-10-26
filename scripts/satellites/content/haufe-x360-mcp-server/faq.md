### Is there a Haufe X360 MCP server?
Yes. AnythingMCP ships a Haufe X360 connector that exposes Haufe X360 data as 7 read-only MCP tools (customers, sales orders, stock items, invoices, shipments and vendors) on AnythingMCP Cloud or your own Docker host.

### How do I connect Haufe X360 to Claude or ChatGPT?
Install the AnythingMCP connector, enter your Haufe X360 API credentials (tenant plus client ID and secret), then add the resulting MCP server URL to your AI client as a custom connector.

### Where do I find the credentials?
In the Haufe X360 API settings of your tenant: register an application and generate a client ID and client secret.

### Can the AI change data in Haufe X360?
No. All 7 tools are read-only, so the AI can read customers, orders, stock, invoices, shipments and vendors but cannot create or modify records. The token still carries the rights of the Haufe X360 user it belongs to, so scope it to what the AI should see.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (as an app or connector, which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Does Haufe X360 data leave my infrastructure?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use. Response mapping lets you drop sensitive fields.
