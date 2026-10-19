/**
 * Prometheus metrics — opt-in.
 *
 * Off unless METRICS_ENABLED=true; otherwise no-op so the default install
 * exposes nothing. Modeled on tracing.ts's env-gated, no-DI module pattern:
 * a plain facade so a later switch to OTel metrics touches one file.
 *
 * A second, separate node:http listener — never the main Nest app or port
 * 4000 — because /metrics must never be reachable through the public port
 * that /health* is proxied on (deploy/cloud/Caddyfile, docs/deployment.md).
 *
 * METRICS_TOKEN is required whenever METRICS_ENABLED=true, on Cloud and
 * self-hosted alike (mirrors SENTRY_VERIFY_TOKEN): the listener's default
 * bind host is 0.0.0.0, so an unauthenticated self-hosted instance would
 * serve /metrics to anyone who can reach the host.
 *
 * On Cloud (DEPLOYMENT_MODE=cloud), per-tool/per-connector labels are always
 * dropped, even if METRICS_TOOL_LABELS=true — no series may carry a
 * connector id or tool name across thousands of tenant workspaces.
 *
 * Uses its own Registry rather than prom-client's global default: the
 * "disabled means nothing collected" guarantee would otherwise depend on
 * collectDefaultMetrics() never having been called anywhere else in the
 * process, including other test files sharing the global registry.
 */
import * as http from 'node:http';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { sameSecret } from './secrets.util';
import { processGauges } from './process-vitals';

// Plain console wrappers, called through at each use (not bound once at
// import time), so test spies on console.* take effect.
const logger = {
  log: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

let server: http.Server | null = null;
let registry: Registry | null = null;
let toolCallsTotal: Counter<'connector_type' | 'status' | 'connector_id' | 'tool'> | null = null;
let toolCallDuration: Histogram<'connector_type' | 'status' | 'connector_id' | 'tool'> | null = null;
let upstreamErrorsTotal: Counter<'connector_type' | 'upstream_status_class' | 'connector_id' | 'tool'> | null = null;
let toolLabelsEnabled = false;
let toolLabelsWarned = false;

function isCloud(): boolean {
  return (process.env.DEPLOYMENT_MODE || 'self-hosted') === 'cloud';
}

export interface RecordToolCallInput {
  connectorType: string;
  status: 'success' | 'error';
  durationMs: number;
  upstreamStatus?: number;
  connectorId?: string;
  tool?: string;
}

function upstreamStatusClass(upstreamStatus?: number): '4xx' | '5xx' | null {
  if (upstreamStatus == null) return null;
  if (upstreamStatus >= 500) return '5xx';
  if (upstreamStatus >= 400) return '4xx';
  return null;
}

/** No-op until startMetricsServer() has actually created the registry. */
export function recordToolCall(input: RecordToolCallInput): void {
  if (!toolCallsTotal || !toolCallDuration || !upstreamErrorsTotal) return;

  const extra =
    toolLabelsEnabled && !isCloud()
      ? { connector_id: input.connectorId ?? '', tool: input.tool ?? '' }
      : {};

  toolCallsTotal.inc({ connector_type: input.connectorType, status: input.status, ...extra });
  toolCallDuration.observe(
    { connector_type: input.connectorType, status: input.status, ...extra },
    input.durationMs / 1000,
  );

  // Only an actual upstream error moves this counter — a successful call
  // (or one with no upstream status at all) never increments it.
  const statusClass = upstreamStatusClass(input.upstreamStatus);
  if (statusClass) {
    upstreamErrorsTotal.inc({
      connector_type: input.connectorType,
      upstream_status_class: statusClass,
      ...extra,
    });
  }
}

function sendMetrics(reg: Registry, res: http.ServerResponse): void {
  reg
    .metrics()
    .then((body) => {
      res.writeHead(200, { 'Content-Type': reg.contentType });
      res.end(body);
    })
    .catch((err) => {
      logger.error(`[metrics] failed to render: ${err}`);
      res.writeHead(500);
      res.end();
    });
}

/**
 * Starts the /metrics listener if METRICS_ENABLED=true, else returns null.
 * Idempotent-ish for tests: call stopMetricsServer() between starts.
 */
export function startMetricsServer(): http.Server | null {
  if (process.env.METRICS_ENABLED !== 'true') return null;

  const token = process.env.METRICS_TOKEN;
  if (!token) {
    logger.error('[metrics] METRICS_TOKEN must be set when METRICS_ENABLED=true; metrics stay off.');
    return null;
  }

  toolLabelsEnabled = process.env.METRICS_TOOL_LABELS === 'true';
  if (toolLabelsEnabled && isCloud() && !toolLabelsWarned) {
    logger.warn('[metrics] METRICS_TOOL_LABELS is ignored on Cloud: no connector_id/tool label is ever added.');
    toolLabelsWarned = true;
  }
  // Decided once per server lifetime: identity labels are never added on
  // Cloud, matching the same check recordToolCall() makes at call time.
  const withIdentityLabels = toolLabelsEnabled && !isCloud();

  registry = new Registry();
  collectDefaultMetrics({ register: registry });

  toolCallsTotal = new Counter({
    name: 'anythingmcp_tool_calls_total',
    help: 'Total tool calls, by connector type and outcome.',
    labelNames: withIdentityLabels ? ['connector_type', 'status', 'connector_id', 'tool'] : ['connector_type', 'status'],
    registers: [registry],
  });
  toolCallDuration = new Histogram({
    name: 'anythingmcp_tool_call_duration_seconds',
    help: 'Tool call duration in seconds, by connector type and outcome.',
    // Tool calls can take 20s or more; cover 50ms to 60s.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
    labelNames: withIdentityLabels ? ['connector_type', 'status', 'connector_id', 'tool'] : ['connector_type', 'status'],
    registers: [registry],
  });
  upstreamErrorsTotal = new Counter({
    name: 'anythingmcp_tool_call_upstream_errors_total',
    help: 'Tool calls whose upstream response was a 4xx or 5xx, by status class. Never incremented for a successful call.',
    labelNames: withIdentityLabels ? ['connector_type', 'upstream_status_class', 'connector_id', 'tool'] : ['connector_type', 'upstream_status_class'],
    registers: [registry],
  });

  // Mirror the existing in-process gauges at scrape time — not on an
  // interval — so a value read between scrapes is never stale.
  for (const name of ['toolCallsInFlight', 'mcpRequestsInFlight', 'registeredTools']) {
    new Gauge({
      name: `anythingmcp_${name.replace(/([A-Z])/g, '_$1').toLowerCase()}`,
      help: `Mirror of processGauges['${name}'].`,
      registers: [registry],
      collect() {
        this.set(processGauges.snapshot()[name] ?? 0);
      },
    });
  }

  const port = Number(process.env.METRICS_PORT) || 9464;
  const host = process.env.METRICS_HOST || '0.0.0.0';
  const reg = registry;

  server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !sameSecret(presented, token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    sendMetrics(reg, res);
  });

  // listen() emits 'error' instead of throwing (e.g. EADDRINUSE) — without a
  // handler that's an uncaught exception that takes the whole backend down,
  // not just the metrics listener.
  server.on('error', (err) => {
    logger.error(`[metrics] listener failed, metrics stay off: ${err}`);
    server = null;
    registry = null;
    toolCallsTotal = null;
    toolCallDuration = null;
    upstreamErrorsTotal = null;
  });

  server.listen(port, host, () => {
    logger.log(`[metrics] listening on http://${host}:${port}/metrics`);
  });

  return server;
}

export function stopMetricsServer(): Promise<void> {
  const current = server;
  server = null;
  registry = null;
  toolCallsTotal = null;
  toolCallDuration = null;
  upstreamErrorsTotal = null;
  toolLabelsEnabled = false;
  toolLabelsWarned = false;
  if (!current) return Promise.resolve();
  return new Promise((resolve) => current.close(() => resolve()));
}
