### Is there a Zalando MCP server?
Yes, this one. It connects Zalando's zDirect partner APIs for Partner Fulfilment (Direct Ship) merchants to Claude, ChatGPT and Copilot through AnythingMCP: 5 tools for orders, the items of an order, shipments and announced returns.

### What do I need to connect it?
An active Zalando Partner Programme contract: the API is not open and there is no self-service sign-up. In the zDirect Portal open **Applications**, create or pick an app, copy its client id and client secret, and give it the `orders/read` scope. Also note your merchant id (a UUID). Merchants often have several, one per sales channel or country, and the wrong one returns an empty result that looks right.

### Where do I register a redirect URL?
Nowhere. Zalando uses OAuth 2.0 client credentials, so there is no sign-in page and no redirect URL: AnythingMCP exchanges the client id and secret for a token itself. A 403 usually means the app is missing a scope, not that the secret is wrong.

### Can the AI change orders, stock or prices?
No. All 5 tools only read. Zalando's Stocks and Prices APIs are write-only, with no endpoint to read stock or prices back, so this connector does not offer them. Shipments are listed per order, so the AI needs the order first.

### Does it work in the Zalando sandbox?
The adapter calls the production API at `api.merchants.zalando.com`. Zalando runs a sandbox at `api-sandbox.merchants.zalando.com`, but it also needs zDirect credentials.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter is unverified against a live Zalando account: paths follow Zalando's published specifications, but no tool has been run with real credentials. A report from anyone who tries it is very welcome.
