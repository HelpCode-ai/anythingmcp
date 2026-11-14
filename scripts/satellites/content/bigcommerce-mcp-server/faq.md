### Is there a BigCommerce MCP server?
Yes, this one. It connects the BigCommerce REST API to Claude, ChatGPT and Copilot through AnythingMCP: 14 tools for products, variants, stock, categories, orders and customers. Orders use the v2 endpoints, everything else v3.

### What do I need to connect my store?
A store API account: in BigCommerce go to Settings → API → API Accounts → Create API Account → V2/V3 API token. Give it at least Products, Orders and Customers (Read+Write) and Information & Settings (Read). Then enter the Access Token and your store hash, the code in the API path `https://api.bigcommerce.com/stores/<store hash>/v3/`.

### Can the AI change my store?
Yes, six tools write: create product, update product, delete product, update a variant's stock, update an order's status and create a customer. Deleting a product is permanent. If the AI should only look, choose read-only levels when you create the API account, or give the MCP server a role that whitelists the eight read tools.

### What is not covered?
Returns, subscriptions, B2B Edition, Stencil themes, checkout scripts and webhooks. A refunded order shows up through its status (Refunded or Partially Refunded), not as a return record.

### Are there rate limits?
They depend on your BigCommerce plan (the adapter notes about 30,000 requests an hour on Essentials and 60,000 on Pro). BigCommerce answers 429 when you go over, so ask for pages of results rather than the whole catalogue at once.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code. The adapter has not been run against a live BigCommerce store yet; if you try it, please report what works.
