# MCP resources

Besides tools, every per-server MCP endpoint (`/mcp/<serverId>`) serves
**resources**: read-only text a client can attach to the model's context
(`resources/list`, `resources/read`). They carry content that is not an action,
such as a connector's setup notes, so it no longer has to be squeezed into a
tool.

Resources are only served on per-server endpoints. The shared `/mcp` endpoint
and the public `/mcp/demo` server publish none.

- [What is published](#what-is-published)
- [Who sees what](#who-sees-what)
- [Stored resources](#stored-resources)
- [Duplicate URIs](#duplicate-uris)
- [Stateful sessions](#stateful-sessions)

## What is published

| URI | Content | When |
|-----|---------|------|
| `anythingmcp://server/<serverId>/instructions` | The server's composed instructions: its own instructions, then the instructions of each connector you can use, then the applied workspace skills. Identical to the `instructions` field of the `initialize` response. | The composed text is not empty. |
| `anythingmcp://server/<serverId>/connector/<connectorId>/instructions` | One connector's own setup and usage instructions (the **Instructions** field of the connector). | One per connector you can use that has instructions. |
| `anythingmcp://server/<serverId>/knowledge-graph` | The knowledge graph of the connectors you can use. See [Knowledge Graph](./knowledge-graph.md). | The graph is enabled for the workspace. |
| The row's own URI | A stored resource of a connector you can use (see below). | One per stored row. |

The `anythingmcp:` scheme is reserved for the resources above. All of them are
served as `text/markdown`.

## Who sees what

Resources follow the tool list exactly. The tools a caller gets are filtered
twice: first to the connectors assigned to the server, then to the tools the
caller's MCP role allows. A connector contributes resources only when at least
one of its tools survives **both** filters for this caller. The connector set is
computed once, from the same tool set that builds the tool list, and every
connector-scoped surface uses it: the `initialize` instructions, the
connector-scoped skills in them, the resources and the knowledge graph.

A caller whose role grants no tool of connector X:

- does not see X's section in the `initialize` instructions, nor skills scoped
  to X;
- does not see X's instructions resource or any stored resource of X in
  `resources/list`;
- gets **not found** from `resources/read` of any of X's URIs, the same answer
  as for a URI that never existed. The endpoint never says "forbidden", so it
  cannot be used to learn whether a connector or resource exists.

A caller the roles do not restrict (an admin, a member with no MCP role in a
workspace that uses no tool whitelists, an instance-level credential) sees every
assigned connector, exactly as before.

Everything is also scoped to the server's organization and fails closed. A URI
that names a connector of another organization, or of another server, is not
found. The organization and the server assignment are re-checked in the
database queries themselves, independently of the connector ids passed in.

## Stored resources

Connectors can own stored resource rows (`mcp_resources`: `uri`, `name`,
`description`, `mimeType`, `fetchConfig`). Only static text is ever served:

- If `fetchConfig.text` is a string, that string is the content. Otherwise, if
  `fetchConfig.content` is a string, that string is.
- Anything else, including a `url` to fetch or a `data` object, is served as a
  fixed placeholder text (`text/plain`). AnythingMCP never fetches a remote URL
  for a resource and never serializes a stored object, because those objects can
  hold credentials.
- A row whose URI is not a valid URI, or uses the reserved `anythingmcp:`
  scheme, is skipped.
- A `mimeType` that is not a plain `type/subtype` is served as `text/plain`.

## Duplicate URIs

When two resources the caller can see would be published under the same URI
(after URI normalization, e.g. `CRM://schema` and `crm://schema`), neither is
published: the URI is listed nowhere and reading it answers "not found". A
warning naming the URI is logged. Silently picking one would let one
connector's content stand in for another's.

Duplicates are judged among what the caller can see: if one of the two claimants
belongs to a connector the caller's role denies, the other is served normally.

## Stateful sessions

Like the tool list, the resource set and the `initialize` instructions are
computed when the MCP server for a request is built: on every request in the
default stateless mode, and once at session creation when
`MCP_STATEFUL_SESSIONS=true`. A live stateful session keeps that snapshot until
the client re-initializes. Connector reloads and assignment changes reconcile a
live session's **tools**, not its resources or instructions.
