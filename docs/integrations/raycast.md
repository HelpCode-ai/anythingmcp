# Connect AnythingMCP to Raycast

> Setup guide for using AnythingMCP tools in Raycast AI on macOS, Windows and iOS.

[Back to README](../../README.md)

---

## Overview

Raycast AI can use remote MCP servers. Add AnythingMCP once and you can mention it in AI Chat or Quick AI (`@anythingmcp …`) to reach the tools of every connector on that server: your ERP, shop, CRM, database or any API you connected.

Raycast signs in to AnythingMCP with OAuth 2.0 (Dynamic Client Registration with PKCE). You don't need an API key.

MCP is part of Raycast AI, which needs a **Raycast Pro** subscription. The free plan has no AI features.

---

## Prerequisites

- Raycast with a Pro subscription, signed in.
- An AnythingMCP account with at least one connector. [AnythingMCP Cloud](https://cloud.anythingmcp.com) works out of the box.
- A self-hosted instance works too, with `MCP_AUTH_MODE=oauth2` or `both`. Raycast connects from your own machine, so a `localhost` URL works on that machine. With `MCP_AUTH_MODE=legacy`, use an API key (see below).

---

## Step 1: Pick the URL

| URL | What Raycast gets |
|---|---|
| `https://cloud.anythingmcp.com/mcp` | The shared endpoint. During sign-in you choose which of your MCP servers Raycast may reach. |
| `https://cloud.anythingmcp.com/mcp/<server-id>` | One server only. The **Raycast** button in the server's Quick Connect panel shows this URL with the steps below. |

Self-hosted: replace `https://cloud.anythingmcp.com` with your instance's base URL.

---

## Step 2: Install the server in Raycast

1. Open Raycast and run **Install MCP Server**.
2. **Name**: `AnythingMCP`. This is the name you mention with `@` later.
3. **Transport**: **HTTP**.
4. **URL**: the URL from step 1.
5. Press **Install MCP Server** (⌘↵).

---

## Step 3: Sign in

Select **Sign In**. Raycast opens the AnythingMCP sign-in page in your browser. Sign in (or create an account) and approve access. On the shared `/mcp` URL you also choose the servers Raycast may reach. Raycast stores the token encrypted, per server.

---

## Step 4: Use the tools

In AI Chat or Quick AI, type `@anythingmcp` followed by your question, for example:

- *"@anythingmcp which orders from last week are still unpaid?"*
- *"@anythingmcp find the HubSpot contact for acme.com and show the open deals"*
- *"@anythingmcp what's the stock level of article 4711?"*

Raycast also adds an **Ask AnythingMCP** command to Root Search.

Raycast runs tools marked read-only without asking and asks before the others. AnythingMCP marks `anythingmcp_run_read_tool` read-only and `anythingmcp_run_write_tool` as a write tool, so Raycast asks before anything is created, changed, deleted or sent, and the tool's own instructions tell the model to confirm with you first.

Every call shows up in the AnythingMCP audit log.

---

## API key instead of OAuth

If your instance runs with `MCP_AUTH_MODE=legacy`, or you prefer a key: create an MCP API key in AnythingMCP and add this header in the server's **HTTP Headers** field in Raycast, then skip the sign-in:

```
Authorization: Bearer mcp_…
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No AI Chat or **Install MCP Server** command | Raycast AI needs Raycast Pro |
| `401 Unauthorized` | Sign in again: **Manage MCP Servers** → select the server → **Logout Server**, then **Sign In**. With an API key, check the header and that the key is not revoked |
| **Sign In** fails on a self-hosted instance | Set `MCP_AUTH_MODE` to `oauth2` or `both`, or use an API key |
| "No tools" | Assign connectors to the MCP server, or choose more servers during sign-in |

---

[Back to README](../../README.md)
