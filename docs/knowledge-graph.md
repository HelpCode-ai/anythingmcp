# Knowledge Graph & AI skills

The **Knowledge Graph** turns the connectors in a workspace into a queryable map
of *entities* (customers, orders, products, …) and the *relationships* between
them — so the AI client knows **how data in one connector relates to data in
another**, and how to chain tools to get from one to the next.

On top of the graph, **AI skills** capture reusable business rules ("today's
revenue includes order statuses 2, 3 and 4 — not only 4") and feed them back to
the agent through the MCP server's instructions.

Everything is **per-workspace**, **PII-safe** (the graph stores entity and field
*names* and relationship metadata — never the actual values), and **off by
default**. The AI parts are opt-in twice (a global env flag *and* a
per-workspace switch) so a self-hosted instance ships them inert.

- [How the graph is built](#how-the-graph-is-built)
- [Editing the graph by hand](#editing-the-graph-by-hand)
- [Serving the graph to your AI client (MCP)](#serving-the-graph-to-your-ai-client-mcp)
- [AI skills](#ai-skills)
- [Optional AI enrichment & scheduled extension](#optional-ai-enrichment--scheduled-extension)
- [Privacy & cost controls](#privacy--cost-controls)
- [Settings & environment variables](#settings--environment-variables)

---

## How the graph is built

Each node and edge carries a **source** and a **confidence**, and the four
sources layer on top of each other:

| Layer | Where it comes from | Cost |
|---|---|---|
| **Static** | Tool names (`slug_VERB_noun`), input parameters, tool descriptions and `outputSchema`. Foreign-key-style fields (`x_id`, `xId`, `…Reference`) become edges. Works from a cold start, before any tool has run. | Free |
| **Observed** | The input/output of real `tool_invocations`. Produces *data-flow* edges (a field one tool **returns** matches a field another tool **takes**) and *value-correlation* edges (the same identifier seen across connectors). Raises or corrects static-layer confidence. | Free |
| **Manual** | Nodes, edges and descriptions a human adds or edits in the UI. Never overwritten by the automated layers. | Free |
| **LLM** *(optional)* | An AI pass over the entity/field **names** infers cross-connector links a naive name-match misses (e.g. a CRM "person", a billing "customer" and a support "user" are the same identity). Stored as *suggested* edges with a short rationale for a human to confirm. | Paid, opt-in |

**Edge kinds:** `references` (foreign-key-like), `same_identity` (same
real-world thing across connectors), `parent / child`, `produces_consumes`
(data flow), and `related`.

The static layer auto-syncs when a connector or its tools change; the
observational layer ingests on tool calls (debounced) and via an optional cloud
cron.

---

## Editing the graph by hand

The **Knowledge Graph** page (visual editor) lets you fully curate the graph:

- **Add / edit / delete entities** — label, owning connector, and a free-text
  description used when serving the graph.
- **Add / edit / delete connections** — pick the kind, write a description, and
  set the status. Manual edits are flagged and protected from the automated
  layers.
- **Layer filters** (`static` · `observed` · `manual` · `llm`) and a
  **confidence slider** to focus the view.
- **Rebuild graph** re-runs the static + observational passes; **Enrich with
  AI** runs the optional LLM pass (when enabled).

---

## Serving the graph to your AI client (MCP)

Each MCP server exposes a tool, **`kg_how_to_obtain`**, scoped to *that server's*
connectors. When the agent isn't sure how to fetch something, it calls the tool
with a parameter or entity name and gets back:

- which entities/tools produce or consume it,
- the relationship descriptions, and
- chaining hints ("to get an invoice's line items, first resolve the order id
  from the customer").

This makes a multi-connector setup far easier for the *customer's* agent to
navigate — it's contextual guidance, not orchestration.

---

## AI skills

Skills are **reusable rules inferred from the intents captured on your tool
calls** — guidance the agent should follow when working with a connector or a
whole MCP server.

**The loop:**

1. **Capture (optional).** With the per-workspace *intent capture* switch on,
   every MCP tool gains an optional `_intent` parameter; the agent records *why*
   it's calling the tool. The value is stripped before the upstream call and
   stored for analysis (never sent to the API).
2. **Suggest.** An AI pass over the captured intents proposes skills (title,
   *when to use*, *instruction*), scoped per connector or per server.
3. **Review.** On the **Skills** page each suggestion has **Apply / Edit /
   Dismiss / Delete**. The list has status tabs with counts (All / Suggested /
   Active / Dismissed), a search box and pagination, so it stays usable with
   dozens of skills. You can also create a skill by hand (**+ New skill**).
4. **Serve.** *Applied* skills are composed into the MCP server's **instructions**
   at serve time — see below.

**Managing skills at scale:**

- **Auto-apply (optional).** Turn on *Auto-apply high-confidence skills*
  (Settings → Features) and generated skills at/above **0.90** confidence are
  applied automatically; lower-confidence ones still wait for review.
- **Consolidate with AI.** The *Consolidate with AI* button merges a scope's
  **active** skills into the fewest non-redundant ones (same connector/server
  target selector as Generate). Pending and dismissed skills are left untouched,
  and a bad/empty model reply never wipes live skills.

### Skills are instructions, not extra tools

> **Important:** applied skills do **not** add tool calls to your MCP surface.
> All applied skills for a server (its own server-scoped skills plus the
> connector-scoped ones for its connectors) are concatenated into a single
> `## Workspace skills` block inside the server's `instructions`. The agent reads
> them as guidance — the tool list is unchanged.

Because composition is dynamic, editing or deleting a skill takes effect on the
next request — there's no blob to clean up.

> **Scaling note.** Applied skills are concatenated verbatim into the server's
> instruction block, so with many active skills that block grows and consumes
> context on every session. Keep the applied set tight: scope skills to the
> right server/connector, dismiss duplicates, and use **Consolidate with AI** to
> merge overlapping active skills into fewer rules.

---

## Optional AI enrichment & scheduled extension

The LLM features work with **OpenAI**, **OpenRouter** or **Anthropic** through a
tiny built-in client (no SDK). Two ways to run them:

- **On demand** — the *Enrich with AI* button (graph) and *Generate with AI*
  button (skills).
- **Scheduled (cloud)** — a cost-careful cron periodically extends the graph and
  skills from newly captured intents. It only spends when the graph changed or
  new intents arrived, enforces a per-workspace cooldown and a per-run cap, and
  can run as an **Anthropic Message Batch** (~50% cheaper, processed
  asynchronously).

---

## Privacy & cost controls

- **PII-safe by design.** Graph enrichment sends only entity and field *names* —
  never values. Captured intents (free text, which may contain personal data)
  are **redacted** (emails, phones, IBANs, cards, long numbers) before skill
  generation. Disable redaction only if you're sure no personal data appears.
- **Opt-in twice.** Nothing AI runs unless the global env flag *and* the
  per-workspace switch are both on.
- **Cost-capped.** A content hash skips unchanged graphs, the entity set is
  capped per pass, and the scheduled cron has a cooldown + per-run org cap.
- **EU / GDPR.** Prefer an EU-resident, no-training, zero-retention provider
  (e.g. Azure OpenAI EU, or Claude via AWS Bedrock EU). Anthropic's default
  model here is `claude-haiku-4-5`; OpenAI's is `gpt-4o-mini`.

---

## Settings & environment variables

**Per-workspace** (Settings → Organization → Features):

| Toggle | Effect |
|---|---|
| Knowledge Graph | Master switch — gates build, serve, cron and the MCP tool. |
| AI enrichment | Allows the LLM graph pass for this workspace. |
| Intent capture | Adds the optional `_intent` param to this workspace's tools. |
| Scheduled AI extension | Lets the cloud cron extend graph + skills for this workspace. |

**Instance env** (see `.env.example` for the full list):

```bash
# Master switch + API key for any AI feature
KG_LLM_ENABLED=false
KG_LLM_PROVIDER=openai          # openai | openrouter | anthropic
KG_LLM_MODEL=gpt-4o-mini        # anthropic default: claude-haiku-4-5
OPENAI_API_KEY=                 # or OPENROUTER_API_KEY / ANTHROPIC_API_KEY

# Local / OpenAI-compatible endpoint (Ollama, LM Studio, ...). When set, the
# KG LLM path talks here instead of the hosted providers, still using
# KG_LLM_MODEL. No key needed: KG_LLM_API_KEY is optional and only sent as an
# Authorization header when set. No response_format is sent on this path, so
# the model answers from the JSON instruction; unparsable replies are logged
# (model + endpoint origin) and that pass is skipped. Validated against a local
# qwen2.5 (Qwen2.5-0.5B-Instruct via an OpenAI-compatible front).
# KG_LLM_BASE_URL=http://localhost:11434/v1
# KG_LLM_API_KEY=

# Scheduled extension (cloud cron) — all must align: this flag, the cron call,
# and the per-workspace "Scheduled AI extension" switch
KG_LLM_CRON_ENABLED=false
KG_LLM_MIN_INTERVAL_HOURS=24    # per-workspace cooldown
KG_LLM_CRON_MAX_ORGS=20         # max workspaces per cron run
KG_LLM_BATCH=false              # Anthropic Message Batches (~50% cheaper)

# Privacy: scrub PII from captured intents before skill generation
KG_LLM_REDACT_INTENTS=true
```

Docker note: `localhost` inside the app container means the AnythingMCP
container itself, not your host. To reach an Ollama running on the host, use
`http://host.docker.internal:11434/v1` — on Linux that name needs an explicit
mapping (`extra_hosts: ["host.docker.internal:host-gateway"]`). When Ollama
runs as a service in the same Compose project/network, use its service name
instead (e.g. `http://ollama:11434/v1`). The `KG_LLM_*` variables and the
provider keys are passed through to the app container in `docker-compose.yml`
with empty defaults, so setting them in `.env` is enough.

The graph itself (static + observational layers, manual editing, the
`kg_how_to_obtain` tool) works with **no LLM key** — the AI flags only add the
optional enrichment and skill-generation passes on top.
