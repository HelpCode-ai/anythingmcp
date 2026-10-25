### Is there an Ecwid MCP server?
Yes, this one. It connects the Ecwid REST API v3 to Claude, ChatGPT and Copilot through AnythingMCP: 10 tools for the store profile, products, categories, orders and customers.

### What do I need to connect my store?
Your numeric Store ID (it is in your Ecwid control panel URL) and an access token. Create the token in Ecwid under My Profile → My Apps → Create App, or use a personal token from your control panel. Either works as the Bearer token. You paste the token in; AnythingMCP does not run a sign-in flow for Ecwid, so there is no redirect URL to register.

### Can the AI change my store?
Yes, three tools write: create product, update product and update order. The order tool can change the payment status, the fulfilment status, the tracking number and the shipping method. There is no delete tool. If the AI should only look, leave those three tools off the MCP server's role.

### What can it not do?
Ecwid's product search cannot sort by sales or filter by stock level, so there is no direct "best sellers" or "low stock" view; the AI reads quantities from the products it finds. Subscriptions, payment gateways, themes and storefront settings are out of scope.

### How many results come back at a time?
Up to 100 per call (the `offset` and `limit` parameters page through more).

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter has not been run against a live Ecwid store yet; if you try it, please report what works.
