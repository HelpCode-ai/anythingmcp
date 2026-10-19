# Workspace memory

Workspace memory lets AI clients save facts, preferences and notes and find
them again later, in any client connected to an MCP server of the workspace
(Claude, ChatGPT, Copilot, Cursor and others). It is available with an
**Enterprise licence**, on AnythingMCP Cloud and on self-hosted instances.

- **My memory** (personal): one user's items, for example "answer me in
  Italian, numbers as tables". Only that user can read them, admins included.
- **Company memory** (organization): knowledge for everyone, for example
  "STAMMKUNDE means a customer with a framework agreement".

Memory is served to AI clients as information written by people, never as
instructions. Rules and procedures the AI must follow belong in
[AI skills](knowledge-graph.md#ai-skills).

## MCP tools

The tools are offered on per-server endpoints (`/mcp/<serverId>`) only, and
only those the user's access level allows. The shared `/mcp` endpoint is
unchanged.

| Tool | Offered from | What it does |
|---|---|---|
| `memory_search(query?, scope?, limit?)` | Read | Full-text search over the company memory and, from Personal up, the user's own items. An empty query returns the most recent items. |
| `memory_save(content, kind?, scope?, tags?)` | Personal | Saves a fact, preference or note. `scope: "organization"` is offered from Contribute. |
| `memory_forget(id)` | Personal | Deletes one of the user's own personal items. Company memory is changed in the dashboard only. |

## Access per user

Each user has one of these levels in a workspace (Settings → Users → *Memory*,
one by one or for several selected users):

| Level | Company memory | My memory | Propose to company memory |
|---|---|---|---|
| No access | – | – | – |
| Read | read | – | – |
| Personal | read | read and write | – |
| Contribute | read | read and write | yes |
| Default | the workspace default (Memory page → *Workspace settings*, initially Personal) | | |

Users without a user identity (instance-level static credentials,
client-credentials tokens) and deactivated users have no access.

## Company memory from AI clients

Memory page → *Workspace settings* → *Company memory from AI clients*:

- **Needs approval** (default): what an AI client proposes waits under
  *To review* until an admin or editor approves or rejects it.
- **Saved automatically**: it is active right away.

Either way, each item records who saved it and from which client, and admins
and editors can edit or delete company memory on the Memory page. They can
also add to it directly.

## Privacy and safety

- Content that looks like a password, token or key is refused.
- An item holds up to 2,000 characters and 10 tags. A user keeps up to 1,000
  personal items per workspace, a workspace up to 20,000 items.
- Admins can erase a user's personal memory without reading it (Settings →
  Users → select → *Erase personal memory*). Removing a user from a workspace
  deletes their personal memory there; deleting the account deletes all of it.
- Every change of access or settings and every erasure is recorded in the
  security event log (`MEMORY_ACCESS_CHANGED`, `MEMORY_SETTINGS_CHANGED`,
  `MEMORY_ERASED`).
- Without the licence (or after it expires) the tools and the page are not
  available; stored memory is kept, and admins can still erase personal memory.

## Search

Search uses PostgreSQL full text with the `simple` configuration (no stemming,
so German, Italian and English behave alike), ranked by relevance, and falls
back to a substring match for partial words and codes. No extra service or
embedding provider is needed.
