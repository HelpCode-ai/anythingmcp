### Is there a Magento MCP server?
Yes, this one. It connects Magento 2 and Adobe Commerce to Claude, ChatGPT and Copilot through AnythingMCP: 12 tools for products, stock, categories, orders and customers.

### What do I need to connect it?
Your store's base URL and an admin access token from an integration (**System → Extensions → Integrations**). The Authentication section has the details.

### Can the AI change data in my store?
Yes, if you let it: five tools write (create, update and delete products, update stock, cancel orders). Give the MCP server a role that whitelists only the read tools to start.

### Does it work with Adobe Commerce Cloud?
It uses the standard Magento 2 REST API, which Adobe Commerce exposes too.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
