### Is there a Billbee MCP server?
Yes, this one. It connects Billbee to Claude, ChatGPT and Copilot through AnythingMCP: 8 tools for orders, products, customers and shipping providers.

### What do I need to connect it?
Three values: an API key, which you request from Billbee; the e-mail you log in with; and a separate API password you set under **Settings → Billbee API** in Billbee. All three are required; the Authentication section has the steps.

### Can the AI change orders in Billbee?
No. All 8 tools only read.

### Can I look up an order by the marketplace's order number?
Yes. `billbee_get_order_by_extref` finds a Billbee order by the external reference from Amazon, eBay, Kaufland, OTTO or your shop.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
