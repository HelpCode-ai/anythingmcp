### Is there an Exact Online MCP server?
Yes, this one. It connects Exact Online's REST/OData API to Claude, ChatGPT and Copilot through AnythingMCP: 10 tools for divisions, accounts (customers, suppliers and prospects), sales invoices, outstanding receivables, purchase invoices, purchase entries, items, stock positions per warehouse and general ledger accounts.

### What do I need to connect it?
Register an OAuth 2.0 app in the Exact Online App Centre (`apps.exactonline.com`) with the AnythingMCP callback URL (`/api/mcp-oauth/callback`), then set `EXACT_CLIENT_ID`, `EXACT_CLIENT_SECRET`, your country host in `EXACT_BASE_HOST` (such as `start.exactonline.nl` for the Netherlands or `start.exactonline.be` for Belgium) and `EXACT_DIVISION`, and click **Authorize with Provider** on the connector page. AnythingMCP renews Exact's 10-minute access tokens automatically.

### How do I find my Exact Online division code?
Every data endpoint in Exact Online is scoped to a numeric administration ID (`EXACT_DIVISION`). Call `exact_online_get_me` to read your user's `CurrentDivision`, or `exact_online_list_divisions` to list every administration your account can reach with its code, description and currency.

### Can the AI change data in Exact Online?
No. All 10 tools are HTTP GET requests, so the AI can only read records. What it can see is further limited by the permissions of the Exact Online user who authorizes the connection and the scopes enabled on your App Centre registration.

### Has this been tested against a live Exact Online administration?
Not yet: the adapter follows Exact Online's published REST/OData API documentation. If you use Exact Online, a report of what works is very welcome.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
