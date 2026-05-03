/**
 * OpenTelemetry tracing — opt-in.
 *
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise no-op so
 * the default install ships nothing.
 *
 * Auto-instrumentations cover http / express / pg / mysql / redis / etc.,
 * which gives a usable trace per request without any per-route plumbing.
 *
 * Sentry already provides its own tracing pipeline; if SENTRY_DSN and
 * OTEL_EXPORTER_OTLP_ENDPOINT are both set the operator gets two parallel
 * traces and that's intentional — they serve different consumers
 * (Sentry for error correlation, OTLP for an in-house collector).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
// Use string keys directly so we don't need the /incubating subpath, which
// requires nodenext module resolution. These constants are stable in the
// OTel semantic conventions and aren't going to be renamed.
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

export function startTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'anythingmcp-backend',
      [ATTR_SERVICE_VERSION]:
        process.env.OTEL_SERVICE_VERSION ||
        process.env.npm_package_version ||
        '0.0.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        process.env.OTEL_DEPLOYMENT_ENVIRONMENT ||
        process.env.NODE_ENV ||
        'development',
    }),
    traceExporter: new OTLPTraceExporter({
      // Standard OTLP/HTTP. Honours OTEL_EXPORTER_OTLP_HEADERS for auth
      // (e.g. "authorization=Bearer …" → maps to a header by the SDK).
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Drop noisy fs spans (one per file read on cold start).
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // /health is a liveness probe that fires every few seconds; ignore.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => {
            const url = (req as { url?: string }).url || '';
            return url === '/health' || url.startsWith('/health?');
          },
        },
      }),
    ],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch(() => {
        /* swallow — we're shutting down anyway */
      });
  });
}
