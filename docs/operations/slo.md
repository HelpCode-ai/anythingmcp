# Service level objectives

These are the SLOs we commit to for the managed AnythingMCP cloud. Self-hosters can reuse the structure but should pick their own targets — a single-tenant hobby instance does not need 99.9 % uptime, and it is fine to say so explicitly.

## SLOs

| SLO | Target | Window |
|---|---|---|
| API availability (`/api/*` 2xx + 4xx out of total) | ≥ 99.9 % | rolling 30 days |
| MCP endpoint availability (`/mcp/:serverId` 2xx out of total non-401) | ≥ 99.9 % | rolling 30 days |
| API p95 latency (excluding `/health`) | ≤ 500 ms | rolling 7 days |
| Tool invocation p95 end-to-end (server time, excluding upstream) | ≤ 1 500 ms | rolling 7 days |
| Successful tool invocations (`status=SUCCESS` / total) | ≥ 99 % | rolling 7 days |

5xx counts against availability; 4xx does not (they're contract violations on the caller's side, not faults on ours).

The `/health` endpoint is excluded from latency SLOs because it's a liveness probe pinged every few seconds and would dominate the percentile.

## Error budget

Burning through more than 50 % of the monthly availability budget in any rolling 7-day window triggers an internal review. The budget is just `(1 - SLO) × time`, which for 99.9 %/30d is **~43 minutes/month** of downtime allowed.

Practically: if a single incident burns 20 minutes, that's roughly half the month's budget gone. Two such incidents and we owe ourselves a postmortem and a freeze on shipping non-critical work until the budget recovers.

## How we measure

- Backend access logs (Pino, JSON, request id correlated) feed an aggregator (Loki or the operator's choice).
- The aggregator computes 5xx rate, latency percentiles, MCP invocation success rate.
- Audit log table (`ToolInvocation`) is the source of truth for tool success rate.
- The status page (when present) reads from the same metrics, not a separate pipe.

For self-hosters: the simplest version is `docker logs` piped to whatever you already have. Pino's JSON output keeps grep usable.

## Dependencies that cap our SLOs

- **PostgreSQL** — single point of failure today. Whatever uptime your DB layer offers is the ceiling for the API SLO.
- **Outbound HTTPS** — every REST/GraphQL/SOAP/MCP-bridge tool depends on the upstream's uptime. The tool-invocation SLO is **server time only** to keep us honest about what we control.
- **Email delivery (SMTP / Mailgun / Resend)** — verification + password-reset flows. We don't include this in the API SLO; outages there degrade onboarding but not the running deployment.

## Status page

Recommended: a separate, statically-hosted status page (Statuspage / Atlassian / Cachet / a static site that polls `/health`) that does **not** share infrastructure with the main deployment, so a region outage doesn't take both down at once.

A minimal MVP is a JSON file at `https://status.anythingmcp.com/status.json` populated by a cron worker that polls `/health` from a different region; the static page reads it and renders the green/yellow/red badge. Plenty of templates exist; pick one and stick with it.

## When to update this doc

- We agree to a different SLO with a customer (write the customer-specific commitment somewhere they'll see it; this doc is internal).
- A persistent change in dependency reliability moves the ceiling.
- The error budget burns down two months in a row — the targets may be wrong, or they may be right and the engineering capacity is the issue. Don't quietly slacken the targets.
