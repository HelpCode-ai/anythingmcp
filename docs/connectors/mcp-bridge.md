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
| **Bearer Token** | Static token for the remote MCP server (Linear, GitHub, Stripe, Firecrawl, Apify keys) |
| **Basic Auth** | `Authorization: Basic base64(username:password)`, e.g. an Atlassian personal API token as `email:token` |
| **OAuth2** | Sign in at the provider ("Authorize with Provider"); tokens refresh automatically |
| **API Key** | API key in a header of your choice |
| **None** | For unprotected local MCP servers |

### OAuth2 against a remote MCP server

"Authorize with Provider" on an MCP connector:

1. **Discovers** the server's OAuth metadata: the RFC 9728 protected-resource document
   (path-inserted, then at the root of the host), the authorization server it names (RFC 8414,
   then OpenID Connect discovery), and finally the origin-level
   `/.well-known/oauth-authorization-server` of older servers.
2. **Takes the endpoints as published.** An authorization server on another host is legitimate
   (Stripe's is `access.stripe.com`, Apify's `console.apify.com`). Only an endpoint on a host
   that cannot be reached from outside (loopback, private address, `.local`, a single-label
   Docker name) is moved onto the MCP server's own origin: that is what a self-hosted server with
   a wrong `OAUTH_SERVER_URL` advertises. Token and registration requests go through the SSRF
   guard; the authorization endpoint must be `http(s)`.
3. **Picks the client**: a pre-registered one (see `mcpOAuth` below), else one obtained by
   dynamic client registration (RFC 7591), else the client ID/secret stored in the connector's
   OAuth settings. A registered client is kept in the connector's encrypted auth config and
   reused on the next authorization; it is registered again only when the server, the callback
   URL or the secret's expiry changes, or the provider refuses it (`invalid_client`).
   Registration asks for the token endpoint auth method the server supports: `none` (a public
   client, no secret) where that is all it offers.
4. **Sends** PKCE S256, the `scope` (the protected resource's `scopes_supported`, else the
   authorization server's) and the RFC 8707 `resource` indicator on the authorization request,
   the code exchange and every refresh, whenever the server publishes a protected-resource
   document.
5. **Imports the tools** the server lists once the token is stored. A connector installed from
   a catalog adapter goes through the same policy as the install: tools the catalog switches off
   arrive switched off, catalog annotations fill what the server leaves out, the tool prefix
   applies.

The redirect URI to register with a provider is `<SERVER_URL>/api/mcp-oauth/callback`
(`GET /api/connectors/oauth/redirect-uri` returns it).

### Connector settings (`connector.config`)

A catalog adapter sets these under `connector.config`; they are copied into the connector at
install. Through the API they can be set on any MCP connector.

| Key | Meaning |
|-----|---------|
| `mcpPath` | Endpoint path when the base URL cannot say it. A base URL without a path means `<origin>/mcp`, so a server at the root of its host (Stripe, Apify) sets `"/"`. |
| `mcpToolPrefix` | Prepended to the remote tool names (`linear_` turns `list_issues` into `linear_list_issues`), so two bridges with tools of the same name can share an MCP server. Characters outside `[A-Za-z0-9_]` become `_`, and a name that already starts with the prefix keeps it once. Calls still use the remote name. |
| `mcpOAuth` | How "Authorize with Provider" works for this connector, below. |

`mcpOAuth` (every field optional):

```json
"mcpOAuth": {
  "registration": "auto",
  "clientId": "{{ACME_CLIENT_ID}}",
  "clientSecret": "{{ACME_CLIENT_SECRET}}",
  "scope": "mcp_api refresh_token",
  "tokenAuthMethod": "client_secret_post",
  "resource": true
}
```

| Field | Meaning |
|-------|---------|
| `registration` | `auto` (default): the pre-registered client when `clientId` resolves to a value, else dynamic registration, else the client stored in the OAuth settings. `dcr`: always dynamic registration. `preregistered`: never dynamic registration, even if the server advertises it (Salesforce does, and refuses it for MCP). |
| `clientId`, `clientSecret` | A client the user registered with the provider, normally `{{VAR}}` placeholders. They are resolved from the connector's environment variables when the user clicks Authorize, so values typed after install are used. With empty variables the error names them and the redirect URI to register. |
| `scope` | The scope to request. `""` sends no scope at all (Asana asks for that). Absent: the protected resource's scopes, else the authorization server's. A scope typed in the connector's OAuth settings wins. |
| `tokenAuthMethod` | `none`, `client_secret_post` or `client_secret_basic`: for a pre-registered client, how it authenticates at the token endpoint; for dynamic registration, the method to register with. |
| `resource` | RFC 8707 indicator. Default: sent when the server publishes a protected-resource document, with that document's `resource` (else the MCP URL). `true` always sends it, `false` never, a string sends that value. |

### Vendor MCP servers in the catalog

These catalog adapters bridge a vendor's official remote MCP server. At install AnythingMCP lists
the tools of the server (the catalog keeps a snapshot for the store and as the fallback when the
server cannot be reached). Click **Discover tools** on the connector after the vendor adds tools.

| Adapter | Endpoint | Auth |
|---------|----------|------|
| Splunk | `https://<host>:8089/services/mcp` | Bearer (encrypted MCP token) |
| Linear | `https://mcp.linear.app/mcp` | Bearer (API key) |
| GitHub | `https://api.githubcopilot.com/mcp/` | Bearer (personal access token) |
| Stripe | `https://mcp.stripe.com` (root, `mcpPath: "/"`) | Bearer (agent restricted key) |
| Atlassian (Jira, Confluence) | `https://mcp.atlassian.com/v2/mcp` | Basic (email + API token), or Bearer for a service account key |
| Snowflake | `https://<account>/api/v2/databases/<db>/schemas/<schema>/mcp-servers/<name>` | Bearer (programmatic access token) |
| Firecrawl | `https://mcp.firecrawl.dev/v2/mcp` | Bearer (API key) |
| Apify | `https://mcp.apify.com` (root, `mcpPath: "/"`) | Bearer (API token) |
| Notion | `https://mcp.notion.com/mcp` | OAuth2, dynamic registration |
| Helium 10 | `https://mcp.helium10.com/mcp` | OAuth2, dynamic registration |

One authorization serves every caller of a connector: whoever clicks "Authorize" is the identity
the tools act as. For per-user tools (Notion, Slack, Salesforce) use a dedicated account until
per-user tokens exist.

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
