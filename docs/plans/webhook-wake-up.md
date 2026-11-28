# Webhook wake-up: tell a connected agent when an event arrives

Status: proposal, not scheduled. Decided 2026-11-12 to keep it for later.
This file is a working plan, not product documentation. It is not part of
`llms.txt` (`docs/plans/` is outside the generator's sections). Move it to an
issue or delete it when the feature is built.

## 1. Problem

Since #1372 a connector can receive webhooks (Stripe for now). The ingest
endpoint verifies the signature and stores the event, and the model reads
stored events with the `webhook_recent_events` tool. So the agent learns about
a payment only when it decides to call that tool, or when the user asks.

The idea: when a verified event arrives, an agent session that is connected to
a server with that connector hears about it right away and can act, for
example by looking up the customer, drafting a reply or updating an order.

An outside vendor offered a relay for this last step (November 2026). We
prefer to build it in: the events, the signature check and the sessions are
already ours, and a third hop would put customer payment data in one more
place.

## 2. Goals and non-goals

Goals:

- A verified event reaches the live MCP sessions that may use the connector,
  within a few seconds, without putting the payload into the notification.
- Works on self-hosted first, then on Cloud.
- The same organization, role and tool permission checks as the
  `webhook_recent_events` tool.

Non-goals:

- Waking claude.ai or ChatGPT chats. Their MCP clients do not keep a session
  open between turns, so there is nothing to wake. For them see phase 3
  (server-side reactions).
- New webhook providers. Adding GitHub, Shopify and others is separate work
  (each needs its own signature scheme in `webhook-signature.util.ts`).

## 3. What exists today

| Piece | Where | Notes |
|---|---|---|
| Ingest endpoint | `connectors/webhook-ingest.controller.ts` | `POST /api/webhooks/:connectorId`, Stripe signature check, throttled to 60 requests/min, same 401 for every refusal. |
| Event store | `connectors/webhook-events.service.ts` | Deduplicates by provider event id, 7-day retention, 500 events per connector, `recentEvents()` caps at 50. |
| Read tool | `mcp-server/dynamic-mcp-tools.ts` (`webhook_recent_events`) | The only way the model sees events. |
| Stateful sessions | `mcp-servers/mcp-session.manager.ts`, `mcp-server/mcp-endpoint.controller.ts` | Only with `MCP_STATEFUL_SESSIONS=true`. One session per (server, principal), held in process memory, 30 min idle eviction, 500 session cap. The GET request opens the SSE stream (`routeToSession`); without a session GET returns 405. `notifyToolsChanged()` already pushes `notifications/tools/list_changed`. |
| Cloud | `docker-compose.cloud.yml`, `deploy/cloud/release.sh` | Stateless with JSON responses (Copilot Studio cannot read SSE and fails on "Session not found"). A blue/green release drops stateful sessions; clients get 404 and start a new session. |

So the push channel exists in code but is off on Cloud, and nothing connects
`recordEvent()` to it.

## 4. Options

**A. MCP resource subscription (standard).** Publish one resource per
webhook connector, for example
`anythingmcp://server/<serverId>/connector/<connectorId>/webhook-events`,
whose content is the latest events (same bounds and redaction as the tool).
Declare `resources.subscribe`. A client subscribes with `resources/subscribe`;
when `recordEvent()` stores an event we send `notifications/resources/updated`
for that URI to the subscribed sessions. The client re-reads the resource or
calls the tool.
Pro: in the MCP spec, no client-specific code. Con: clients decide what to do
with the update; many only refresh a cache and do not start a model turn.

**B. Client-specific push.** Some coding agents are adding ways for an MCP
server to inject a message into a running session (Claude Code has an
experimental feature for this). Higher chance of really "waking" the agent,
but tied to one client and still changing. To verify when we start.

**C. Server-side reactions (no client needed).** Rules per connector: "on
`payment_intent.succeeded`, send a Telegram message / create an email draft /
run a saved code tool". Runs on our side, so it also serves claude.ai and
ChatGPT users, who are most of our customers.

Recommendation: A first (small, standard, reuses the session manager), B as a
thin adapter on top of A if a client's mechanism settles, C as its own
feature if customers ask for automations.

## 5. Plan

### Phase 1: resource subscription, self-hosted (about 3 to 4 days)

1. Check that the MCP server SDK version in use supports `resources.subscribe`
   and sending `resources/updated` per session; add the capability only on
   per-server endpoints in stateful mode.
2. Register the webhook-events resource for each connector with
   `webhookEnabled`, under the same access rules as the read tool
   (organization, server assignment, role, tool enabled). Content: event id,
   type and received time of the latest 20 events; full payloads stay behind
   the tool.
3. Keep subscriptions on the session entry (`McpSessionEntry`): a set of
   URIs. Drop them with the session.
4. After `recordEvent()` returns a new row, call
   `McpSessionManager.notifyResourceUpdated(organizationId, connectorId)`.
   It looks up sessions of that organization whose server includes the
   connector and that subscribed to the URI, and sends the notification.
   Never send to another organization's session; check this in a test.
5. Coalesce: at most one notification per session and URI every 5 seconds
   (a burst of 50 Stripe events gives one or two notifications).
6. Notification only, no payload. Event content reaches the model through
   `resources/read` or the tool, so retention, limits and redaction stay in
   one place.
7. Tests: subscription lifecycle, organization isolation, no notification
   without a subscription, coalescing, duplicate delivery gives no
   notification, stateless mode unchanged.
8. Docs: `docs/mcp-resources.md` (new resource and subscriptions),
   connector webhook docs, and how to enable it on self-hosted.

Behaviour: self-hosted with `MCP_STATEFUL_SESSIONS=true` gets it; stateless
self-hosted and Cloud are unchanged.

### Phase 2: Cloud (about 2 to 3 days, needs a decision)

Cloud must keep stateless JSON as the default (Copilot Studio). Options:

- Stateful only for clients that ask for it: create a session when the client
  sends the `Mcp-Session-Id` flow and opens the GET stream, stay stateless
  otherwise. Needs a check that Copilot and ChatGPT keep working (they do not
  send GET).
- Or a per-server switch "Live events" that turns stateful mode on for that
  server only.

Also needed: release behaviour (a blue/green switch drops sessions and their
subscriptions; spec-compliant clients start a new session, but must
subscribe again), the session cap per organization so one customer cannot
take all 500, and a Prometheus gauge for subscriptions. With more than one
backend replica the fan-out would need Postgres `LISTEN/NOTIFY` or similar;
today Cloud runs one active backend, so in-process is enough.

Plan gating: decide whether live events are Team and above.

### Phase 3: server-side reactions (optional, separate plan)

Rules stored per connector (event type filter, action, rate limit), actions
limited to things we already do safely: Telegram message through an existing
Telegram connector, email draft, saved code tool. Write actions need the same
confirmation rules as the tools. Only if customers ask for it.

## 6. Security notes

- Organization isolation is the main risk: the fan-out must filter by
  `organizationId` and by server assignment, like every other query.
- Event payloads come from the provider and can carry customer names, emails
  and addresses: never put them in a notification, never log them.
- Webhook payloads are untrusted text for the model, the same as tool output.
- The ingest endpoint keeps its throttle; coalescing protects the sessions.

## 7. Open questions

1. Is phase 1 on self-hosted alone worth shipping, or only together with
   Cloud?
2. Which plans get live events on Cloud?
3. Which client do we test first (Claude Code, Cursor), and does it start a
   model turn on `resources/updated`?
4. Do we want phase 3 at all, or wait for customer requests?
