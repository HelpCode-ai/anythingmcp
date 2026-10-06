# Connect AnythingMCP to Claude

> Setup guide for Claude (claude.ai, Claude Desktop, the mobile apps), Claude Code and Cursor.

[Back to README](../../README.md)

---

## Which URL to use

Every MCP server you create in AnythingMCP has its own endpoint. It exposes the connectors assigned to that server, and nothing else:

```
https://<your-host>/mcp/<server-id>
```

Copy it from the server's page (**MCP Servers → your server → MCP endpoint**). On AnythingMCP Cloud the host is `cloud.anythingmcp.com`; a self-hosted instance uses its own public URL.

There is also a shared endpoint, `https://<your-host>/mcp`. When a client connects to it, the sign-in asks which of your servers (or which workspace) the connection may reach; with a single server, it is picked for you. The Claude Directory listing below uses this shared endpoint.

---

## Option 1: the Claude Directory (AnythingMCP Cloud)

AnythingMCP is listed in Claude's connector directory: [claude.ai/directory/anythingmcp](https://claude.ai/directory/anythingmcp). This is the fastest path if you use AnythingMCP Cloud.

1. Open [the AnythingMCP listing](https://claude.ai/directory/anythingmcp), or in Claude open **Customize → Connectors**, browse the connectors and search for AnythingMCP.
2. Click **Connect**.
3. Sign in to AnythingMCP Cloud and approve access. If you have several MCP servers, choose the ones Claude may reach.

The listing always connects to AnythingMCP Cloud. For a self-hosted instance, use option 2.

---

## Option 2: a custom connector (claude.ai and Claude Desktop)

Adds one specific MCP server, on Cloud or on a self-hosted instance.

1. In Claude, open **Customize → Connectors**.
2. Click **+**, then **Add custom connector**.
3. Enter a name and paste the endpoint URL, `https://<your-host>/mcp/<server-id>`, then click **Add**.
4. Click **Connect**, sign in to AnythingMCP and approve access.

Connectors added on claude.ai also appear in Claude Desktop and the mobile apps. The **Add to Claude** button in the server's Quick Connect panel opens the same dialog.

Claude connects to custom connectors from Anthropic's cloud, so a self-hosted instance must be reachable on a **public HTTPS URL**; `localhost` does not work here. See the [Deployment Guide](../deployment.md).

### Claude Desktop and `claude_desktop_config.json`

Use **Customize → Connectors** in Claude Desktop as well. The `claude_desktop_config.json` file only launches local (stdio) commands: a remote URL entry in it is skipped as "not a valid MCP server configuration".

If you must use the config file, bridge the remote server through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package (requires Node.js), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "anythingmcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-host>/mcp/<server-id>"]
    }
  }
}
```

`mcp-remote` runs the OAuth sign-in in your browser. To use an MCP API key instead, append `"--header", "X-API-Key:mcp_your_key"` to `args`.

---

## Option 3: Claude Code

Add the server from the command line:

```bash
claude mcp add --transport http anythingmcp https://<your-host>/mcp/<server-id>
```

Then run `/mcp` inside Claude Code and choose the server to sign in to AnythingMCP (OAuth).

With an MCP API key instead of OAuth (generate one on the server's page, under **API keys**):

```bash
claude mcp add --transport http anythingmcp https://<your-host>/mcp/<server-id> \
  --header "X-API-Key: mcp_your_key"
```

Check the connection:

```bash
claude mcp list
```

---

## Cursor

Use the **Open in Cursor** button in the server's Quick Connect panel, or add the server to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "anythingmcp": {
      "url": "https://<your-host>/mcp/<server-id>"
    }
  }
}
```

Cursor discovers the OAuth endpoints and asks you to sign in. To use an MCP API key instead, add `"headers": { "X-API-Key": "mcp_your_key" }`.

---

## Any MCP Client

AnythingMCP exposes standard **Streamable HTTP** MCP endpoints:

```
POST https://<your-host>/mcp/<server-id>   # one MCP server
POST https://<your-host>/mcp               # shared endpoint, scope chosen at sign-in
```

### Authentication Modes

Configure `MCP_AUTH_MODE` in your `.env` (self-hosted):

| Mode | Description |
|------|-------------|
| `oauth2` | OAuth 2.0 Authorization Code (PKCE) + Client Credentials (the value in `.env.example`) |
| `legacy` | Static Bearer Token or API Key |
| `both` | Accepts either OAuth2 or legacy tokens |
| `none` | No authentication (development only) |

Per-user MCP API keys (`mcp_…`, generated on a server's page) are sent in the `X-API-Key` header:

```http
POST /mcp/<server-id> HTTP/1.1
X-API-Key: mcp_your_key
Content-Type: application/json
```

In `legacy` or `both` mode, the static `MCP_BEARER_TOKEN` / `MCP_API_KEY` from `.env` are accepted as well:

```http
POST /mcp/<server-id> HTTP/1.1
Authorization: Bearer YOUR_MCP_BEARER_TOKEN
Content-Type: application/json
```

### OAuth2 Flow

In `oauth2` or `both` mode, clients authenticate via:

1. **Authorization Code + PKCE** for interactive clients (dynamic client registration is supported)
2. **Client Credentials** for server-to-server integrations

Clients discover the endpoints from:

```
GET https://<your-host>/.well-known/oauth-protected-resource/mcp/<server-id>
GET https://<your-host>/.well-known/oauth-authorization-server
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No tools available" | Assign connectors to the MCP server, and check that their tools are enabled |
| Tools added later don't show up | Claude loads the tool list when it connects. Open the connector in Claude and choose **⋮ → Refresh tools list** |
| 401 Unauthorized | Sign in again from the client, or check the API key and that `MCP_AUTH_MODE` matches your auth method |
| Claude cannot reach a self-hosted instance | It needs a public HTTPS URL; `localhost` works only for local clients such as Claude Code and Cursor |
| Connection refused | Ensure the AnythingMCP backend is running (port 4000 by default) |

---

[Back to README](../../README.md)
