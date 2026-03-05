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

```json
{
  "mcpServers": {
    "anythingmcp": {
      "type": "url",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

### Step 3: Restart Claude Desktop

Restart Claude Desktop. You should see your MCP tools available in the tools menu.

### Using API Keys

If you generated a per-user MCP API Key, use the `X-API-Key` header instead:

```json
{
  "mcpServers": {
    "anythingmcp": {
      "type": "url",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "X-API-Key": "your-mcp-api-key"
      }
    }
  }
}
```

### Multiple MCP Server Configs

If you created multiple MCP server configurations in AnythingMCP (each with different connector assignments), use the server-specific endpoint:

```json
{
  "mcpServers": {
    "crm-tools": {
      "type": "url",
      "url": "http://localhost:4000/mcp?server=crm-server",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    },
    "analytics-tools": {
      "type": "url",
      "url": "http://localhost:4000/mcp?server=analytics-server",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

---

## Claude Code

Claude Code (CLI) supports adding MCP servers via the command line.

### Add AnythingMCP

```bash
claude mcp add anythingmcp \
  --transport http \
  --url http://localhost:4000/mcp \
  --header "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
```

### With API Key

```bash
claude mcp add anythingmcp \
  --transport http \
  --url http://localhost:4000/mcp \
  --header "X-API-Key: your-mcp-api-key"
```

### Verify Connection

```bash
claude mcp list
```

You should see `anythingmcp` listed with its tools.

---

## Cursor

Cursor supports MCP servers via its settings.

### Step 1: Open Cursor Settings

Go to **Settings** > **MCP Servers** (or `Cmd+,` / `Ctrl+,` and search for "MCP").

### Step 2: Add Server

Add a new MCP server with:
- **Name**: `anythingmcp`
- **Transport**: HTTP
- **URL**: `http://localhost:4000/mcp`
- **Headers**: `Authorization: Bearer YOUR_MCP_BEARER_TOKEN`

### Via mcp.json

Alternatively, add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "anythingmcp": {
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

---

## Any MCP Client

AnythingMCP exposes a standard **Streamable HTTP** MCP endpoint at:

```
POST http://your-server:4000/mcp
```

### Authentication Modes

Configure `MCP_AUTH_MODE` in your `.env`:

| Mode | Description |
|------|-------------|
| `oauth2` | OAuth 2.0 Authorization Code (PKCE) + Client Credentials **(default)** |
| `legacy` | Static Bearer Token or API Key |
| `both` | Accepts either OAuth2 or legacy tokens |
| `none` | No authentication (development only) |

### Legacy Auth Headers

When using `legacy` or `both` mode:

```http
POST /mcp HTTP/1.1
Authorization: Bearer YOUR_MCP_BEARER_TOKEN
Content-Type: application/json
```

Or with API Key:

```http
POST /mcp HTTP/1.1
X-API-Key: your-mcp-api-key
Content-Type: application/json
```

### OAuth2 Flow

When using `oauth2` or `both` mode, clients can authenticate via:

1. **Authorization Code + PKCE** — For interactive clients
2. **Client Credentials** — For server-to-server integrations

The OAuth2 discovery endpoint is at:
```
GET http://your-server:4000/.well-known/oauth-authorization-server
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No tools available" | Verify connectors are created and have tools defined in AnythingMCP UI |
| 401 Unauthorized | Check your token/API key is correct and `MCP_AUTH_MODE` matches your auth method |
| Connection refused | Ensure the AnythingMCP backend is running on port 4000 |
| Tools not updating | AnythingMCP hot-reloads tools; try reconnecting your MCP client |

---

[Back to README](../../README.md)
