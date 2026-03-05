# Connect AnythingMCP to GitHub Copilot

> Setup guide for using AnythingMCP tools with GitHub Copilot in VS Code and JetBrains IDEs.

[Back to README](../../README.md)

---

## Overview

GitHub Copilot supports MCP server connections in **VS Code** and **JetBrains IDEs** (agent mode). You can connect your AnythingMCP tools to Copilot Chat for use in your coding workflow.

---

## VS Code Setup

### Step 1: Enable MCP Support

Ensure you have:
- **GitHub Copilot** extension installed and active
- **VS Code** 1.99+ (or latest Insiders)
- Copilot Chat agent mode enabled

### Step 2: Configure MCP Server

Add AnythingMCP to your VS Code MCP settings. Create or edit `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "anythingmcp": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

Or configure it globally via VS Code settings (`settings.json`):

```json
{
  "github.copilot.chat.mcp.servers": {
    "anythingmcp": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

### Step 3: Use in Copilot Chat

Open Copilot Chat in **Agent mode** (select "Agent" from the mode picker) and ask it to use your tools:

- *"Use anythingmcp to search for customers"*
- *"Query the database for recent orders"*
- *"Call the CRM API to get contact details"*

Copilot will discover available tools and invoke them as needed.

---

## JetBrains IDEs Setup

GitHub Copilot in JetBrains IDEs (IntelliJ, WebStorm, PyCharm, etc.) also supports MCP servers.

### Configure MCP Server

Add to your project's `.github/copilot-mcp.json`:

```json
{
  "servers": {
    "anythingmcp": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_BEARER_TOKEN"
      }
    }
  }
}
```

---

## Using API Keys

If you use per-user MCP API Keys:

```json
{
  "servers": {
    "anythingmcp": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "X-API-Key": "your-mcp-api-key"
      }
    }
  }
}
```

---

## Team Setup

For team-wide configurations, commit the `.vscode/mcp.json` file to your repository. Use environment variables for tokens:

```json
{
  "servers": {
    "anythingmcp": {
      "type": "http",
      "url": "https://mcp.yourcompany.com/mcp",
      "headers": {
        "X-API-Key": "${MCP_API_KEY}"
      }
    }
  }
}
```

Each team member sets their own `MCP_API_KEY` environment variable with their personal API key from AnythingMCP.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP tools not showing | Ensure you're in **Agent mode** in Copilot Chat, not "Edit" or "Ask" mode |
| "Server not available" | Verify AnythingMCP is running and the URL is correct |
| Auth errors | Check token/API key; ensure `MCP_AUTH_MODE` includes `legacy` or `both` |
| VS Code version | MCP support requires VS Code 1.99+ |

---

[Back to README](../../README.md)
