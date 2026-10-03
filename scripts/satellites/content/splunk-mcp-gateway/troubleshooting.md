| Symptom | Cause and fix |
|---|---|
| `403` with "invalid token audience" | The token is an ordinary Splunk user or service token. Generate an encrypted token in the Splunk MCP Server app instead. |
| `403` on every tool | The user's role lacks `mcp_tool_execute`, or an admin disabled the tool in the app. |
| Install times out | Port 8089 is not reachable from AnythingMCP. On Splunk Cloud Platform add the calling address to the search API allow list (Admin Config Service); on Splunk Enterprise open the firewall. |
| TLS or certificate error | Splunk Enterprise still serves its default self-signed certificate on 8089. Install a certificate the AnythingMCP server trusts. |
| A tool is missing | Your app version does not have it, or it is switched off. Upgrade the app, then click **Discover tools** on the connector, and check the tool's toggle. |
| Searches return too much or time out | Give every search a time range (`earliest`, `latest`) and a row limit, and narrow the index. |
