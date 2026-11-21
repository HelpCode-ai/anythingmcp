# Loom (agent memory)

The Loom catalog preset connects AnythingMCP to your own
[Loom](https://github.com/ClickHouse/loom) deployment through the existing
[MCP bridge](mcp-bridge.md). It uses Streamable HTTP and discovers the tools
and schemas that your server publishes through `tools/list`.

## Install Loom first

Follow the [Loom quickstart](https://clickhouse.github.io/loom/getting-started/quickstart/)
to install and start your own server before adding this connector. The default
single-user setup listens on loopback; it does not provision a public HTTPS
endpoint. Configure authenticated access and the network route described below
before connecting AnythingMCP. The quickstart's development model is not a real
inference provider; configure model access separately when your workflow needs it.

## Setup

1. In Loom, open **Settings > Tokens > New token**. Create a dedicated token
   for this connector, restricted to the intended namespaces. Select the
   `viewer` role for read-only access; grant write roles only when you want
   the assistant to save or change memory. Avoid wildcard namespace scopes.
2. In AnythingMCP, open **Connectors > Store** and select **Loom (agent memory)**.
3. Set `LOOM_MCP_URL` to the complete HTTPS MCP endpoint, for example
   `https://loom.example.com/mcp`. Include any reverse-proxy path. Optional
   `toolset` and `schema_profile` query parameters are accepted. They select
   the listing and schema shape; the token's permissions govern access.
4. Set `LOOM_MCP_TOKEN` to the token alone, without `Bearer`. The bridge sends
   it in `Authorization: Bearer`. Never put credentials in the endpoint URL.
5. Install the connector and check the discovered tools. Click **Discover
   tools** after changing the deployment's toolset.

The catalog has a minimal fallback snapshot: `loom_activate`, which reads
Loom's session primer without arguments. Successful discovery replaces the
snapshot with the server's current tool list, including any write tools it
exposes. Use the scoped token to enforce read-only access.

## Cloud and self-hosted reachability

AnythingMCP Cloud requires a Loom endpoint reachable over public HTTPS. A
loopback-only Loom deployment works only with self-hosted AnythingMCP and an
appropriate network route. Inside an AnythingMCP container, `localhost`
refers to that container, not the machine running Loom. This preset requires
HTTPS in both modes. See the [MCP bridge guide](mcp-bridge.md) for network
configuration.

## Connector identity and verification

One connector uses one token. Every caller of that connector acts as the
same Loom identity. Use separate connectors with separate tokens for
different principals, and restrict access to each connector accordingly.

This preset has static checks; no live AnythingMCP-to-Loom connection has
been verified. Before relying on it, verify tool discovery, an allowed read,
and refusal outside the token's namespace scope. If writes are authorized,
also verify a permitted write and retrieval from a separate session.

The preset follows the released Loom 1.2.0
[MCP reference](https://github.com/ClickHouse/loom/blob/v1.2.0/docs/reference/mcp.md)
and [token guide](https://github.com/ClickHouse/loom/blob/v1.2.0/docs/guides/tokens-and-grants.md).
The bundled Loom mark is from that release under Apache-2.0; its source,
attribution and license accompany the asset in `loom.svg.LICENSE.txt`.
