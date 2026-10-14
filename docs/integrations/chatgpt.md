# Connect AnythingMCP to ChatGPT

> Setup guide for using AnythingMCP tools with ChatGPT.

[Back to README](../../README.md)

---

## Overview

ChatGPT on the web can add a custom remote MCP server as a plugin, so you can use your AnythingMCP tools directly in ChatGPT conversations. No developer mode is needed. On Business, Enterprise and Edu workspaces the **Create plugins with MCPs** permission controls who can add one.

---

## Prerequisites

- ChatGPT on the web. On a **Business** workspace only admins and owners can add custom MCP servers; on **Enterprise** and **Edu** an admin can grant the **Create plugins with MCPs** permission under **Workspace settings → Permissions & roles**
- AnythingMCP deployed and accessible via a **public HTTPS URL** (ChatGPT connects from the cloud)
- MCP tools configured in your AnythingMCP instance

> **Important:** ChatGPT connects to MCP servers from the internet. Your AnythingMCP instance must be accessible via a public URL with HTTPS. A `localhost` URL will not work.

---

## Step 1: Deploy AnythingMCP Publicly

If you haven't already, deploy AnythingMCP with a public HTTPS URL. See the [Deployment Guide](../deployment.md) for instructions on setting up a reverse proxy with TLS.

Your MCP endpoint will be:
```
https://mcp.yourdomain.com/mcp
```

---

## Step 2: Configure MCP Auth

ChatGPT's custom MCP server dialog offers **OAuth**, **No authentication**, or **OAuth or no authentication**. It has no field for a bearer token or API key, so use OAuth. Set the auth mode in your `.env` (`oauth2` is the default; `both` also keeps legacy tokens and API keys working for other clients) and set `SERVER_URL` to your public HTTPS URL, which OAuth uses for its metadata and redirects:

```env
MCP_AUTH_MODE=oauth2    # or 'both' for OAuth2 + legacy tokens / API keys
SERVER_URL=https://mcp.yourdomain.com
```

---

## Step 3: Add MCP Server in ChatGPT

1. Open **Plugins** in ChatGPT on the web: [chatgpt.com/plugins](https://chatgpt.com/plugins)
2. Click **+**, then **Add custom MCP server**
3. Enter a name (e.g. AnythingMCP) and an optional description
4. Under **Connection**, enter the **Server URL**: `https://mcp.yourdomain.com/mcp` (on AnythingMCP Cloud, the endpoint URL shown on your server's page)
5. Set **Authentication** to **OAuth**
6. Review the risk warning and select **I understand and want to continue**
7. Select **Create as a plugin** and sign in to AnythingMCP when asked

The plugin appears under your personal plugins ([chatgpt.com/plugins?view=personal](https://chatgpt.com/plugins?view=personal)). Install it there, and ChatGPT discovers the tools from your AnythingMCP instance.

---

## Step 4: Use Tools in Conversations

Once installed, type **@** in a chat, pick the plugin, and ask ChatGPT to use your MCP tools naturally:

- *"Use the CRM to look up customer John Smith"*
- *"Query the database for orders from last week"*
- *"Search our product catalog for wireless headphones"*

ChatGPT will call the appropriate MCP tool and show you the results.

---

## Authentication Options

| Method | Configuration |
|--------|--------------|
| **OAuth2** (recommended) | `MCP_AUTH_MODE=oauth2` or `both`; choose **OAuth** in ChatGPT's custom MCP server dialog |
| **Bearer Token** | Not supported by ChatGPT's dialog (no token field); use it from the Responses API or other MCP clients |
| **API Key** | Not supported by ChatGPT's dialog; use a per-user MCP API key from the Responses API (below) or other MCP clients |

### OpenAI Responses API

An agent built on the Responses API can reach an MCP server with a per-user MCP API key (`mcp_…`, generated on the server's page). Send it as `authorization`, which arrives as `Authorization: Bearer mcp_…`, or as an `X-API-Key` header:

```json
"tools": [
  {
    "type": "mcp",
    "server_label": "anythingmcp",
    "server_url": "https://cloud.anythingmcp.com/mcp/<server-id>",
    "authorization": "mcp_your_key",
    "require_approval": "never"
  }
]
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot connect to server" | Ensure your AnythingMCP URL is publicly accessible via HTTPS |
| "Authentication failed" | Check that `MCP_AUTH_MODE` is `oauth2` or `both` and that `SERVER_URL` is your public HTTPS URL |
| "No tools found" | Check that connectors and tools are configured in AnythingMCP |
| Timeout errors | Check that your reverse proxy doesn't have aggressive timeout settings; MCP uses long-lived connections |

---

## Security Considerations

When exposing AnythingMCP to the internet for ChatGPT:

1. **Always use HTTPS** — Never expose MCP over plain HTTP
2. **Use strong tokens** — Generate long, random Bearer Tokens
3. **Enable rate limiting** — Set `MCP_RATE_LIMIT_PER_MINUTE` in `.env`
4. **Use roles** — Create a restricted MCP role for ChatGPT with only the tools it needs
5. **Monitor audit logs** — Review tool invocations in the AnythingMCP audit log

---

[Back to README](../../README.md)
