### Is there a WooCommerce MCP server?
Yes, this one. It connects the WooCommerce REST API v3 to Claude, ChatGPT and Copilot through AnythingMCP: 49 tools for products, variations, stock, orders, refunds, customers, coupons and reports, plus a few built-in playbooks.

### What do I need to connect my shop?
The shop's URL and a REST API key: WordPress admin → WooCommerce → Settings → Advanced → REST API → Add key. Choose Read for a read-only setup, Read/Write if the AI may change things. The site must use HTTPS, because WooCommerce only accepts the key over HTTPS.

### Can the AI change my shop?
Only if you let it. Many tools write (products, stock, orders, refunds, coupons, customers). Create the key with Read permission, or give the MCP server a role that whitelists only the read tools.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.

### My shop is on a local or staging server. Does that work?
Yes, with a self-hosted AnythingMCP that can reach it; add the host to `SSRF_ALLOWED_HOSTS`.
