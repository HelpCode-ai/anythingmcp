### Is there a Shopware MCP server?
Yes, this one. It connects the Shopware 6 Store API to Claude, ChatGPT and Copilot through AnythingMCP: 6 tools to search products, read a product, browse categories, get search suggestions and read cross-sells.

### Can it read orders or customers?
No. The Store API is what the storefront itself uses, so it sees the catalog, not the back office. Orders and customers live in the Admin API, which this connector does not use.

### What do I need to connect my shop?
The shop URL and the sales channel's access key (Sales Channels → your storefront → API access). That key is public by design; it identifies the sales channel and grants storefront-level read access.

### Can the AI change prices or products?
No. All six tools only read.

### Does it work with Shopware 5?
No. It needs the Shopware 6 Store API.
