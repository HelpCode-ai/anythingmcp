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

Set `SENTRY_DSN` (backend) and `NEXT_PUBLIC_SENTRY_DSN` (frontend). Both default to no-op when unset.

Backend (`@sentry/nestjs`) auto-instruments http/express/prisma. `beforeSend` strips the same headers and field names as the log pipeline.

Frontend (`@sentry/nextjs`) wires client / server / edge runtimes. `onRequestError` captures errors thrown in route handlers and RSCs.

Sample rates default to **0** for tracing, profiling and replays — operators must opt in to those explicitly:

| Env | Default | Purpose |
|---|---|---|
| `SENTRY_TRACES_SAMPLE_RATE` | 0 | backend transactions |
| `SENTRY_PROFILES_SAMPLE_RATE` | 0 | backend CPU profiling |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | 0 | frontend transactions |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SAMPLE_RATE` | 0 | session replay (always-on) |
| `NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` | 0 | session replay (on error only) |

Set them between `0` and `1`. `0.1` = 10 %.

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
- No PII fields beyond `userId` / `orgId` / `email` (and `email` only when the operator hasn't disabled it via Sentry's `sendDefaultPii: false`, which is our default).

If a self-hoster wants any of these enabled, every knob is a documented env var. If we add one that isn't, that's a bug — file it.
