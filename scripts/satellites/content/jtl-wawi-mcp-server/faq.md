### Is there a JTL-Wawi MCP server?
Yes. AnythingMCP ships a JTL-Wawi connector that exposes JTL-Wawi's data as 10 read-only MCP tools (warehouses, items, item stock, customers, sales orders, sales-order line items and shipments) on AnythingMCP Cloud or your own Docker host.

### How do I connect JTL-Wawi to Claude or ChatGPT?
JTL-Wawi only speaks HTTP through the separate **JTL-API-Server** (a Windows service you install next to JTL-Wawi). Install the AnythingMCP connector, point it at your JTL-API-Server URL, and paste the API key. Then add the resulting MCP server URL to Claude, ChatGPT or Copilot as a custom connector.

### Where do I find the API key?
In the JTL-API-Server management console: create an API user and copy its key. The JTL-API-Server must be reachable (local network or tunnel) from wherever AnythingMCP runs.

### Can the AI change data in JTL-Wawi?
No. All 10 tools are HTTP GET requests, so the AI can read stock, orders, customers and shipments but cannot create or modify records. Use a JTL-Wawi user that sees only what the AI should see.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (as an app or connector, which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Does JTL-Wawi data leave my infrastructure?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use. Response mapping lets you drop fields such as prices or customer identifiers.
