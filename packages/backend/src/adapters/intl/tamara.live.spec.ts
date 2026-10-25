import * as adapter from './tamara.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Tamara merchant API (docs.tamara.co/reference): https://api.tamara.co or https://api-sandbox.tamara.co, Bearer API token;
 * orders by Tamara order_id and by the merchant order_reference_id, payment types, pre-checkout checks, webhooks,
 * capture and simplified refund.
 * Live part: TAMARA_API_URL=https://api-sandbox.tamara.co TAMARA_API_TOKEN=... RUN_TAMARA_LIVE=1 npx jest src/adapters/intl/tamara
 * (reads only: payment types for SA; with TAMARA_ORDER_REFERENCE=... also that order).
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
const PREFIX = 'tamara_';
const WRITES: string[] = ["tamara_capture_order", "tamara_refund_order"];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('tamara adapter: static spec conformance', () => {
  it('sends the API token as a Bearer token to the chosen Tamara environment', () => {
    expect(a.requiredEnvVars).toEqual(['TAMARA_API_URL', 'TAMARA_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{TAMARA_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TAMARA_API_TOKEN}}' });
    expect(a.envVarMeta?.TAMARA_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.TAMARA_API_URL.pattern as string);
    expect(re.test('https://api.tamara.co')).toBe(true);
    expect(re.test('https://api-sandbox.tamara.co')).toBe(true);
    expect(re.test('https://partners.tamara.co')).toBe(false);
    expect(a.probe).toEqual({ tool: 'tamara_list_payment_types', params: { country: 'SA' } });
  });

  it('maps the documented order lookups and pre-checkout calls', async () => {
    const env = { TAMARA_API_URL: 'https://api-sandbox.tamara.co', TAMARA_API_TOKEN: 'tok' };
    const byRef = await request('tamara_get_order_by_reference', { order_reference_id: 'A#123' }, env);
    expect(byRef.url).toBe('https://api-sandbox.tamara.co/merchants/orders/reference-id/A%23123');
    expect(byRef.headers.Authorization).toBe('Bearer tok');
    expect(tool('tamara_get_order').endpointMapping.path).toBe('/orders/{order_id}');
    const types = await request('tamara_list_payment_types', { country: 'AE', order_value: 300 }, env);
    expect(types.url).toBe('https://api-sandbox.tamara.co/checkout/payment-types');
    expect(types.params).toEqual({ country: 'AE', order_value: 300 });
    const opts = await request('tamara_check_payment_options', { country: 'SA', phone_number: '966501234567', amount: 100, currency: 'SAR' }, env);
    expect(opts.data).toEqual({ country: 'SA', phone_number: '966501234567', order_value: { amount: 100, currency: 'SAR' } });
    const elig = await request('tamara_check_customer_eligibility', { amount: 300, currency: 'SAR', email: 'a@b.co' }, env);
    expect(elig.url).toBe('https://api-sandbox.tamara.co/pre-checkout/v1/eligibility');
    expect(elig.data).toEqual({ order: { amount: 300, currency: 'SAR' }, customer: { email: 'a@b.co' } });
    expect(tool('tamara_get_webhook').endpointMapping.path).toBe('/webhooks/{webhook_id}');
  });

  it('keeps capture and refund switched off with the documented bodies', async () => {
    const env = { TAMARA_API_URL: 'https://api.tamara.co', TAMARA_API_TOKEN: 'tok' };
    const cap = await request('tamara_capture_order', { order_id: 'o1', amount: 300, currency: 'SAR', shipped_at: '2026-10-20T10:00:00Z', shipping_company: 'Aramex' }, env);
    expect(cap.url).toBe('https://api.tamara.co/payments/capture');
    expect(cap.data).toEqual({ order_id: 'o1', total_amount: { amount: 300, currency: 'SAR' }, shipping_info: { shipped_at: '2026-10-20T10:00:00Z', shipping_company: 'Aramex' } });
    const ref = await request('tamara_refund_order', { order_id: 'o1', amount: 50, currency: 'SAR', comment: 'Damaged' }, env);
    expect(ref.url).toBe('https://api.tamara.co/payments/simplified-refund/o1');
    expect(ref.data).toEqual({ total_amount: { amount: 50, currency: 'SAR' }, comment: 'Damaged' });
    expect(tool('tamara_refund_order').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('drops the national id from order details', () => {
    const out = transform('tamara_get_order_by_reference', { order_id: 'o1', status: 'fully_captured', consumer: { first_name: 'Mona', national_id: '1234567890' } });
    expect(out).toEqual({ order_id: 'o1', status: 'fully_captured', consumer: { first_name: 'Mona' } });
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
    const probe = tool(a.probe!.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const r of probe.parameters?.required ?? []) expect(a.probe!.params?.[r]).toBeDefined();
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_TAMARA_LIVE === '1' && process.env.TAMARA_API_URL && process.env.TAMARA_API_TOKEN ? describe : describe.skip;
live('tamara adapter: live (read-only)', () => {
  const base = (process.env.TAMARA_API_URL ?? '').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.TAMARA_API_TOKEN}`, Accept: 'application/json' };
  it('lists payment types and, when given, reads an order by reference', async () => {
    const res = await fetch(`${base}/checkout/payment-types?country=SA`, { headers });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
    const ref = process.env.TAMARA_ORDER_REFERENCE;
    if (ref) {
      const order = await fetch(`${base}/merchants/orders/reference-id/${encodeURIComponent(ref)}`, { headers });
      expect(order.status).toBe(200);
      expect(((await order.json()) as { order_reference_id: string }).order_reference_id).toBe(ref);
    }
  }, 60_000);
});
