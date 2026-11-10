# Cloud plan limits

This page applies to AnythingMCP Cloud only. A self-hosted instance has none of
these limits: there, the Community edition counts active users, and
Enterprise features follow the licence key (see [license FAQ](license-faq.md)).

## What each plan includes

| | Trial (7 days) | Starter | Team | Enterprise |
|---|---|---|---|---|
| Active connectors | 15 | 5 | 15 | unlimited |
| Active MCP servers | 10 | 3 | 10 | unlimited |
| Users | 3 | 1 | 3 | by contract |
| File Search | Team limits | 1 folder, 500 files | 3 folders, 2,000 files | by contract |
| Code mode | Team features | 5 saved code tools, no inline code | 20 saved code tools, inline code | unlimited |

The trial includes everything in Team, so you can try every feature before you
choose a plan. File Search and code mode have their own limits, described in
[File Search](connectors/file-search.md#limits-and-pauses) and
[code mode](code-mode.md#limits).

Only **active** connectors and MCP servers count. A File Search folder counts
against the File Search folders, not against the connectors.

## Before you choose a plan

When the trial ends, the plan picker shows what changes with each plan for
your workspace, for example "4 of your 9 connectors would be paused". Choose
**See which ones** to see which connectors would stay active and which would
be paused. Team is always one click away.

`GET /api/license/plan-fit` returns the same answer for scripts and the
[CLI](../packages/cli/README.md#check-what-a-plan-change-would-pause-cloud).

## When a plan includes fewer active items

When a workspace moves to a plan with lower limits (the trial to Starter, or
Team to Starter):

- the connectors and MCP servers used most in the last 30 days stay active;
- the others are **paused**. Nothing is deleted: credentials, tools and settings
  are kept. Your AI clients no longer see the tools of a paused connector, and
  the AnythingMCP tools tell the model which connectors are paused;
- the workspace admins get an email listing what was paused.

You choose what stays active at any time. Pause a connector, then switch on
another one. At the limit, switching one on asks you to pause another first.
Paused connectors show **Paused: plan limit** in the dashboard.

When you upgrade again, everything the downgrade paused is switched back on
automatically, up to the new plan's limits.

Members keep their access when the plan includes fewer users. New
invitations above the limit are refused.

Over a limit, the API answers `403` with `code: "PLAN_LIMIT"`, the `axis`
(`connectors`, `mcpServers`, `users` or `fileSearchConnectors`), `max` and
`current`.
