# MCP Bridge Connector — MCP-to-MCP Gateway

> Aggregate multiple MCP servers into one. Create a unified MCP gateway that proxies tools from other MCP servers.

[Back to README](../../README.md)

---

## Overview

The MCP Bridge connector lets you connect to **other MCP servers** and re-expose their tools through AnythingMCP. This creates a unified gateway where AI clients connect to a single MCP endpoint and access tools from multiple backend MCP servers.

**Keywords:** MCP gateway, MCP proxy, MCP aggregator, MCP middleware, MCP-to-MCP bridge, MCP server federation, MCP hub

---

## Use Cases

- **MCP Aggregation** — Combine tools from multiple MCP servers into one endpoint
- **MCP Proxy** — Add authentication, rate limiting, and audit logging in front of existing MCP servers
- **MCP Gateway** — Single entry point for AI clients to access all your MCP tools
- **Tool Curation** — Select which tools from remote MCP servers to expose

---

## Creating an MCP Bridge Connector

### Via Web UI

1. Go to **Connectors** > **New Connector**
2. Select **MCP** as the type
3. Enter the **Remote MCP Server URL** — the *complete* endpoint URL, including its path (e.g., `http://other-mcp-server:3000/mcp`)
4. Configure authentication for the remote server
5. Click **Create**

### Via API

```bash
curl -s http://localhost:4000/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Remote MCP Server",
    "type": "MCP",
    "baseUrl": "http://other-mcp-server:3000/mcp",
    "authType": "BEARER_TOKEN",
    "authConfig": {
      "token": "remote-server-token"
    }
  }'
```

### The base URL is the endpoint

Whatever path you put in the base URL is the path AnythingMCP calls. This matters for
providers that do not serve MCP at the root of their host:

| Remote server | Base URL to enter |
|---------------|-------------------|
| Most hosted servers | `https://mcp.example.com/mcp` |
| Snowflake managed MCP server | `https://<account>.snowflakecomputing.com/api/v2/databases/<db>/schemas/<schema>/mcp-servers/<name>` |
| Another AnythingMCP instance | `https://your-anythingmcp.example.com/mcp/<serverId>` |
| Zoho MCP | `https://<workspace>.zohomcp.com/mcp/<token>/message` |

A base URL with **no** path (`https://mcp.example.com`) falls back to `/mcp`, which is where
most servers listen.

> **Changed behaviour.** Releases up to v0.4.2 always POSTed to `<origin>/mcp` and silently
> discarded the base URL's path, so servers hosted under a path could never be reached
> ([#501](https://github.com/HelpCode-ai/anythingmcp/issues/501)). If you had worked around
> this by leaving an unrelated path in the base URL, set it back to the bare host.

---

## How It Works

1. AnythingMCP connects to the remote MCP server
2. It discovers available tools on the remote server
3. Tools are registered in the local ToolRegistry
4. When an AI client calls a bridged tool, AnythingMCP:
   - Forwards the tool call to the remote MCP server
   - Passes parameters through
   - Returns the response

### Endpoint Mapping

MCP bridge tools use a simple mapping:

```json
{
  "method": "remote_tool_name",
  "bodyMapping": {
    "param1": "$param1",
    "param2": "$param2"
  }
}
```

| Field | Description |
|-------|-------------|
| `method` | The tool name on the remote MCP server |
| `bodyMapping` | Maps local parameters to remote tool parameters |
| `path` | Optional. Overrides the endpoint for this tool only. A leading `/` is resolved against the host, a relative value is appended to the base URL's path, and a full `https://…` URL is used verbatim. The default `/mcp` means "use the connector's base URL". |

---

## Authentication

The MCP Bridge supports automatic token refresh for OAuth2-protected remote servers.

| Auth Type | Use Case |
|-----------|----------|
| **Bearer Token** | Static token for the remote MCP server |
| **OAuth2** | Auto-refreshing tokens with client credentials |
| **API Key** | API key header authentication |
| **None** | For unprotected local MCP servers |

---

## Architecture Example

```
  Claude Desktop ─┐
  ChatGPT ────────┤
  Cursor ─────────┤
                  ▼
           AnythingMCP (Gateway)
           ┌───────────────────┐
           │ MCP Bridge #1 ────│──► File System MCP Server
           │ MCP Bridge #2 ────│──► Slack MCP Server
           │ MCP Bridge #3 ────│──► Custom MCP Server
           │ REST Connector ───│──► Your REST API
           │ DB Connector ─────│──► PostgreSQL / MySQL / MongoDB / ...
           └───────────────────┘
```

All AI clients connect to **one** AnythingMCP endpoint and get access to tools from all connected servers.

---

## Benefits Over Direct Connection

| Feature | Direct MCP | Via AnythingMCP |
|---------|-----------|-----------------|
| Auth & rate limiting | Per-server config | Centralized |
| Audit logging | None | Every invocation logged |
| Role-based access | None | Tool-level whitelisting |
| API key management | None | Per-user keys |
| Response caching | None | Redis caching |
| Tool curation | All or nothing | Select which tools to expose |

---

[Back to README](../../README.md) | [Tool Definition Format](../tool-definition.md) | [API Reference](../api-reference.md)
