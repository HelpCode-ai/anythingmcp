The connector needs two values:

| Variable | Where to find it |
|---|---|
| `SPLUNK_HOST` | The search head's host name, without `https://` and without a port, for example `yourstack.splunkcloud.com` |
| `SPLUNK_MCP_TOKEN` | Splunk MCP Server app → generate an **encrypted MCP token** for the user the AI acts as (shown once) |

Before generating the token, a Splunk admin installs the Splunk MCP Server app (Splunkbase 7931), enables token authentication and gives that user's role the `mcp_tool_execute` capability. The token is sent as `Authorization: Bearer <token>` to `https://SPLUNK_HOST:8089/services/mcp`. At install, AnythingMCP lists the server's tools with it and then stores it encrypted.
