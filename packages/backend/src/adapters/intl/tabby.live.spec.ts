import * as adapter from './tabby.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Tabby API (docs.tabby.ai, OpenAPI at docs.tabby.ai/openapi.yaml): region-specific base URL https://api.tabby.ai (UAE)
 * or https://api.tabby.sa (KSA), Bearer secret key; payments /api/v2, disputes and webhooks /api/v1.
 * Live part: TABBY_API_URL=https://api.tabby.ai TABBY_SECRET_KEY=sk_test_... RUN_TABBY_LIVE=1 npx jest src/adapters/intl/tabby
 * (reads only: the latest payment, and that payment by id).
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
const PREFIX = 'tabby_';
const WRITES: string[] = ["tabby_create_capture", "tabby_create_refund", "tabby_close_payment"];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('tabby adapter: static spec conformance', () => {
  it('sends the secret key as a Bearer token to the configured Tabby region', () => {
    expect(a.requiredEnvVars).toEqual(['TABBY_API_URL', 'TABBY_SECRET_KEY']);
    expect(a.connector.baseUrl).toBe('{{TABBY_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TABBY_SECRET_KEY}}' });
    expect(a.envVarMeta?.TABBY_SECRET_KEY.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.TABBY_API_URL.pattern as string);
    expect(re.test('https://api.tabby.ai')).toBe(true);
    expect(re.test('https://api.tabby.sa')).toBe(true);
    expect(re.test('https://checkout.tabby.ai')).toBe(false);
    expect(a.probe).toEqual({ tool: 'tabby_search_payments', params: { limit: 1 } });
  });

  it('maps the documented payment, checkout, dispute and webhook routes', async () => {
    const list = await request('tabby_search_payments', { limit: 20, offset: 40, status: 'closed', created_from: '2026-10-01', created_to: '2026-10-20' }, { TABBY_API_URL: 'https://api.tabby.sa', TABBY_SECRET_KEY: 'sk_test_x' });
    expect(list.url).toBe('https://api.tabby.sa/api/v2/payments');
    expect(list.params).toEqual({ limit: 20, offset: 40, status: 'closed', created_at__gte: '2026-10-01', created_at__lte: '2026-10-20' });
    expect(list.headers.Authorization).toBe('Bearer sk_test_x');
    expect(tool('tabby_get_payment_details').endpointMapping.path).toBe('/api/v2/payments/{payment_id}');
    expect(tool('tabby_get_checkout_session').endpointMapping.path).toBe('/api/v2/checkout/{session_id}');
    expect(tool('tabby_list_disputes').endpointMapping.queryParams).toEqual({ statuses: '$statuses', created_at_gte: '$created_from', created_at_lte: '$created_to', page_token: '$page_token' });
    expect(tool('tabby_get_dispute').endpointMapping.path).toBe('/api/v1/disputes/{dispute_id}');
    const hooks = await request('tabby_list_webhooks', { merchant_code: 'ae_store' }, { TABBY_API_URL: 'https://api.tabby.ai', TABBY_SECRET_KEY: 'sk_x' });
    expect(hooks.url).toBe('https://api.tabby.ai/api/v1/webhooks');
    expect(hooks.headers['X-Merchant-Code']).toBe('ae_store');
  });

  it('keeps money moves switched off with the documented bodies', () => {
    expect(tool('tabby_create_capture').endpointMapping).toMatchObject({ method: 'POST', path: '/api/v2/payments/{payment_id}/captures', bodyMapping: { amount: '$amount', reference_id: '$reference_id' } });
    expect(tool('tabby_create_refund').endpointMapping).toMatchObject({ method: 'POST', path: '/api/v2/payments/{payment_id}/refunds', bodyMapping: { amount: '$amount', reference_id: '$reference_id', reason: '$reason', items: '$items' } });
    expect(tool('tabby_close_payment').endpointMapping).toMatchObject({ method: 'POST', path: '/api/v2/payments/{payment_id}/close' });
    expect(tool('tabby_create_refund').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('tabby_close_payment').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('never hands the checkout token or the webhook signing value to the model', () => {
    const session = transform('tabby_get_checkout_session', { id: 's1', status: 'approved', token: 'tok_secret', payment: { id: 'p1', order_history: [{ amount: '1' }] }, merchant_urls: { success: 'https://x' } }) as Record<string, unknown>;
    expect(session).toEqual({ id: 's1', status: 'approved', payment: { id: 'p1' } });
    expect(JSON.stringify(transform('tabby_list_webhooks', { id: 'w1', url: 'https://x', header: { title: 'X-Sig', value: 'secret' } }))).not.toMatch(/secret/);
    expect(JSON.stringify(transform('tabby_list_webhooks', [{ id: 'w1', header: { title: 'X-Sig', value: 'secret' } }]))).not.toMatch(/secret/);
    const list = transform('tabby_search_payments', { payments: [{ id: 'p1', order_history: [{}], buyer_history: {}, buyer: { name: 'A' } }], pagination: { total_count: 1 } });
    expect(list).toEqual({ payments: [{ id: 'p1', buyer: { name: 'A' } }], pagination: { total_count: 1 } });
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

const live = process.env.RUN_TABBY_LIVE === '1' && process.env.TABBY_API_URL && process.env.TABBY_SECRET_KEY ? describe : describe.skip;
live('tabby adapter: live (read-only)', () => {
  const base = (process.env.TABBY_API_URL ?? '').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.TABBY_SECRET_KEY}`, Accept: 'application/json' };
  it('lists payments and reads the first one by id', async () => {
    const res = await fetch(`${base}/api/v2/payments?limit=1`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payments: Array<{ id: string }>; pagination: { total_count: number } };
    expect(Array.isArray(body.payments)).toBe(true);
    if (body.payments[0]) {
      const one = await fetch(`${base}/api/v2/payments/${body.payments[0].id}`, { headers });
      expect(one.status).toBe(200);
    }
  }, 60_000);
});
