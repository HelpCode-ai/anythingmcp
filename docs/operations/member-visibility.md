# Member visibility

By default every member of a workspace sees every connector, every MCP server
and every tool call of that workspace in the dashboard and the REST API. In a
workspace with accounting, client or HR data that is often too much: a member
should see what their AI client can use, and their own calls, nothing more.

**Member visibility** is the switch for that. A workspace admin sets it under
**Settings → Organization → Security → Member visibility**:

| Mode | What a member who is not an admin sees |
|---|---|
| **Open** (default) | Everything in the workspace, as before this setting existed. |
| **Restricted** | Only their own tool calls, the connectors their MCP roles reach, and the MCP servers they own. Of a connector they do not own: its name, its status and the tools they may use, not its settings. Never another member's MCP server. |

Admins always see everything, in both modes. "Member" below means a VIEWER or
an EDITOR of the workspace. An EDITOR also keeps seeing what they own.

Cloud and self-hosted: identical, in every edition (Cloud plans, Community,
Enterprise). The setting is off (Open) by default; nothing changes for a
workspace until an admin switches it.

## What each mode shows

| Area | Open | Restricted, member |
|---|---|---|
| Audit log (`GET /api/audit/invocations`) | Every call of the workspace, with the caller and the full input and output | Only the calls the member made. Calls without a user (for example a static key) are hidden. A call made through an MCP server the member does not own keeps its content, but `mcpServer` and `mcpServerId` are null; `mcpServerId=` of such a server matches nothing. The page says "You see your own calls. Workspace admins see all calls." |
| Analytics, stats, tool performance (`/api/audit/stats`, `/analytics`, `/breakdowns`, `/tool-performance`) | Workspace-wide numbers, including calls per user and per server | The same numbers, counted over the member's own calls only. The "by user" panel is hidden; the API's `byUser` holds only the member's own row. Only the member's own servers are named: `byServer` counts calls through any other server in one row with `id: null` ("Other server or none"), and tool performance reports them with `mcpServerId: null`. |
| Connectors (`GET /api/connectors`, `/health-check`) | Every connector with all of its tools and settings | Connectors the member owns, or that hold at least one tool their roles allow. A connector they own comes back in full. One they do not own comes back in the [reduced view](#what-a-member-sees-of-a-shared-connector), with only the allowed tools. |
| Connector and tool detail (`/api/connectors/:id`, its per-user sign-in, tools) | Any connector of the workspace | 404 for a connector the member cannot see, with the same body as an unknown id. A member cannot tell "hidden" from "does not exist". A connector they can see but do not own comes back in the reduced view. On a connector they own, `mcpServers` lists only the servers they own. |
| Connector settings (`/api/connectors/:id/oauth-config`) | Any connector of the workspace | Only for a connector the member owns; 404 for the others, visible or not. |
| Owner-or-admin reads (`/api/connectors/:id/webhook/url`, `/webhook/events`, `/catalog-diff`, a tool's `/annotations` and `/response-mapping`) | Owner or admin only (403 for other members) | 404 for a connector the member cannot see, and for a tool outside their roles on a connector they do not own; otherwise as in Open. |
| Exports (`/api/connectors/export-all`, `/:id/export`) | Every connector, secrets masked unless admin | Only connectors the member owns; 404 for the others. |
| File Search (`/api/file-search/connectors/:id` and everything below it: overview, tree, problems, runs, scans, sync, schedule, description, access rules) | Any File Search connector of the workspace | 404 unless the member owns the connector, including a File Search connector shared with them through their roles: these routes show the source's address, every folder and file name and the role rules, more than the tools let their AI client read. They use the File Search tools instead. `capabilities` and `policy` (plan, limits, aggregate usage) are unchanged. |
| MCP servers (`GET /api/mcp-servers`, `/:id`, `/:id/activity`, and `PUT`/`DELETE` `/:id`, `PUT /:id/connectors`) | Every server, with the names of all its connectors | Only the servers the member owns, never another member's server, not even one holding a connector they can see. On their own servers, connector names and counts list only the connectors they can see. Every other server answers 404 with the body of an unknown id, on reads and writes. Assigning a connector they cannot see to their own server answers 404 like an unknown connector. |
| Server picker (`GET /api/mcp-connections/targets`, the OAuth consent page) | Every active server of each workspace the user belongs to | Per workspace, by that workspace's own mode and the user's role there: only their own servers, plus the whole-workspace choice. A grant (`PUT /api/mcp-connections/:clientId`) drops another member's server like an unknown id. The consent page does not name a requested server the user may not see. |
| Connections and keys (`GET /api/mcp-connections`, `GET`/`POST /api/mcp-keys`) | The user's own connections and keys | Still only their own. A server they do not own is left out of a connection's `servers` and is `null` as a key's `mcpServer`. Creating a key for such a server answers 404, like an unknown server. |
| Knowledge graph and skills (`GET /api/knowledge-graph`, `/skills`, `/skills/:id/versions`), learning projects (`/api/learning/projects`, `/:id`, `/:id/lessons`, lessons, topic preview and publish) | Admins and editors | Admins only: 403 for editors. These answers are other members' work (skills and lessons learned from their requests, the graph of every connector). A member's own learning projects (`/api/learning/me`) and their own learning setting are unchanged. |
| Plan fit (`GET /api/license/plan-fit`, Cloud) | Any member | Admins only (403): it names every connector and MCP server of the workspace. |
| Catalog (`/api/adapters/popular-connectors`, `/starter-pack`) | `installed` for every connector of the workspace | `installed` only for connectors the member can see. |
| Members, invitations, roles, identity providers (`/api/users`, `/api/roles`, ...) | Admins only | Admins only (unchanged) |
| MCP endpoint (`/mcp`, `/mcp/<serverId>`) | Tools filtered by MCP roles | Unchanged: roles already decide what an AI client can list and call. The server links the workspace connection hands to the model (`anythingmcp_get_configuration_url`) list only the member's own servers. |

Writes keep their rules: changing or deleting a connector or a server stays
limited to its owner or an admin, in both modes. In restricted mode a server
the member does not own answers 404 before that rule could answer 403. The
dashboard shows Edit, Test, Variables, Delete and the other controls that
change a connector only to its owner and to admins, in both modes. Testing new
values for an existing connector (`POST /api/adapters/:slug/verify` with
`connectorId`) runs with that connector's stored credentials, so it is
limited to its owner or an admin as well, in both modes (404 for anyone else).

### What a member sees of a shared connector

In restricted mode, a connector a member can see but does not own is returned
in a **reduced view**. It says that the connector exists, whether it works and
which tools the member may use. It says nothing about where the connector
connects or how.

| | Fields |
|---|---|
| Connector | `id`, `name`, `type`, `icon`, `isActive`, `credentialScope`, `setupStatus`, `authStatus`, `authStatusCode`, and `memberView: true` |
| Each allowed tool | `id`, `name`, `description`, `isEnabled` |

Everything else is left out: the address (`baseUrl`, which for a database
holds host, port, database and user name), `specUrl`, `config`, variables
(`envVars`, also the ones that are not secret), `headers`, `instructions`, the
auth type, the names of missing variables, the provider's message about a
refused credential, webhook settings, the MCP servers of the connector, and on
each tool the parameters, the endpoint mapping (for a database tool: its SQL),
the response mapping and the output schema. The list of fields is an
allowlist: a field added to connectors later stays out until it is added to
the list on purpose.

`memberView: true` marks the reduced view, so a client can tell it from a
connector whose settings are empty. The same view is returned by
`GET /api/connectors`, `GET /api/connectors/:id` and, for the tools,
`GET /api/connectors/:id/tools`. In `GET /api/connectors/health-check` such a
connector keeps its status and latency; its `message` is a fixed sentence per
status instead of the provider's answer, which can name a host or a database.

In the dashboard the connector's card shows name, type, number of tools and
status. Its page shows a note "Shared with you", the tools by name and
description and, for a connector with per-user sign-in, **Connect my
account**. There is no address, no settings card and nothing to edit.

Not reduced: a connector the member owns, anything an admin reads, and every
answer in Open mode. A member's AI client is not affected either: on the MCP
endpoint it gets the allowed tools with their parameters, as before.

File Search connectors: the reduced view applies to the connector itself, and
the dashboard does not show its Files panel in the reduced view. The File
Search endpoints (`/api/file-search/connectors/:id` and below) answer 404 for
every File Search connector the member does not own, as in the table above.

A restricted member who sees no connector or server gets "Nothing has been
shared with you yet. Ask a workspace admin for a role." on the Connectors and
MCP Servers pages, and is not sent into the setup wizard (`/welcome`).

### VIEWERs cannot create MCP servers

A VIEWER cannot create an MCP server in any mode: `POST /api/mcp-servers`
answers 403, like every other write a VIEWER tries. The dashboard does not
offer "Create server", "Add connector" or "Import" to a VIEWER. The default
server a member gets at invite time is created by the system and is not
affected.

## What stays visible

Restricted mode hides identities and content, not every number:

- **Aggregate counts.** `GET /api/license/usage` keeps returning the
  workspace's number of connectors, servers and users. These carry no identity.
- **Their own servers' activity.** For a server the member owns,
  `GET /api/mcp-servers/:id/activity` and the list's `usage` return the
  server's two numbers (calls in the last 30 days, time of the last call),
  counted over all callers.
- **The member's own calls**, with their full input and output. They made
  those calls, including through a server they do not own (that server is not
  named).

## How a restricted member connects their AI client

A restricted member never sees another member's MCP server, so team servers
(for example "Sales", "Finance") and other members' `Default (<name>)` servers
are not listed to them and cannot be picked when they connect. They connect
in one of two ways:

- **The workspace connection** (the shared `/mcp` endpoint, "Everything in
  this workspace" on the consent page): every tool their roles allow, from
  every connector, with no server to pick. When their own server is the only
  one on offer, the consent page grants the workspace connection without
  asking.
- **Their own server**, typically the `Default (<name>)` server every invited
  member gets. An admin can put shared connectors on it; the member then sees
  those connectors on it as far as their roles reach.

Connections made before the workspace was switched to restricted keep working:
the MCP endpoint is unchanged and roles still decide the tools. The dashboard
just no longer names a server the member does not own.

## Set it up with roles and SSO group mapping

Restricted mode reuses the MCP roles that already decide which tools an AI
client can call. A member sees a connector when their roles allow at least one
of its tools. So set up the roles first, then switch the mode:

1. **Create roles with tool lists.** Under **Settings → Roles**, create one
   role per team (for example "Sales", "Accounting") and give each the tools
   that team may use. See the [API reference](../api-reference.md#roles--access-control).
2. **Make members Viewer** (or Editor if they create connectors themselves)
   under **Settings → Users**. Admins are never restricted, so keep the admin
   role for the people who manage the workspace.
3. **Assign the roles.** By hand under **Settings → Users**, or from your
   directory: map SSO groups to MCP roles under **Settings → Single sign-on →
   Role mappings** ([SSO guide](../sso.md#3-map-directory-groups-to-roles)).
   Set the workspace role of those mappings to Viewer as well.
4. **Switch to Restricted** under **Settings → Organization → Security →
   Member visibility**, and save.

If no role in the workspace has a tool list yet, roles narrow nothing: every
member may call every tool, so in restricted mode they still see every
connector (only their calls are narrowed to their own). The settings page
warns about this and links to **Settings → Roles**.

Once any role in the workspace has a tool list, a member with **no** role gets
no tools on the MCP endpoint, and so sees only the connectors they own in
restricted mode.

## Route decisions (for contributors)

Every HTTP route of the API has a written member-visibility decision in
`packages/backend/src/settings/member-visibility.routes.ts`: narrowed by
member visibility (`scoped`), refused to restricted members
(`admin-when-restricted`, enforced by `MemberVisibilityInterceptor`),
admin-only, owner-or-admin, the caller's own data, governed by its own access
model, workspace settings and aggregate counts, not reached with a member's
session (public, token or provider routes), or the MCP endpoint (roles).
`member-visibility.routes.spec.ts` reads every controller through Nest's
route metadata and fails when a route has no decision, so a new route that
returns workspace data cannot reach a restricted member unnoticed. Add the
decision when you add the route.

## Propagation

The mode is kept in memory for **30 seconds** per server process. After an
admin switches it, members can see the old view for up to 30 seconds. Role
changes are not cached: a new or removed role applies to the next request.

Each change writes a `MEMBER_VISIBILITY_CHANGED` security event with the old
and new mode.

## API and CLI

Any member can read the mode, and whether it narrows their own view:

```bash
amcp api GET /api/settings/member-visibility
# {"mode":"restricted","restrictedForMe":true}
```

An admin sets it (`open` or `restricted`). A read-only (`MANAGEMENT_READ`)
API key gets 403:

```bash
amcp api PUT /api/admin/settings/member-visibility --data '{"mode":"restricted"}' --yes
```

A management API key carries its owner's role, so a key of a restricted member
sees what that member sees.

## Turning it off

Set the mode back to **Open**. It applies within 30 seconds. No data is
changed or deleted by either mode.
