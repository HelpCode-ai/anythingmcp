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
| **Restricted** | Only their own tool calls, the connectors their MCP roles reach, and the MCP servers that hold one of those connectors. |

Admins always see everything, in both modes. "Member" below means a VIEWER or
an EDITOR of the workspace. An EDITOR also keeps seeing what they own.

Cloud and self-hosted: identical, in every edition (Cloud plans, Community,
Enterprise). The setting is off (Open) by default; nothing changes for a
workspace until an admin switches it.

## What each mode shows

| Area | Open | Restricted, member |
|---|---|---|
| Audit log (`GET /api/audit/invocations`) | Every call of the workspace, with the caller and the full input and output | Only the calls the member made. Calls without a user (for example a static key) are hidden. The page says "You see your own calls. Workspace admins see all calls." |
| Analytics, stats, tool performance (`/api/audit/stats`, `/analytics`, `/breakdowns`, `/tool-performance`) | Workspace-wide numbers, including calls per user | The same numbers, counted over the member's own calls only. The "by user" panel is hidden; the API's `byUser` holds only the member's own row. |
| Connectors (`GET /api/connectors`, `/health-check`) | Every connector with all of its tools | Connectors the member owns, or that hold at least one tool their roles allow. On a connector they do not own, only the allowed tools are listed. |
| Connector and tool detail (`/api/connectors/:id`, its OAuth settings, per-user sign-in, webhook, tools, annotations, response mapping) | Any connector of the workspace | 404 for a connector the member cannot see, with the same body as an unknown id. A member cannot tell "hidden" from "does not exist". |
| Exports (`/api/connectors/export-all`, `/:id/export`) | Every connector, secrets masked unless admin | Only connectors the member owns; 404 for the others. |
| File Search (`/api/file-search/connectors/:id` and its tree, problems, runs, scans and access rules) | Any File Search connector of the workspace | 404 for a connector the member cannot see. |
| MCP servers (`GET /api/mcp-servers`, `/:id`, `/:id/activity`) | Every server, with the names of all its connectors | Servers the member owns, or that hold a connector they can see. Connector names and counts list only those connectors. 404 for the others. |
| Server picker (`GET /api/mcp-connections/targets`, the OAuth consent page) | Every active server of each workspace the user belongs to | Per workspace, by that workspace's own mode and the user's role there. A grant (`PUT /api/mcp-connections/:clientId`) drops a hidden server like an unknown id. |
| Members, invitations, roles, identity providers (`/api/users`, `/api/roles`, ...) | Admins only | Admins only (unchanged) |
| MCP endpoint (`/mcp`, `/mcp/<serverId>`) | Tools filtered by MCP roles | Unchanged: roles already decide what an AI client can list and call. |

Writes are not part of this setting. Changing or deleting a connector or a
server stays limited to its owner or an admin, in both modes.

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
- **A server's own activity.** For a server the member can see,
  `GET /api/mcp-servers/:id/activity` returns the server's two numbers (calls
  in the last 30 days, time of the last call), counted over all callers.
- **Other members' default servers.** Each invited member gets a server named
  `Default (<name>)`. In restricted mode it stays hidden unless it holds a
  connector the caller can see; then the caller sees it, and with it the
  member's name. To avoid this, put shared connectors on **team servers**
  (for example "Sales", "Finance") instead of on members' default servers.
- **The member's own calls**, with their full input and output. They made
  those calls.

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
