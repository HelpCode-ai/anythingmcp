### Is there a Haufe X360 MCP server?
Yes, this one. It connects Haufe X360 (formerly Lexbizz, built on Acumatica) to Claude, ChatGPT and Copilot through AnythingMCP: 7 read-only tools for customers, vendors, stock items, sales orders, A/R invoices and shipments.

### What credentials do I need to connect Haufe X360?
You need your X360 base URL (`X360_URL`), your tenant/company name (`X360_TENANT`), the Default contract-based endpoint version (`X360_ENDPOINT_VERSION`, e.g. `24.200.001` from form SM207060), and a dedicated X360 user (`X360_USERNAME` and `X360_PASSWORD`).

### How does session management work with X360 license limits?
Haufe X360 licenses cap the number of concurrent API sessions. The connector signs in at `/entity/auth/login`, reuses a single session cookie across requests, and automatically refreshes it before expiry or on a `401` response.

### Can the AI create or release documents in Haufe X360?
No. All 7 tools are HTTP GET requests against the contract-based REST API, and X360 additionally enforces the screen permissions of the user account you configure.

### Has this been tested against a live Haufe X360 tenant?
Not yet: the adapter is built against the Acumatica / Haufe X360 Default contract-based REST endpoint specification. If you run Haufe X360, feedback from your live tenant is very welcome.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in Claude, ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
