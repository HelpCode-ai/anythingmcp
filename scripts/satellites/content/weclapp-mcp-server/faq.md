### Is there a weclapp MCP server?
Yes, this one. It exposes weclapp's REST API v2 as 11 MCP tools (parties, sales orders, invoices, articles, quotations, recurring invoices and opportunities) through AnythingMCP, on AnythingMCP Cloud or on your own Docker host.

### How do I connect weclapp to Claude?
Install the connector (one click on AnythingMCP Cloud, or `./scripts/install.sh`), paste your tenant and API token, then add your MCP server URL to Claude as a custom connector. Claude Code and Cursor take the local URL with an API key header.

### Where do I find the weclapp API token?
In weclapp, open **My Settings → API Tokens** and generate a token. The tenant is the subdomain of your weclapp URL: `yourcompany` in `yourcompany.weclapp.com`.

### Can the AI change data in weclapp?
Not with this connector: all 11 tools are HTTP GET requests, so Claude can read but cannot create or change records. The token still carries the rights of the weclapp user who created it, so use a user that sees only what the AI should see.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (as an app or connector, which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Does weclapp data leave my infrastructure?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use. Response mapping lets you drop fields, such as bank details, before they reach the model.
