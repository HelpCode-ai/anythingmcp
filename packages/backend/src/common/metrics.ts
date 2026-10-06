import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { Logger } from '@nestjs/common';

const logger = new Logger('MetricsService');

export const register = new Registry();

collectDefaultMetrics({ register, prefix: 'anythingmcp_' });

const isCloud = process.env.DEPLOYMENT_MODE === 'cloud';
const toolLabelsEnabled = process.env.METRICS_TOOL_LABELS === 'true' && !isCloud;

if (process.env.METRICS_TOOL_LABELS === 'true' && isCloud) {
  logger.warn('METRICS_TOOL_LABELS is ignored in cloud deployment mode for cardinality safety.');
}

const defaultLabelNames = toolLabelsEnabled ? ['tool_name', 'connector_name', 'status'] : ['status'];

export const toolCallsTotal = new Counter({
  name: 'anythingmcp_tool_calls_total',
  help: 'Total number of tool calls',
  labelNames: defaultLabelNames,
  registers: [register],
});

export const toolCallDurationSeconds = new Histogram({
  name: 'anythingmcp_tool_call_duration_seconds',
  help: 'Duration of tool calls in seconds',
  labelNames: defaultLabelNames,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export function recordToolCall(
  toolName: string,
  connectorName: string,
  status: 'success' | 'error',
  durationMs: number,
) {
  const labels = toolLabelsEnabled
    ? { tool_name: toolName, connector_name: connectorName, status }
    : { status };

  toolCallsTotal.inc(labels);
  toolCallDurationSeconds.observe(labels, durationMs / 1000);
}

let metricsServer: http.Server | null = null;

export function startMetricsServer() {
  const enabled = process.env.METRICS_ENABLED === 'true';
  if (!enabled) return;

  const port = parseInt(process.env.METRICS_PORT || '9464', 10);
  const host = process.env.METRICS_HOST || '0.0.0.0';
  const token = process.env.METRICS_TOKEN;

  if (isCloud && !token) {
    logger.error('CRITICAL: METRICS_ENABLED=true in cloud deployment mode requires METRICS_TOKEN. Metrics server refusing to start.');
    return;
  }

  metricsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    
    if (url.pathname !== '/metrics') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not Found');
      return;
    }

    if (token) {
      const authHeader = req.headers['authorization'];
      let providedToken = '';
      if (authHeader && authHeader.startsWith('Bearer ')) {
        providedToken = authHeader.substring(7);
      } else {
        providedToken = url.searchParams.get('token') || '';
      }

      const tokenBuf = Buffer.from(token);
      const providedBuf = Buffer.from(providedToken);
      
      let isValid = false;
      if (tokenBuf.length === providedBuf.length) {
        try {
          isValid = timingSafeEqual(tokenBuf, providedBuf);
        } catch {
          isValid = false;
        }
      }

      if (!isValid) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Unauthorized');
        return;
      }
    }

    try {
      const metricsData = await register.metrics();
      res.statusCode = 200;
      res.setHeader('Content-Type', register.contentType);
      res.end(metricsData);
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(err?.message || 'Internal Server Error');
    }
  });

  metricsServer.listen(port, host, () => {
    logger.log(`Prometheus metrics server listening on http://${host}:${port}/metrics`);
  });
}

export async function stopMetricsServer(): Promise<void> {
  if (!metricsServer) return;
  return new Promise((resolve) => {
    metricsServer?.close(() => {
      metricsServer = null;
      resolve();
    });
  });
}
