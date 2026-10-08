### Is there a Kaufland Marketplace MCP server?
Yes, this one. It connects the Kaufland Marketplace seller API to Claude, ChatGPT and Copilot through AnythingMCP: 7 tools for orders, order units, units (offers), tickets, storefronts and warehouses.

### What do I need to connect it?
A Kaufland seller account and an API key pair from the Seller Portal (Settings → API keys): the Client Key and the Secret Key.

### Is the secret key sent anywhere?
No. Kaufland signs every request with HMAC: AnythingMCP sends the Client Key, a timestamp and a signature computed with the Secret Key. The secret itself never leaves your AnythingMCP instance.

### Can the AI change orders or prices?
No. All eight tools only read.

### Why "order units" and not just orders?
Kaufland fulfils, cancels and pays out per unit, so a partly cancelled order is common. The order-unit tool shows what actually happened to each item.
