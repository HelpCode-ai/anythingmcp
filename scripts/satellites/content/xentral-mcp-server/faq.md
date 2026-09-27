### Is there a Xentral MCP server?
Yes, this one. It connects the Xentral REST API to Claude, ChatGPT and Copilot through AnythingMCP: 7 tools for articles, customers, sales orders, invoices and stock per warehouse.

### What do I need to connect it?
Your Xentral instance URL and an API user (Einstellungen → Benutzer → API), whose login and password the connector uses for Basic authentication.

### Can the AI change data in Xentral?
No. All seven tools only read.

### Has this been tested against a live Xentral instance?
Not yet: the adapter follows the Xentral API documentation. If you use Xentral, a report of what works is very welcome.

### Does it work with ChatGPT and Copilot?
Yes. The same MCP server works in ChatGPT (with a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and Claude Code.
