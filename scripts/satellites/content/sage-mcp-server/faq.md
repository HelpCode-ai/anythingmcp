### Is there a Sage 100 MCP server?
Yes. AnythingMCP ships a Sage 100 connector that exposes Sage 100 through 6 MCP tools, including a generic read-only `query` tool, on AnythingMCP Cloud or your own Docker host.

### How do I connect Sage 100 to Claude or ChatGPT?
Install the AnythingMCP connector, enter your Sage 100 API base URL and credentials, then add the resulting MCP server URL to your AI client as a custom connector.

### What can the query tool do?
It runs read-only queries against the Sage 100 endpoints you allow. Pair it with `metadata` to discover available fields and object types before asking questions.

### Can the AI change data in Sage 100?
No. All 6 tools are read-only, so the AI can read items, addresses, documents and run queries but cannot create or modify records. Scope the credentials to a read-only Sage 100 user.

### Does it work with ChatGPT and Copilot too?
Yes. The same MCP server URL works in ChatGPT (as an app or connector, which needs a public HTTPS URL such as AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor and any other MCP client.

### Does Sage 100 data leave my infrastructure?
Self-hosted, the credentials and the audit log stay on your server; only the fields a tool returns go to the AI model you use. Response mapping lets you drop sensitive fields.
