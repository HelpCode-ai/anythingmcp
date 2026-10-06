# Connect AnythingMCP to Meta Muse

> Setup guide for using AnythingMCP tools in Meta Muse, Meta's personal AI agent.

[Back to README](../../README.md)

---

## Overview

Meta Muse can use remote MCP servers as custom connectors. Add an AnythingMCP server to Muse and it can call the tools of the connectors assigned to that server: your ERP, shop, database or any API you connected.

Muse signs in to AnythingMCP with OAuth 2.0. You don't need an API key or a token.

Muse is currently available in the US and Canada only. Meta does not review custom connectors: you decide which servers Muse may reach, and you can disconnect one any time in Muse under **Settings → Connectors**.

---

## Prerequisites

- An AnythingMCP MCP server with at least one connector assigned. [AnythingMCP Cloud](https://cloud.anythingmcp.com) works out of the box.
- A self-hosted instance works too, if it is reachable on a **public HTTPS URL** with `MCP_AUTH_MODE=oauth2` or `both`. Muse connects from Meta's servers, so a `localhost` URL will not work. See the [Deployment Guide](../deployment.md).

---

## Step 1: Copy the MCP endpoint URL

In AnythingMCP, open **MCP Servers**, pick the server and copy its **MCP endpoint**:

```
https://cloud.anythingmcp.com/mcp/<server-id>
```

The **Meta Muse** button in the server's Quick Connect panel shows the same URL with these steps, and the chat prompt below with the URL filled in.

---

## Step 2: Add a custom connector in Muse

1. In Meta Muse, open **Settings → Connectors**.
2. Click **Add custom connector**.
3. Paste the MCP endpoint URL from step 1.

### Alternative: ask Muse in a chat

This is Meta's documented way, and it works on the web, iOS, Android and WhatsApp. Send Muse this message, with your server's URL:

```
Create a Custom Connector for a new remote MCP server, then connect to it:
Name: AnythingMCP
Transport: remote streamable HTTP
URL: https://cloud.anythingmcp.com/mcp/<server-id>
Auth: OAuth
```

---

## Step 3: Sign in to AnythingMCP

Muse opens the AnythingMCP sign-in page. Sign in (or create an account) and approve access. Muse then loads the tools of the server.

---

## Step 4: Use the tools

Ask Muse for something one of your connectors can answer, for example:

- *"Which orders from last week are still open?"*
- *"Look up the customer Acme GmbH in the CRM"*
- *"What's the stock level of article 4711?"*

Muse calls the matching AnythingMCP tool and answers from the result. Every call shows up in the AnythingMCP audit log.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Muse cannot reach the server | Check the URL ends in `/mcp/<server-id>`; a self-hosted instance needs a public HTTPS URL |
| "No tools" | Assign connectors to the MCP server and check that their tools are enabled |
| Tools added later don't show up | Muse loads the tool list when it connects. Remove and add the connector again, or reconnect it |

---

## Security Considerations

1. **One server per purpose.** Give Muse a server that carries only the connectors it needs.
2. **Use roles.** Restrict which tools the connection may call, and keep write tools off where you only need reads.
3. **Revoke when done.** Disconnect the connector in Muse under **Settings → Connectors**, and under **Settings → Connections** in AnythingMCP see and revoke what each client may reach.
4. **Monitor audit logs.** Review tool invocations in the AnythingMCP audit log.

---

[Back to README](../../README.md)
