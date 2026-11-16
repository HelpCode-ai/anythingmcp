# Learning projects

A learning project keeps what one colleague teaches the AI. An admin turns
learning on for **one member on one MCP server**. When that member corrects
the AI or explains how the work is really done, the lesson is kept, and the
lessons of a topic become a skill for everyone on that server.

It is made for knowledge that leaves with a person: the colleague who knows
which part fits which old model, which quantity is always wrong in the first
draft, which customer rule is written nowhere.

Learning projects are part of the **Team and Enterprise plans** on AnythingMCP
Cloud and of **Enterprise** on a self-hosted instance (see
[Plans](#plans)). Nothing is kept before the member agrees.

- [How it works](#how-it-works)
- [Start a project](#start-a-project)
- [What the member sees](#what-the-member-sees)
- [MCP tools](#mcp-tools)
- [Review and publish](#review-and-publish)
- [From the CLI and the API](#from-the-cli-and-the-api)
- [Privacy and safety](#privacy-and-safety)
- [Plans](#plans)
- [Limits](#limits)

## How it works

AnythingMCP sees tool calls, not the conversation. The member's own AI client
saw the whole conversation, so it is the one that writes the lesson down;
AnythingMCP stores it and serves it back.

1. **A lesson** is one thing the member taught: a *rule*, a *fact*, a
   *correction* (what the AI did, what the member changed it to, and why) or a
   worked *example*.
2. **A topic** groups lessons about one kind of work, for example "Quotes for
   old windows". One topic is one skill. The skill text is put together from
   the topic's lessons, so a new lesson never rewrites the others.
3. **A draft** of the skill, with every lesson, is served to the member only.
   Their AI client improves at once; if they correct it again, the lesson is
   revised.
4. **The member confirms** lessons in the chat ("this is what I learned, is it
   right?").
5. **A person publishes** a topic: its confirmed lessons become a skill for
   everyone on the server. It is an ordinary [AI skill](knowledge-graph.md#ai-skills)
   with versions, a folder and usage counts, marked *from a learning project*.

No AI key is needed on the instance: the member's AI client writes the lesson,
the server only stores and arranges text.

## Start a project

**Learning projects → New learning project** (admins):

| Field | Meaning |
|---|---|
| Name | For example "Hardware for old windows". The member and their AI client see it. |
| Learn from | The member. One project per member and MCP server. |
| On the MCP server | Lessons are kept only from the member's work on this server. |
| File the skills in | Optional [folder](memory.md#folders). A folder limited to roles also limits who is served the published skill. |
| Ends on | Optional. The project ends on its own that day. |
| Labels | Put on the learned skills, next to `learned`. |
| Publishing | *A person publishes each topic* (default), or *lessons the member confirms are published*. |
| Show the member's name | Off by default: the name is shown to admins only. |

The project then waits for the member. You can pause, resume, end or delete it
from its page. Ending keeps the lessons and the published skills; deleting
removes the lessons and keeps the published skills.

## What the member sees

Under **Settings → Profile → Learning projects** the member reads what would
be kept and chooses **Accept** or **Decline**. The notice they accepted is
stored with the project.

After accepting, they refresh the connector's tool list in their AI client
(in claude.ai: *Customize → Connectors →* the connector *→ ⋮ → Refresh tools
list*) and work as usual.

At any time they can **Stop** the project on the same page, and choose to
erase everything that was not published. Their opt-out of
[skill learning](knowledge-graph.md#who-contributes-to-skill-learning) also
stops every learning project.

## MCP tools

On `/mcp/<serverId>`, for the project's member only:

| Tool | What it does |
|---|---|
| `learning_record(topic, kind, text, before?, after?, reason?, tool?, whenToUse?, replaces?)` | Keeps one lesson under a topic. A new topic name starts a new skill. |
| `learning_review(topic?, limit?)` | Lists the lessons the member has not confirmed yet. |
| `learning_confirm(decisions)` | Records the member's answers: `confirm`, `reject` or `correct` (with the corrected text). |

The AI client is told when to call them in three places: the server's
instructions, the description of `learning_record`, and one line at the end of
the result of every tool that may change something ("if the user corrects this
result, call learning_record"). The last one matters because some clients never
show a server's instructions to the model.

The tools disappear when the project is paused or ended, the member stops it
or opts out, or the plan no longer includes it. A call made after that saves
nothing.

## Review and publish

On the project's page (admins and editors):

- **Lessons**: confirm, reject, reopen or reword a lesson. Rewording keeps the
  earlier wording as *replaced*.
- **Topics**: *Preview* shows the text publishing would write from the
  confirmed lessons; **Publish** writes it. Publishing again updates the same
  skill and keeps the earlier text as a version.

A topic with confirmed lessons newer than its last publication is marked
*Confirmed changes to publish*.

## From the CLI and the API

Everything the dashboard does for learning projects is in the management API
under `/api/learning`, so the [CLI](../packages/cli/README.md) reaches it with
`amcp api` and a management key (`amcp login --management`). The key carries
its owner's role: starting, changing, pausing, ending and deleting a project
need an admin; reading lessons and publishing need an admin or an editor. A
read-only (`MANAGEMENT_READ`) key gets 403 on every change.
`amcp api --list learning` prints all 16 operations.

What the plan includes, and the projects of the workspace:

```bash
amcp api GET /api/learning/allowance
# {"max":1,"full":false,"plan":"team","used":0}
amcp api GET /api/learning/projects
```

Start a project. The ids come from `amcp api GET /api/users` and
`amcp api GET /api/mcp-servers`; only `name`, `userId` and `mcpServerId` are
required:

```bash
amcp api POST /api/learning/projects --yes --data '{
  "name": "Hardware for old windows",
  "userId": "<member id>",
  "mcpServerId": "<server id>",
  "folderId": "<folder id>",
  "endsAt": "2027-03-31T23:59:59Z",
  "tags": ["windows"],
  "publishMode": "manual"
}'
```

It waits for the member. Pause, resume, end or delete it:

```bash
amcp api POST /api/learning/projects/<id>/pause --yes
amcp api POST /api/learning/projects/<id>/resume --yes
amcp api POST /api/learning/projects/<id>/end --yes
amcp api DELETE /api/learning/projects/<id> --yes
```

Review lessons and publish a topic. The topic ids are in the project
(`GET /api/learning/projects/<id>`):

```bash
amcp api GET '/api/learning/projects/<id>/lessons?status=draft'
amcp api PATCH /api/learning/lessons/<lesson id> --yes --data '{"status":"confirmed"}'
amcp api PATCH /api/learning/lessons/<lesson id> --yes --data '{"text":"The lesson in better words."}'
amcp api GET /api/learning/topics/<topic id>/preview
amcp api POST /api/learning/topics/<topic id>/publish --yes
```

**The member's own answer cannot be given for them.** `consent` and `withdraw`
act for the owner of the key, and are refused for anyone but the project's
member. With their own key the member can accept or stop:

```bash
amcp api GET /api/learning/me
amcp api POST /api/learning/projects/<id>/consent --yes --data '{"notice":"<the notice the member read>"}'
amcp api POST /api/learning/projects/<id>/withdraw --yes --data '{"erase":true}'
```

The lesson tools are MCP tools, not management operations. The member can
call them from the CLI when logged in to the project's server
(`amcp login --url <instance> --server <server id>`):

```bash
amcp tools call learning_review
amcp tools call learning_record --yes --args '{"topic":"Old windows","kind":"rule","text":"Check the groove width before choosing a hinge."}'
```

## Privacy and safety

- **Consent first.** Nothing is kept until the member accepts, and the text
  they accepted is stored.
- **What is kept:** the lessons. **Not kept:** the conversation, the member's
  work on other servers, any figures about their work.
- **A draft is served to its member only**, on every path that serves skills.
  Admins and editors see drafts in the dashboard, marked as drafts.
- **Nothing reaches other users unconfirmed.** A published skill holds only
  lessons that were confirmed.
- **Secrets and instructions are refused.** A lesson that looks like a
  password, token or key, or that tells the assistant to ignore its
  instructions, is not saved.
- **The member's name** is shown to admins only, unless the project is set to
  show it.
- **Removal:** removing the member keeps the lessons without the link to the
  person. Deleting an MCP server keeps what was learned on it.
- **Audit:** `LEARNING_PROJECT_CREATED`, `LEARNING_PROJECT_CONSENT`,
  `LEARNING_PROJECT_STATUS`, `LEARNING_PUBLISHED` and `LEARNING_ERASED` in the
  security event log.

Recording what one employee teaches can fall under workplace rules where you
are (in Germany, for example, co-determination by a works council). Check
before you start a project.

## Plans

| | Learning projects |
|---|---|
| Cloud Starter | none |
| Cloud Team, and the Cloud trial | 1 at a time |
| Enterprise (Cloud and self-hosted) | no limit |
| Self-hosted Community | none |
| Self-hosted 30-day evaluation | 1 at a time |

A project *waiting for the member* or *active* counts; a paused or ended one
does not. When a plan includes fewer projects than a workspace has, the oldest
keep working up to the plan's number and the others capture nothing; no lesson
and no published skill is removed, and an upgrade puts them back to work.

Over the limit the API answers `403` with `code: "PLAN_LIMIT"` and
`axis: "learningProjects"`; on a plan without learning projects,
`code: "edition_required"`.

## Limits

Per project: 40 topics, 300 lessons per topic, 2,000 lessons, 60 new lessons
an hour. A lesson holds up to 2,000 characters. A learned skill holds up to
20,000 characters; past that the oldest examples leave the text (they stay
stored), and the AI client is asked to file new lessons under a narrower
topic.
