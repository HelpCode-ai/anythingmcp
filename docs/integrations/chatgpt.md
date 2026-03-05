# Connect AnythingMCP to ChatGPT

> Setup guide for using AnythingMCP tools with ChatGPT.

[Back to README](../../README.md)

---

## Overview

ChatGPT supports MCP server connections, allowing you to use your AnythingMCP tools directly in ChatGPT conversations. This works with ChatGPT Plus, Team, and Enterprise plans.

---

## Prerequisites

- **ChatGPT Plus**, **Team**, or **Enterprise** plan
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

Set the appropriate auth mode in your `.env`:

```env
MCP_AUTH_MODE=legacy    # or 'both' for OAuth2 + legacy
MCP_BEARER_TOKEN=your-secure-token
```

---

## Step 3: Add MCP Server in ChatGPT

1. Open **ChatGPT** in your browser
2. Click on your **profile icon** > **Settings**
3. Navigate to the **MCP Servers** or **Connected Tools** section
4. Click **Add MCP Server**
5. Enter:
   - **Server URL**: `https://mcp.yourdomain.com/mcp`
   - **Authentication**: Bearer Token
   - **Token**: Your `MCP_BEARER_TOKEN` value
6. Click **Connect**

ChatGPT will discover and list all available tools from your AnythingMCP instance.

---

## Step 4: Use Tools in Conversations

Once connected, you can ask ChatGPT to use your MCP tools naturally:

- *"Use the CRM to look up customer John Smith"*
- *"Query the database for orders from last week"*
- *"Search our product catalog for wireless headphones"*

ChatGPT will call the appropriate MCP tool and show you the results.

---

## Authentication Options

| Method | Configuration |
|--------|--------------|
| **Bearer Token** | Set `MCP_BEARER_TOKEN` in `.env`, provide token in ChatGPT settings |
| **API Key** | Generate an MCP API Key in AnythingMCP UI, provide in ChatGPT settings |
| **OAuth2** | Configure OAuth2 in AnythingMCP, use ChatGPT's OAuth integration |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot connect to server" | Ensure your AnythingMCP URL is publicly accessible via HTTPS |
| "Authentication failed" | Verify your token matches `MCP_BEARER_TOKEN` in `.env` |
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
