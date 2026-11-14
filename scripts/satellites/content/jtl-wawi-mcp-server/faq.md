### Is there a JTL-Wawi MCP server?
Yes, this one. It exposes the JTL-Wawi REST API v1 as 10 MCP tools for warehouses, articles, per-warehouse stock, customers, sales orders, order line items and delivery notes with tracking through AnythingMCP.

### Why do I need the JTL API Server?
JTL-Wawi itself is a Windows desktop application backed by SQL Server and does not speak HTTP on its own. The separate **JTL API Server** service runs alongside your Wawi database and exposes the `/api/eazybusiness/v1` REST endpoints that this connector calls.

### How do I get the JTL-Wawi API key?
Open **Admin → App registration** in JTL-Wawi, register the app against `/api/eazybusiness/authentication` with your `AppId` and version, and approve the request in Wawi. Set `JTL_WAWI_URL`, `JTL_WAWI_API_KEY`, `JTL_WAWI_APP_ID` and `JTL_WAWI_APP_VERSION` on the connector.

### Can the AI change data in JTL-Wawi?
No. All 10 tools are HTTP GET requests, so Claude and ChatGPT can read articles, stock levels, customers, orders and shipments, but cannot create or modify anything in JTL-Wawi.

### How do I connect an on-premises JTL-Wawi installation?
If the JTL API Server is only reachable on your internal network, run AnythingMCP with Docker on the same network and add the server's hostname to `SSRF_ALLOWED_HOSTS`. To use AnythingMCP Cloud, the JTL API Server must be reachable over public HTTPS with a valid TLS certificate.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in Claude, ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
