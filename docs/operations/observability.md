# Observability

Three pipelines. All three are opt-in for self-hosters: the default install ships nothing externally.

## 1. Structured logs (Pino, always on)

Every HTTP request emits one JSON line at completion (or earlier on error), tagged with:

- `req.id` — UUID, present on the response as `X-Request-Id`. Quote it in bug reports.
- `userId` / `orgId` / `authMethod` — propagated from the authenticated request.
- `req.method`, `req.url`, `res.statusCode`, `responseTime`.

Sensitive fields are stripped at the pino layer:
- headers: `authorization`, `cookie`, `x-api-key`, `set-cookie`.
- bodies: any `password`, `token`, `refreshToken`, `accessToken`, `apiKey`, `secret` field.

Log level: `LOG_LEVEL` env (default `info`). Format: `pino-pretty` in dev, JSON in prod.

`/health` is excluded from autoLogging — it's hit every few seconds by liveness probes.

Forward to:
- Loki / Promtail (recommended for self-hosted)
- CloudWatch Logs / Datadog / Logtail (managed)
- Whatever already eats JSON in your stack

## 2. Errors (Sentry, opt-in)

Set `SENTRY_DSN` on the process that should report: the backend, the frontend, or both (with the unified image, the same variable serves both; with separate containers, give each its own project's DSN). Unset = no-op, and nothing about Sentry appears on the page.

The DSN is read **at runtime**. The frontend's root layout hands it to the browser from the container's env, so the published image contains no DSN and every installation reports to its own Sentry, or to none. `NEXT_PUBLIC_SENTRY_DSN` is no longer read: Next.js inlines `NEXT_PUBLIC_*` at build time, which never worked with the prebuilt image.

Backend (`@sentry/nestjs`) auto-instruments http/express/prisma. `SentryGlobalFilter` reports exceptions that become a 500; `HttpException`s (4xx, auth failures) are expected and are not reported. Events are tagged `org_id` with the internal organization id: never an e-mail or a name.

Frontend (`@sentry/nextjs`) wires browser / server / edge runtimes; `error.tsx`, `global-error.tsx` and `onRequestError` report what reaches them. Browser events are sent to `/monitoring` on the same origin and forwarded to Sentry, so ad blockers do not drop them; put that path behind a reverse proxy that does not forward the client address (see `deploy/cloud/Caddyfile`).

What leaves the process is an allowlist (`packages/backend/src/common/sentry-scrub.ts`, `packages/frontend/src/lib/sentry-scrub.ts`): request method, URL without query string or fragment, and the `user-agent` header. No request bodies (MCP tool arguments), cookies, query strings (OAuth codes, invitation and reset tokens), fragments (licence keys), IP addresses or user. Outgoing HTTP breadcrumbs and spans lose their query string, where some upstream APIs take their key; console breadcrumbs are dropped. Session replay is off.

| Env | Default | Purpose |
|---|---|---|
| `SENTRY_DSN` | unset | enables reporting for the process that reads it |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | environment tag |
| `SENTRY_RELEASE` | image build | release tag; the published image sets it to the commit |
| `SENTRY_TRACES_SAMPLE_RATE` | 0 | backend (or Next.js server) transactions |
| `SENTRY_PROFILES_SAMPLE_RATE` | 0 | backend CPU profiling |
| `SENTRY_BROWSER_TRACES_SAMPLE_RATE` | 0 | browser transactions (frontend container) |
| `SENTRY_VERIFY_TOKEN` | unset | enables the one-off checks below; unset it afterwards |

Set rates between `0` and `1`. `0.1` = 10 %.

To confirm the pipeline end to end, set `SENTRY_VERIFY_TOKEN` and:

- backend: `curl -H "x-sentry-verify: $TOKEN" https://<host>/health/sentry-verify` → a 500 and an event "Sentry verification (backend)";
- frontend server: `curl -H "x-sentry-verify: $TOKEN" https://<host>/sentry-verify`;
- browser: open `https://<host>/sentry-verify#$TOKEN`.

Without the variable all three answer 404.

## 3. Distributed tracing (OpenTelemetry, opt-in)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (backend only). Auto-instrumentations cover http/express/pg/mysql/redis. `fs` spans are disabled (they'd be 90 % of cold-start noise) and `/health` is excluded.

Service identity:

| Env | Default |
|---|---|
| `OTEL_SERVICE_NAME` | `anythingmcp-backend` |
| `OTEL_SERVICE_VERSION` | `npm_package_version` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` |

Auth: standard `OTEL_EXPORTER_OTLP_HEADERS` (e.g. `authorization=Bearer …`).

Suggested collectors:
- Self-hosted: Tempo + Grafana, or Jaeger.
- Managed: Honeycomb, Lightstep, Datadog APM (via OTLP receiver).

Sentry's tracing pipeline is independent. Both can run side by side — Sentry for error correlation, OTLP for an in-house collector — and that's intentional.

## 4. Host jobs (AnythingMCP Cloud droplet only)

Two systemd timers run on the managed cloud host, installed by `.github/workflows/deploy-cloud.yml`. Both read their settings from `/opt/anythingmcp-cloud/.env` and mail through the same `SMTP_*` the backend uses. Self-hosted installs have neither.

| Timer | Script | When | Mails |
|---|---|---|---|
| `anythingmcp-probe.timer` | `deploy/cloud/uptime-probe.sh` | every minute | `UPTIME_ALERT_TO`, on a change of state only (down, recovered) |
| `anythingmcp-stuck-report.timer` | `deploy/cloud/stuck-users-report.sh` | Monday 07:00 Europe/Berlin | `REPORT_TO`, falling back to `UPTIME_ALERT_TO` |

The weekly report lists, for the last 7 days with 30-day context: organizations whose tool calls have never succeeded (marked NEW or STILL STUCK against the previous report, whose list is kept in `/var/lib/anythingmcp-report/stuck-orgs`); catalog connectors at 0 % success, or under 20 % with at least 5 calls, across all organizations; and signups that never created a connector or never made a call. It only reads the database, never selects tool inputs, outputs or credentials, and scrubs error texts (one line, no URL query strings, e-mail addresses or long tokens, 150 characters). It does contain customer e-mail addresses, so send it to the team only.

| Env (in the host `.env`) | Default | |
|---|---|---|
| `REPORT_TO` | `UPTIME_ALERT_TO` | Recipients, comma-separated. With neither set the report goes to the journal only. |
| `REPORT_WINDOW_DAYS` | `7` | Length of the reporting window. |
| `REPORT_TZ` | `Europe/Berlin` | Time zone for the times in the report. |
| `REPORT_CONNECTOR_MIN_CALLS` / `REPORT_CONNECTOR_MAX_RATE` | `5` / `20` | A connector is listed at 0 % success, or under `MAX_RATE` % with at least `MIN_CALLS` calls. |
| `REPORT_LIST_MAX` | `30` | Longest list of signup e-mails printed per group; above it, only the count. |

```bash
# on the droplet
/opt/anythingmcp-cloud/stuck-users-report.sh --dry-run   # print this week's report, send nothing
systemctl start anythingmcp-stuck-report                  # send it now (and remember who was listed)
systemctl list-timers 'anythingmcp-*'
journalctl -u anythingmcp-stuck-report -n 50
```

`bash deploy/cloud/stuck-users-report.test.sh` runs the report against a throwaway database with every migration applied and a throwaway SMTP server; CI runs it on each PR.

## Correlating across pipelines

The same `req.id` UUID appears in:
- the Pino log line (`req.id`)
- the response header (`X-Request-Id`)
- Sentry events that include the request scope (added automatically by `@sentry/nestjs`)
- OTLP traces — pino-otel correlation is on the roadmap; until then, find the trace by matching timestamp + URL + userId

When a customer reports a problem, the **first** thing to ask is "what's the `X-Request-Id` on the failed response?" — it cuts triage time by an order of magnitude.

## What we do not collect

- No usage telemetry. The dashboard does not phone home.
- No customer payloads in error reports — they're scrubbed before they leave the process.
- No PII in error reports: the organization id is the only identifier, and no IP address is sent.

If a self-hoster wants any of these enabled, every knob is a documented env var. If we add one that isn't, that's a bug — file it.
