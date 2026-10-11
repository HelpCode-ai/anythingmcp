### Is there a Xentral MCP server?
Yes, this one. It connects the current Xentral API to Claude, ChatGPT and Copilot through AnythingMCP: 30 tools for products, stock per warehouse and storage location, customers, suppliers, sales orders, delivery notes with tracking, invoices with payment status, credit notes, purchase orders and supplier invoices.

### What do I need to connect it?
Your Xentral instance URL (https://<your-id>.xentral.biz) and a Personal Access Token, which an admin creates under Administration → Account settings → Developer settings → Personal Access Tokens.

### Can the AI change data in Xentral?
Only to prepare sales orders as drafts, which a person releases in Xentral. Every other tool only reads, and the token's own permissions set the limit.

### Has this been tested against a live Xentral instance?
Not yet: the adapter follows Xentral's published API reference. If you use Xentral, a report of what works is very welcome.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
