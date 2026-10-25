import * as adapter from './noon-payments.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * noon payments API (docs.noonpayments.com, API reference pages Payment / Report / Subscription / Token):
 * {endpoint}/payment/v1/order and {endpoint}/report/v1, header Authorization: Key Base64(Business.Application:Key).
 * There is no read without an order id or reference, so the adapter declares no install probe.
 * Live part: NOON_PAYMENTS_API_URL=https://api-test.noonpayments.com NOON_PAYMENTS_AUTH_KEY=... NOON_PAYMENTS_ORDER_REFERENCE=...
 *   RUN_NOON_PAYMENTS_LIVE=1 npx jest src/adapters/intl/noon-payments (reads only: one order by reference).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Connector variables (upper case) are filled in by the connector, not by the model.
const isEnv = (p: string) => /^[A-Z][A-Z0-9_]*$/.test(p);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const p of [...out]) if (isEnv(p)) out.delete(p);
  return out;
};

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock;
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Runs a tool through the real REST engine (axios mocked) and returns the request it built.
const request = async (name: string, args: Record<string, unknown>, env: Record<string, string> = {}) => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => env[k] ?? '');
  const authConfig = JSON.parse(fill(JSON.stringify(a.connector.authConfig ?? {})));
  await engine().execute(
    { baseUrl: fill(a.connector.baseUrl), authType: a.connector.authType, authConfig, headers: a.connector.headers } as never,
    JSON.parse(fill(JSON.stringify(tool(name).endpointMapping))),
    { ...env, ...args },
  );
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as { method: string; url: string; params?: Record<string, unknown>; data?: unknown; headers: Record<string, string> };
};
const PREFIX = 'noon_payments_';
const WRITES: string[] = ["noon_payments_capture_order", "noon_payments_refund_order"];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('noon-payments adapter: static spec conformance', () => {
  it('sends the Base64 key with the Key scheme to the configured endpoint', async () => {
    expect(a.requiredEnvVars).toEqual(['NOON_PAYMENTS_API_URL', 'NOON_PAYMENTS_AUTH_KEY']);
    expect(a.connector.baseUrl).toBe('{{NOON_PAYMENTS_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Key {{NOON_PAYMENTS_AUTH_KEY}}' });
    expect(a.envVarMeta?.NOON_PAYMENTS_AUTH_KEY.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.NOON_PAYMENTS_API_URL.pattern as string);
    for (const ok of ['https://api.noonpayments.com', 'https://api-test.noonpayments.com', 'https://api.sa.noonpayments.com', 'https://api-test.eg.noonpayments.com']) expect(`${ok}:${re.test(ok)}`).toBe(`${ok}:true`);
    expect(re.test('https://api.noonpayments.com/payment/v1')).toBe(false);
    const req = await request('noon_payments_get_order', { order_id: '123456789012' }, { NOON_PAYMENTS_API_URL: 'https://api-test.noonpayments.com', NOON_PAYMENTS_AUTH_KEY: 'YnVzLmFwcDprZXk=' });
    expect(req.url).toBe('https://api-test.noonpayments.com/payment/v1/order/123456789012');
    expect(req.headers.Authorization).toBe('Key YnVzLmFwcDprZXk=');
  });

  it('maps the documented order, report, subscription and token calls', async () => {
    const env = { NOON_PAYMENTS_API_URL: 'https://api.noonpayments.com', NOON_PAYMENTS_AUTH_KEY: 'k' };
    const byRef = await request('noon_payments_get_order_by_reference', { order_reference: 'ORD#1', verbose: true }, env);
    expect(byRef.url).toBe('https://api.noonpayments.com/payment/v1/order/getbyreference/ORD%231');
    expect(byRef.params).toEqual({ verbose: true });
    const rep = await request('noon_payments_list_scheduled_reports', { year: 2026, month: 10, day: 20, report_type: 'ReconciliationSettlement' }, env);
    expect(rep.url).toBe('https://api.noonpayments.com/report/v1/data/GetScheduleReports');
    expect(rep.params).toEqual({ year: 2026, month: 10, day: 20, reportType: 'ReconciliationSettlement' });
    const sub = await request('noon_payments_get_subscription', { subscription_id: 's-1' }, env);
    expect(sub.data).toEqual({ apiOperation: 'RETRIEVE_SUBSCRIPTION', subscription: { identifier: 's-1' } });
    expect(tool('noon_payments_get_card_token').endpointMapping.path).toBe('/payment/v1/token/{token_identifier}');
    expect(a.probe).toBeUndefined();
  });

  it('keeps capture and refund switched off with the documented bodies', async () => {
    const env = { NOON_PAYMENTS_API_URL: 'https://api.noonpayments.com', NOON_PAYMENTS_AUTH_KEY: 'k' };
    const cap = await request('noon_payments_capture_order', { order_id: '123456789012', amount: 10, currency: 'AED', final_capture: true }, env);
    expect(cap.url).toBe('https://api.noonpayments.com/payment/v1/order');
    expect(cap.data).toEqual({ apiOperation: 'CAPTURE', order: { id: '123456789012' }, transaction: { amount: 10, currency: 'AED', finalCapture: true } });
    const ref = await request('noon_payments_refund_order', { order_id: '123456789012', amount: 5, currency: 'AED', capture_transaction_id: '959' }, env);
    expect(ref.data).toEqual({ apiOperation: 'REFUND', order: { id: '123456789012' }, transaction: { amount: 5, currency: 'AED', targetTransactionIdentifier: '959' } });
    expect(tool('noon_payments_refund_order').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated and installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toBeUndefined();
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_NOON_PAYMENTS_LIVE === '1' && process.env.NOON_PAYMENTS_API_URL && process.env.NOON_PAYMENTS_AUTH_KEY && process.env.NOON_PAYMENTS_ORDER_REFERENCE ? describe : describe.skip;
live('noon-payments adapter: live (read-only)', () => {
  const base = (process.env.NOON_PAYMENTS_API_URL ?? '').replace(/\/$/, '');
  const headers = { Authorization: `Key ${process.env.NOON_PAYMENTS_AUTH_KEY}`, Accept: 'application/json' };
  it('reads one order by its merchant reference', async () => {
    const res = await fetch(`${base}/payment/v1/order/getbyreference/${encodeURIComponent(process.env.NOON_PAYMENTS_ORDER_REFERENCE as string)}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resultCode: number; result: { order: { status: string } } };
    expect(body.resultCode).toBe(0);
    expect(typeof body.result.order.status).toBe('string');
  }, 60_000);
});
