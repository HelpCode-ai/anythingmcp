# Connect AnythingMCP to Google Gemini

> Setup guide for using AnythingMCP tools with Gemini CLI and Gemini API.

[Back to README](../../README.md)

---

## Overview

Google Gemini supports MCP server connections through **Gemini CLI** and the **Gemini API**. You can connect your AnythingMCP tools to Gemini for use in terminal-based workflows, automation, and AI-powered development.

---

## Gemini CLI

The Gemini CLI supports MCP servers via its `settings.json` configuration.

### Step 1: Install Gemini CLI

```bash
npm install -g @anthropic-ai/gemini-cli
# or
npx @anthropic-ai/gemini-cli
```

### Step 2: Add AnythingMCP Server

#### Option A: Via Command Line

```bash
gemini mcp add anythingmcp http://localhost:4000/mcp \
  -t http \
  -H "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
```

#### Option B: Via settings.json

Edit your Gemini CLI settings file:

- **macOS/Linux**: `~/.gemini/settings.json`
- **Windows**: `%USERPROFILE%\.gemini\settings.json`

```json
{
  "mcpServers": {
    "anythingmcp": {
      "httpUrl": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      },
      "timeout": 30000
    }
  }
}
```

### Step 3: Verify Connection

```bash
gemini mcp list
```

You should see `anythingmcp` listed with available tools.

### Using API Keys

```json
{
  "mcpServers": {
    "anythingmcp": {
      "httpUrl": "http://localhost:4000/mcp",
      "headers": {
        "X-API-Key": "your-mcp-api-key"
      }
    }
  }
}
```

---

## Remote Server (Public URL)

For connecting Gemini CLI to a publicly deployed AnythingMCP:

```json
{
  "mcpServers": {
    "anythingmcp": {
      "httpUrl": "https://mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      },
      "timeout": 30000
    }
  }
}
```

---

## Project-Scoped Configuration

For project-specific MCP settings, create a `.gemini/settings.json` in your project root:

```json
{
  "mcpServers": {
    "project-api": {
      "httpUrl": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer PROJECT_SPECIFIC_TOKEN"
      }
    }
  }
}
```

Use the `-s project` flag when adding via CLI:

```bash
gemini mcp add project-api http://localhost:4000/mcp \
  -t http \
  -s project \
  -H "Authorization: Bearer PROJECT_SPECIFIC_TOKEN"
```

---

## Tool Filtering

Gemini CLI supports filtering which tools to expose:

```json
{
  "mcpServers": {
    "anythingmcp": {
      "httpUrl": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      },
      "includeTools": ["get_customers", "search_products"],
      "excludeTools": ["delete_customer"]
    }
  }
}
```

---

## Managing Servers

```bash
# List all MCP servers
gemini mcp list

# Remove a server
gemini mcp remove anythingmcp

# Temporarily disable a server
gemini mcp disable anythingmcp

# Re-enable a server
gemini mcp enable anythingmcp
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Server not found" | Run `gemini mcp list` to verify the server is configured |
| Connection timeout | Increase the `timeout` value in settings.json |
| Auth errors | Verify the token and ensure `MCP_AUTH_MODE` is set to `legacy` or `both` |
| Tools not appearing | Check that connectors have tools defined in AnythingMCP UI |

---

[Back to README](../../README.md)
