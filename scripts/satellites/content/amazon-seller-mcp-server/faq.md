### Is there an Amazon Seller Central MCP server?
Yes, this one. It connects the official Selling Partner API (SP-API) to Claude, ChatGPT and Copilot through AnythingMCP: 15 tools for orders, catalog, FBA inventory, offers, fee estimates, financial events, listings and reports.

### What do I need to connect it?
A private Selling Partner API app (Seller Central → Apps & Services → Develop Apps), its LWA client ID and secret, a refresh token from authorising the app for your seller account, the regional endpoint and your marketplace and seller IDs. The Authentication section lists each one.

### Does it work in the SP-API sandbox?
Yes. Point the endpoint at the sandbox host to try it; the sandbox returns Amazon's canned responses. Real data needs the app's production authorization.

### Can the AI change prices or listings?
No. This connector only reads, apart from requesting a report. Price and listing updates are not part of it.

### Can it see buyer names and addresses?
No. That personal data needs Amazon's Restricted Data Token flow, which this connector does not use, so orders come back without buyer PII.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
