import { register as globalRegistry } from 'prom-client';
import { recordToolCall, startMetricsServer, stopMetricsServer } from './metrics';

const PORT = 19464;
const BASE = `http://127.0.0.1:${PORT}/metrics`;
const DEFAULT_TOKEN = 'a-very-long-test-token-value';
const AUTH = { Authorization: `Bearer ${DEFAULT_TOKEN}` };

/** server.listen() resolves asynchronously; retry past the brief window before it's bound. */
async function fetchReady(url: string, init?: RequestInit, attempts = 20): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error('unreachable');
}

const ENV_KEYS = [
  'METRICS_ENABLED',
  'METRICS_PORT',
  'METRICS_HOST',
  'METRICS_TOKEN',
  'METRICS_TOOL_LABELS',
  'DEPLOYMENT_MODE',
] as const;

describe('metrics', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.METRICS_PORT = String(PORT);
    // METRICS_TOKEN is required whenever METRICS_ENABLED=true; most tests
    // below are about something else, so give them a working token by
    // default and have the token-specific tests override/delete it.
    process.env.METRICS_TOKEN = DEFAULT_TOKEN;
  });

  afterEach(async () => {
    await stopMetricsServer();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('does not start a listener or collect default metrics when METRICS_ENABLED is unset', async () => {
    const server = startMetricsServer();
    expect(server).toBeNull();

    // recordToolCall before/without a running server is a no-op, not a throw.
    expect(() =>
      recordToolCall({ connectorType: 'rest', status: 'success', durationMs: 12 }),
    ).not.toThrow();

    await expect(fetch(BASE)).rejects.toThrow();

    // Default metrics are only ever registered on our own Registry, never
    // the global one prom-client exports — so the global stays empty even
    // after other tests in this file enable metrics.
    const globalText = await globalRegistry.metrics();
    expect(globalText.trim()).toBe('');
  });

  it('refuses to start on self-hosted without METRICS_TOKEN, and logs an error', async () => {
    process.env.METRICS_ENABLED = 'true';
    delete process.env.METRICS_TOKEN;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const server = startMetricsServer();
    expect(server).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('METRICS_TOKEN');
    await expect(fetch(BASE)).rejects.toThrow();

    errorSpy.mockRestore();
  });

  it('refuses to start on Cloud without METRICS_TOKEN', async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.DEPLOYMENT_MODE = 'cloud';
    delete process.env.METRICS_TOKEN;

    const server = startMetricsServer();
    expect(server).toBeNull();
    await expect(fetch(BASE)).rejects.toThrow();
  });

  it('serves Prometheus text on GET /metrics, and the counters/histogram move after a tool call', async () => {
    process.env.METRICS_ENABLED = 'true';
    const server = startMetricsServer();
    expect(server).not.toBeNull();

    const before = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(before).toContain('# HELP anythingmcp_tool_calls_total');
    expect(before).not.toMatch(/anythingmcp_tool_calls_total\{[^}]*}\s+1/);

    recordToolCall({ connectorType: 'rest', status: 'success', durationMs: 250, upstreamStatus: 200 });

    const res = await fetch(BASE, { headers: AUTH });
    expect(res.status).toBe(200);
    const after = await res.text();
    expect(after).toMatch(/anythingmcp_tool_calls_total\{connector_type="rest",status="success"}\s+1/);
    // durationMs: 250 -> 0.25s; the histogram's _sum for this label set must
    // actually reflect the observed value, not just mention the metric name.
    expect(after).toMatch(/anythingmcp_tool_call_duration_seconds_sum\{connector_type="rest",status="success"}\s+0\.25/);
    expect(after).toMatch(/anythingmcp_tool_call_duration_seconds_count\{connector_type="rest",status="success"}\s+1/);
    // A 200 upstream status is not an error: the counter is declared (HELP
    // line present) but never incremented, so no series exists for it at all.
    expect(after).toContain('# HELP anythingmcp_tool_call_upstream_errors_total');
    expect(after).not.toMatch(/anythingmcp_tool_call_upstream_errors_total\{[^}]*}\s+\d/);
  });

  it('returns 404 on any path other than GET /metrics', async () => {
    process.env.METRICS_ENABLED = 'true';
    startMetricsServer();

    // 404 is decided before the auth check, so these need no token either way.
    expect((await fetchReady(`http://127.0.0.1:${PORT}/other`)).status).toBe(404);
    expect((await fetch(BASE, { method: 'POST' })).status).toBe(404);
  });

  it('returns 401 on a missing or wrong bearer token', async () => {
    process.env.METRICS_ENABLED = 'true';
    startMetricsServer();

    expect((await fetchReady(BASE)).status).toBe(401);
    expect((await fetch(BASE, { headers: { Authorization: 'Bearer wrong-token' } })).status).toBe(401);

    const ok = await fetch(BASE, { headers: AUTH });
    expect(ok.status).toBe(200);
  });

  it('logs and leaves metrics off, without crashing, when the port is already taken', async () => {
    process.env.METRICS_ENABLED = 'true';
    const first = startMetricsServer();
    expect(first).not.toBeNull();
    await fetchReady(BASE, { headers: AUTH }); // wait for the first listener to actually be bound

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const second = startMetricsServer();
    // The http.Server instance is still returned synchronously; 'error' fires
    // asynchronously once the EADDRINUSE bind attempt actually fails.
    expect(second).not.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[metrics]');

    errorSpy.mockRestore();
    // Only close the first (still-bound) server; stopMetricsServer() in
    // afterEach now points at the second, failed attempt (null internally).
    await new Promise((resolve) => first!.close(() => resolve(undefined)));
  });

  it('ignores METRICS_TOOL_LABELS on Cloud and warns once, never adding connector_id/tool', async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.DEPLOYMENT_MODE = 'cloud';
    process.env.METRICS_TOOL_LABELS = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    startMetricsServer();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('METRICS_TOOL_LABELS');

    recordToolCall({
      connectorType: 'rest',
      status: 'success',
      durationMs: 5,
      connectorId: 'conn_abc123',
      tool: 'my_tool',
    });

    const text = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(text).toMatch(/anythingmcp_tool_calls_total\{connector_type="rest",status="success"}\s+1/);
    expect(text).not.toContain('connector_id');
    expect(text).not.toContain('conn_abc123');
    expect(text).not.toContain('my_tool');

    warnSpy.mockRestore();
  });

  it('never leaks connector_id/tool on self-hosted when METRICS_TOOL_LABELS is unset, even if the caller passes them', async () => {
    process.env.METRICS_ENABLED = 'true';
    startMetricsServer();

    recordToolCall({
      connectorType: 'rest',
      status: 'success',
      durationMs: 5,
      connectorId: 'conn_should_not_leak',
      tool: 'tool_should_not_leak',
    });

    const text = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(text).not.toContain('connector_id');
    expect(text).not.toContain('conn_should_not_leak');
    expect(text).not.toContain('tool_should_not_leak');
  });

  it('adds connector_id/tool labels on self-hosted when METRICS_TOOL_LABELS=true', async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_TOOL_LABELS = 'true';
    startMetricsServer();

    recordToolCall({
      connectorType: 'rest',
      status: 'error',
      durationMs: 5,
      connectorId: 'conn_abc123',
      tool: 'my_tool',
    });

    const text = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(text).toContain('connector_id="conn_abc123"');
    expect(text).toContain('tool="my_tool"');
  });

  it('counts a 4xx or 5xx upstream status, but never a success', async () => {
    process.env.METRICS_ENABLED = 'true';
    startMetricsServer();

    recordToolCall({ connectorType: 'rest', status: 'error', durationMs: 1, upstreamStatus: 404 });
    recordToolCall({ connectorType: 'rest', status: 'error', durationMs: 1, upstreamStatus: 503 });
    recordToolCall({ connectorType: 'rest', status: 'error', durationMs: 1 }); // no upstream status at all
    recordToolCall({ connectorType: 'rest', status: 'success', durationMs: 1, upstreamStatus: 200 });

    const text = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(text).toMatch(/upstream_status_class="4xx"}\s+1/);
    expect(text).toMatch(/upstream_status_class="5xx"}\s+1/);
    expect(text).not.toContain('upstream_status_class="none"');
    // Exactly the 4xx and 5xx calls counted — not the other two.
    const matches = text.match(/anythingmcp_tool_call_upstream_errors_total\{[^}]*}\s+\d+/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('mirrors processGauges at scrape time', async () => {
    process.env.METRICS_ENABLED = 'true';
    startMetricsServer();

    const { processGauges } = await import('./process-vitals');
    processGauges.inc('toolCallsInFlight', 3);

    const text = await (await fetchReady(BASE, { headers: AUTH })).text();
    expect(text).toMatch(/anythingmcp_tool_calls_in_flight\s+3/);

    processGauges.reset();
  });
});
