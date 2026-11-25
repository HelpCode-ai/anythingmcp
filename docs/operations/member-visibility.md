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
| **Restricted** | Only their own tool calls, the connectors their MCP roles reach, and the MCP servers they own. Of a connector they do not own: its name, its status and the tools they may use, not its settings. Never another member's MCP server. The dashboard lists only the pages they can use ([navigation](#what-a-restricted-member-sees-in-the-navigation)). |

Admins always see everything, in both modes. "Member" below means a VIEWER or
an EDITOR of the workspace. An EDITOR also keeps seeing the connectors they
own, in full, to manage them. A VIEWER does not: a viewer can own connectors
only from an earlier role (an admin or editor who was made a viewer), can
change none of them, and their AI client calls only what their roles allow.
In restricted mode a VIEWER therefore sees exactly the connectors their roles
reach, the same set the **Settings → Roles** assignment table counts for them,
and a connector they own comes back in the reduced view like any other.

Cloud and self-hosted: identical, in every edition (Cloud plans, Community,
Enterprise). The setting is off (Open) by default; nothing changes for a
workspace until an admin switches it.

## What each mode shows

| Area | Open | Restricted, member |
|---|---|---|
| Audit log (`GET /api/audit/invocations`) | Every call of the workspace, with the caller and the full input and output | Only the calls the member made. Calls without a user (for example a static key) are hidden. A call made through an MCP server the member does not own keeps its content, but `mcpServer` and `mcpServerId` are null; `mcpServerId=` of such a server matches nothing. The page says "You see your own calls. Workspace admins see all calls." The error text of a failed call (`error`) on a connector the member reads in the reduced view is replaced: see [error text of a call](#error-text-of-a-call). |
| Analytics, stats, tool performance (`/api/audit/stats`, `/analytics`, `/breakdowns`, `/tool-performance`) | Workspace-wide numbers, including calls per user and per server | The same numbers, counted over the member's own calls only. The "by user" panel is hidden; the API's `byUser` holds only the member's own row. Only the member's own servers are named: `byServer` counts calls through any other server in one row with `id: null` ("Other server or none"), and tool performance reports them with `mcpServerId: null`. `lastError` of tool performance follows the same rule as the audit log's `error`. |
| Connectors (`GET /api/connectors`, `/health-check`) | Every connector with all of its tools and settings | Connectors that hold at least one tool the member's roles allow, plus, for an EDITOR, the connectors they own. A connector an EDITOR owns comes back in full. One they do not own comes back in the [reduced view](#what-a-member-sees-of-a-shared-connector), with only the allowed tools. |
| Connector and tool detail (`/api/connectors/:id`, its per-user sign-in, tools) | Any connector of the workspace | 404 for a connector the member cannot see, with the same body as an unknown id. A member cannot tell "hidden" from "does not exist". A connector they can see but do not own comes back in the reduced view. On a connector they own, `mcpServers` lists only the servers they own. |
| Connector settings (`/api/connectors/:id/oauth-config`) | Any connector of the workspace | Only for a connector the member owns; 404 for the others, visible or not. |
| Owner-or-admin reads (`/api/connectors/:id/webhook/url`, `/webhook/events`, `/catalog-diff`, a tool's `/annotations` and `/response-mapping`) and the connection test (`POST /api/connectors/:id/test`) | Owner or admin only (403 for other members) | 404 for a connector the member cannot see, and for a tool outside their roles on a connector they do not own; otherwise as in Open. |
| Exports (`/api/connectors/export-all`, `/:id/export`) | Every connector, secrets masked unless admin | Only connectors an EDITOR owns; nothing for a VIEWER; 404 for the others. |
| File Search (`/api/file-search/connectors/:id` and everything below it: overview, tree, problems, runs, scans, sync, schedule, description, access rules) | Any File Search connector of the workspace | 404 unless the member is an EDITOR who owns the connector, including a File Search connector shared with them through their roles: these routes show the source's address, every folder and file name and the role rules, more than the tools let their AI client read. They use the File Search tools instead. `capabilities` and `policy` (plan, limits, aggregate usage) are unchanged. |
| MCP servers (`GET /api/mcp-servers`, `/:id`, `/:id/activity`, and `PUT`/`DELETE` `/:id`, `PUT /:id/connectors`) | Every server, with the names of all its connectors | Only the servers the member owns, never another member's server, not even one holding a connector they can see. On their own servers, connector names and counts list only the connectors they can see. Every other server answers 404 with the body of an unknown id, on reads and writes. Assigning a connector they cannot see to their own server answers 404 like an unknown connector. |
| Server picker (`GET /api/mcp-connections/targets`, the OAuth consent page) | Every active server of each workspace the user belongs to | Per workspace, by that workspace's own mode and the user's role there: only their own servers, plus the whole-workspace choice. A grant (`PUT /api/mcp-connections/:clientId`) drops another member's server like an unknown id. The consent page does not name a requested server the user may not see. |
| Connections and keys (`GET /api/mcp-connections`, `GET`/`POST /api/mcp-keys`) | The user's own connections and keys | Still only their own. A server they do not own is left out of a connection's `servers` and is `null` as a key's `mcpServer`. Creating a key for such a server answers 404, like an unknown server. |
| Knowledge graph and skills (`GET /api/knowledge-graph`, `/skills`, `/skills/:id/versions`), learning projects (`/api/learning/projects`, `/:id`, `/:id/lessons`, lessons, topic preview and publish) | Admins and editors | Admins only: 403 for editors. These answers are other members' work (skills and lessons learned from their requests, the graph of every connector). A member's own learning projects (`/api/learning/me`) and their own learning setting are unchanged. |
| Plan fit (`GET /api/license/plan-fit`, Cloud) | Any member | Admins only (403): it names every connector and MCP server of the workspace. |
| Catalog (`/api/adapters/popular-connectors`, `/starter-pack`) | `installed` for every connector of the workspace | `installed` only for connectors the member can see. |
| Members, invitations, roles, identity providers (`/api/users`, `/api/roles`, ...) | Admins only | Admins only (unchanged) |
| MCP endpoint (`/mcp`, `/mcp/<serverId>`) | Tools filtered by MCP roles | Unchanged: roles already decide what an AI client can list and call. The server links the workspace connection hands to the model (`anythingmcp_get_configuration_url`) list only the member's own servers. |
| Tool names inside tools (`kg_how_to_obtain`, the knowledge-graph resource, `amcp.search` in code mode) | Every tool of the connectors in reach | Only the tools the member's roles allow, in both modes whenever roles limit tools: a connector is in reach with one allowed tool, and these answers named all of its tools. An entity only denied tools reach is left out. |
| Connector status in the chat (`setup_get_status` on the workspace connection, EDITOR and ADMIN) | Up to 50 connectors of the workspace, with links to finish or fix a setup and the provider's last error | The connectors the member can see. One they own: as in Open. One shared with them: its name and status only, no link and no error text. |

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

Not reduced: a connector an EDITOR owns, anything an admin reads, and every
answer in Open mode. A member's AI client is not affected either: on the MCP
endpoint it gets the allowed tools with their parameters, as before.

File Search connectors: the reduced view applies to the connector itself, and
the dashboard does not show its Files panel in the reduced view. The File
Search endpoints (`/api/file-search/connectors/:id` and below) answer 404 for
every File Search connector the member does not own, as in the table above.

A restricted member who sees no connector or server gets "Nothing has been
shared with you yet. Ask a workspace admin for a role." on the Connectors and
MCP Servers pages, and is not sent into the setup wizard (`/welcome`).

### What a restricted member sees in the navigation

In restricted mode the sidebar, the settings navigation and the command
palette list only the pages a member can use. A page that is not listed does
not open either: typing its URL, a bookmark or a link from a colleague ends on
the **Connectors** list with the note "This page is not available to you". The
page is not drawn first and none of its requests is sent.

| Page | VIEWER | EDITOR |
|---|---|---|
| Dashboard, Analytics, Audit Log, Connectors (and a connector they can see) | Yes | Yes |
| Marketplace, New connector, guided connector setup | No | Yes: an EDITOR creates connectors |
| MCP Servers | Only when they own a server (every invited member gets `Default (<name>)`) | Yes: an EDITOR creates servers |
| Memory | Only where Memory is licensed and their memory access is not "none" | The same; an EDITOR also curates the company memory |
| Knowledge Graph, AI Skills, Learning projects | No | No: other members' work, admins only |
| Setup & onboarding (`/welcome`) | No | No: it sets up a workspace |
| Settings: Profile, Connections, General (Organization), File Share | Yes | Yes |
| Settings: Users, Roles, Single sign-on, License, Administration | No | No (admins only, as in Open) |

On **Settings → Organization** a restricted member sees the workspace name,
their role and their workspaces, not the feature switches.

Two pages are refused by what they are asked for, not by their address: the
page of an MCP server that is not the member's (`/mcp-server/<id>`) sends them
back to their own list, and a File Search hand-off that cannot be opened
(`/setup/file-search`) sends a member who may not set up a connector to their
connectors, both with the same note.

Admins see every page in both modes. In an Open workspace nothing changes for
anyone: every entry is listed, and a page for admins shows its "Access Denied"
panel to a member, as before.

The rules live in one place, `packages/frontend/src/lib/member-access.ts`. The
navigation is a convenience, not the access control: the API refuses what a
member may not read whatever the dashboard shows.

So that a restricted member does not see an admin's navigation for a moment
on every page load, the dashboard sets a cookie `amcp_nav=restricted` in the
browser of a restricted member, and the server renders their first HTML from
it: the narrow navigation, and nothing of a page that is not theirs. Nobody
else gets the cookie, and without it the server renders what it always did.
On their very first load in a browser a restricted member therefore sees the
whole navigation until their answer has loaded, a moment later. The cookie
decides only what is drawn.

### One browser, two accounts

The dashboard keeps its session in the browser's local storage, which every
tab of that browser shares. Signing in as an admin in one tab and as a member
in another does not give two sessions: the last sign-in is the session of
both. A tab now notices when another tab signs out, signs in as someone else
or switches workspace, and loads again as that account, instead of keeping
the previous account's name and navigation on screen.

To look at the dashboard as a member while staying signed in as an admin, use
a private window or a second browser profile.

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
  Members need them on Cloud: the count against the plan's limit decides
  whether an EDITOR is offered "Add connector", and the ids of connectors and
  servers a plan change paused mark those on the member's own list. The
  self-hosted dashboard does not ask for it.
- **Their own servers' activity.** For a server the member owns,
  `GET /api/mcp-servers/:id/activity` and the list's `usage` return the
  server's two numbers (calls in the last 30 days, time of the last call),
  counted over all callers.
- **The member's own calls**, with their full input and output (for the text
  of an error see [error text of a call](#error-text-of-a-call)). They made
  those calls, including through a server they do not own (that server is not
  named).

### Error text of a call

The error stored with a failed call often says where the connector connects:
"Host not found: 'erp.corp.example' could not be resolved", a response body
quoting the request URL, a database error naming host, database and user. A
restricted member reads a connector they do not own in the reduced view,
without its address, so the audit log (`error`) and tool performance
(`lastError`) do not hand that text back either. For a call on such a
connector they get the HTTP status, when the call ended with one, and a fixed
sentence:

```
HTTP 404. The call failed. Its details are kept for the connector's owner and the workspace admins.
```

An EDITOR keeps the full text for the connectors they own; admins, and
everyone in an Open workspace, keep it for every call. `input` and `output`
of the member's own calls are unchanged. The member's AI client still receives
the full error when the call fails, as before: the model needs it to correct
the call.

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

That includes a connection to a team server an admin owns: the member's AI
client keeps reaching `/mcp/<that server's id>` and gets the tools their roles
allow on it. A client that connects there learns the server's name and its
instructions, which the dashboard no longer shows the member; it cannot list
or call a tool outside their roles.

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
3. **Assign the roles.** By hand under **Settings → Roles → User MCP Role
   Assignment**, or from your directory: map SSO groups to MCP roles under
   **Settings → Single sign-on → Role mappings**
   ([SSO guide](../sso.md#3-map-directory-groups-to-roles)). Set the workspace
   role of those mappings to Viewer as well. A member can hold several roles
   and reaches the connectors of all of them together. The assignment table
   shows every role of each member: roles from a single sign-on group are
   marked and can only be changed in the role mappings, and the last column
   counts the connectors the member's roles reach.
4. **Switch to Restricted** under **Settings → Organization → Security →
   Member visibility**, and save with the button of that card. Choosing
   Restricted alone changes nothing: the card shows the mode that is active
   ("Active now: Open"), says "Not saved yet" while the choice differs from
   it, and the page asks before it is left with an unsaved choice (the
   browser on a reload or a closed tab, the dashboard on one of its links).

If no role in the workspace has a tool list yet, roles narrow nothing: every
member may call every tool, so in restricted mode a member, with or without a
role, still sees every connector, in the reduced view (name, status and tools,
not its settings). Only their calls are narrowed to their own, and the
navigation to the pages above. The settings page says so while Restricted is
chosen and while it is active, and links to **Settings → Roles**.

Once any role in the workspace has a tool list, a member with **no** role gets
no tools on the MCP endpoint, and so sees in restricted mode only the
connectors they own as an EDITOR, and none as a VIEWER.

### Invitations

An invitation carries the workspace role and the MCP roles the member gets
when they accept it.

- **Inviting the same address again applies the new values.** While an
  invitation is pending, a second invitation to that address reuses its link
  and sends the mail again. The role and the MCP roles of the second attempt
  replace those of the first, so the member gets what the last mail says. (It
  used to keep the first attempt's role: an invitation sent as Editor and
  corrected to Viewer made an Editor.)
- **The invite form offers Viewer first** in a restricted workspace, Editor in
  an open one. An Editor creates connectors and always sees the ones they
  own; pick it on purpose.

### Who may create a workspace

Whoever creates a workspace (`POST /api/organizations`, "Create New
Organization" under **Settings → Organization**) becomes its ADMIN.

- **Cloud:** every signed-in user may create their own workspace. An admin of
  one workspace reaches nothing outside it.
- **Self-hosted:** only someone who is an ADMIN of their active workspace; a
  VIEWER or an EDITOR gets 403 and is not shown the form. On a self-hosted
  instance a workspace ADMIN is the operator: they reach every admin page and
  the instance-wide list of hosts exempt from the SSRF guard
  (**Settings → Administration**). A member could otherwise make themselves
  one in a single request.

There is no separate instance-admin role: on a self-hosted instance every
ADMIN of any workspace can change the instance-wide settings. Give the ADMIN
role, in any workspace of the instance, only to people who may do that. A
workspace a member created before this rule existed keeps them as its ADMIN;
list the workspaces and their admins once after upgrading and remove what
should not be there.

### Static instance credentials bypass roles

`MCP_API_KEY`, `MCP_BEARER_TOKEN` and `MCP_AUTH_MODE=none` are credentials of
the instance, not of a person. A client that connects with one of them carries
no user, so there is no role to apply: it lists and calls **every tool of
every connector**, in both modes, and its calls appear in the audit log
without a user.

Do not use them on an instance that relies on roles or on Restricted mode.
Leave `MCP_API_KEY` and `MCP_BEARER_TOKEN` unset and set `MCP_AUTH_MODE` to
`oauth2` or `both`, never `none` or `legacy`
([MCP auth modes](../deployment.md#mcp-auth-modes)). Each member then connects
as themselves, with an OAuth sign-in or a personal MCP API key they create in
the dashboard, and gets the tools of their roles.

### A member still sees more than their role

Check, in this order:

1. **Their workspace role** under **Settings → Users**: an Admin is never
   restricted (a single sign-on role mapping can set it).
2. **All their MCP roles** in the **Settings → Roles** assignment table,
   including roles from single sign-on groups and grants valid in every
   workspace: a member reaches the connectors of all their roles together. The
   last column lists them.
3. **Whether they are an Editor who owns connectors.** An Editor always sees
   the connectors they created. Make them a Viewer if they should not manage
   connectors. In a workspace with more than one active member, an admin sees
   the owner of each connector on its card and on its page ("Owner: …").
4. **The mode of the workspace they are in**: signed in as the member,
   `GET /api/settings/member-visibility` answers
   `{"mode":"restricted","restrictedForMe":true}`. The mode is per workspace.
   On **Settings → Organization** the card shows "Active now: Restricted"
   only once the choice was saved.
5. **Whether any role has a tool list.** Without one, roles narrow nothing and
   every member sees every connector in the reduced view (see above).
6. **Whose session the browser holds.** Two tabs of one browser share one
   session ([one browser, two accounts](#one-browser-two-accounts)): what
   looks like the member's view may be the admin's. Check with a private
   window.
7. **How their AI client connects.** A client using `MCP_API_KEY`,
   `MCP_BEARER_TOKEN` or an instance with `MCP_AUTH_MODE=none` is not that
   member and gets every tool
   ([static instance credentials](#static-instance-credentials-bypass-roles)).

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
