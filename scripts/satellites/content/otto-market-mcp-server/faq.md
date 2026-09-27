### Is there an OTTO Market MCP server?
Yes, this one. It connects the OTTO Market partner API to Claude, ChatGPT and Copilot through AnythingMCP: 8 tools for orders, products, stock, returns, and stock and price updates.

### What do I need to connect it?
An OTTO Market partner account and API credentials from OTTO Partner Connect. OTTO issues a username and password for its token endpoint; AnythingMCP exchanges them for an access token and renews it.

### Can the AI change stock or prices?
Yes, two tools can: `otto_market_update_quantity` and `otto_market_update_price`. OTTO applies both asynchronously, so a read straight afterwards may still show the old value. Leave them off the MCP server's role if the AI should only read.

### Has this been tested against a live OTTO account?
Not yet. The adapter follows OTTO's published API documentation. If you run it against your account, please report what works and what doesn't.
