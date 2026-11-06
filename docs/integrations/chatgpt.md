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

## The fixed plugin endpoint: `/mcp/chatgpt-app`

`https://<your-host>/mcp/chatgpt-app` serves one fixed set of tools, the same for every user. It is the endpoint of the [AnythingMCP plugin in OpenAI's plugin directory](https://chatgpt.com/plugins/plugin_asdk_app_6ade03541ce08191b35bbad1dc5b4121) (on AnythingMCP Cloud), whose guidelines require every operation to be its own tool. It does not run your connectors' own tools; use `/mcp/<server-id>` (or `/mcp`) for that.

| Tool | What it does |
|------|--------------|
| `anythingmcp_list_connectors` | Connectors the connection reaches, their type and setup state |
| `anythingmcp_list_databases` | Databases that can be queried, with their engine |
| `anythingmcp_get_database_schema` | Tables and columns of one database |
| `anythingmcp_get_query_examples` | Example queries in the database's dialect |
| `anythingmcp_query_database` | One read-only query (SQL `SELECT`, or a MongoDB find) |
| `anythingmcp_get_connector_activity` | Calls and failures per connector, counts only |
| `anythingmcp_get_workspace_guide` | The workspace's notes on its connectors |
| `anythingmcp_get_configuration_url` | Link to the dashboard |

Only database connectors set to **read-only** are queried; a connector with write access is listed as not queryable. Sign-in, the server or workspace picker, MCP roles and the audit log work as on `/mcp`. The endpoint behaves the same on Cloud and on a self-hosted instance, and needs a signed-in user (OAuth or a per-user MCP API key), not the static `MCP_API_KEY` / `MCP_BEARER_TOKEN`.

---

## The File Search plugin endpoint: `/mcp/file-search`

`https://<your-host>/mcp/file-search` serves the File Search plugin ("SFTP & NAS Search by Helpcode" in OpenAI's plugin directory). Like `/mcp/chatgpt-app`, it has one fixed set of tools, the same for every user, and each tool is one operation. It only reaches the workspace's File Search folders; catalog connectors, databases and the File Share connector are not served here.

| Tool | What it does |
|------|--------------|
| `list_file_sources` | The connected folders: protocol, content summary, indexed files, last sync, the admin's notes |
| `search_documents` | Full-text search over the documents, with the best page and a snippet; every folder when no `source` is given |
| `find_files` | Files by name or glob pattern |
| `list_folder` | One folder's subfolders and files |
| `read_document` | The text of one file, whole or by pages |
| `find_exact_text` | Exact codes, numbers and phrases with their lines (whole rows in spreadsheets) |
| `view_document_page` | One PDF page or an image as a picture |
| `get_file_link` | The original file as a 24-hour link for members of the workspace |

Every tool is read-only except `get_file_link`, which stores a members-only link. With more than one folder connected, the tools that take a path need `source` (the id or name `list_file_sources` returns). Roles, folder rules per role and the audit log work as on `/mcp`. When no folder is connected, the tools answer with the link to the File Search wizard instead.

### Folder setup while connecting

When ChatGPT asks for `/mcp/file-search` (its OAuth `resource`), a workspace admin whose workspace has no File Search folder yet sees one more page after **Approve**: how to reach the folder (SFTP, FTPS, FTP, WebDAV, Nextcloud, ownCloud, Synology, QNAP, FRITZ!Box, Hetzner Storage Box, S3-compatible storage, and on a self-hosted instance a mounted network folder). Each choice opens the File Search wizard in the dashboard, signed in on the workspace the connection was granted, with that protocol preselected and the granted MCP servers ticked. When the folder is activated, the wizard returns to the authorization and the browser goes back to ChatGPT. **Skip** goes back at once. Passwords and keys are entered in the wizard, never in the chat.

Editors, viewers and workspaces that already have a folder go straight back to ChatGPT. The page and the endpoint behave the same on Cloud and on a self-hosted instance; on a self-hosted Community edition, File Search itself needs its trial or a licence, which the wizard explains. Other clients and endpoints keep their pages: the first-connector page after **Approve** (Cloud) is unchanged for them.

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
