# Connect AnythingMCP to Claude

> Setup guide for Claude Desktop, Claude Code, and Cursor.

[Back to README](../../README.md)

---

## Claude Desktop

Claude Desktop supports MCP servers natively via the Streamable HTTP transport.

### Step 1: Get Your MCP Credentials

1. Log into the AnythingMCP UI at `http://localhost:3000`
2. Go to **MCP Server** to find your endpoint URL and auth config
3. Generate an **MCP API Key** or note your Bearer Token

### Step 2: Edit Claude Desktop Config

Open your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add AnythingMCP as an MCP server: