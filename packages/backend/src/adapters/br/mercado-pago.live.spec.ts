import * as adapter from './mercado-pago.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Mercado Pago REST API (mercadopago.com/developers/en/reference): Bearer access token,
 * api.mercadopago.com. Release reports (list, generate, download) were checked read-only
 * against a live account on 22 Oct 2026.
 * Live part: MERCADO_PAGO_ACCESS_TOKEN=APP_USR-... RUN_MERCADO_PAGO_LIVE=1 npx jest src/adapters/br/mercado-pago
 * (reads only: account, one page of payments, the release report list).
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
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
  return out;
};
const PREFIX = 'mercado_pago_';
const WRITES: string[] = [];

describe('mercado-pago adapter: static spec conformance', () => {

  it('sends the access token as a Bearer token to api.mercadopago.com', () => {
    expect(a.requiredEnvVars).toEqual(['MERCADO_PAGO_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.mercadopago.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MERCADO_PAGO_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.MERCADO_PAGO_ACCESS_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.MERCADO_PAGO_ACCESS_TOKEN.pattern as string).test('APP_USR-1234567890123456-102213-0123456789abcdef0123456789abcdef-704817842')).toBe(true);
    expect(a.category).toBe('payments');
  });

  it('maps the documented routes, including the release report', () => {
    expect(tool('mercado_pago_search_payments').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/payments/search', queryParams: { status: '$status', range: '$range', begin_date: '$begin_date', end_date: '$end_date', limit: '$limit', offset: '$offset' } });
    expect((tool('mercado_pago_search_payments').parameters?.properties?.limit as { maximum: number }).maximum).toBe(100);
    expect(tool('mercado_pago_list_release_reports').endpointMapping.path).toBe('/v1/account/release_report/list');
    expect(tool('mercado_pago_create_release_report').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/account/release_report', bodyMapping: { begin_date: '$begin_date', end_date: '$end_date' } });
    expect(tool('mercado_pago_download_release_report').endpointMapping.path).toBe('/v1/account/release_report/{file_name}');
    expect(tool('mercado_pago_download_settlement_report').endpointMapping.path).toBe('/v1/account/settlement_report/{file_name}');
    expect(tool('mercado_pago_search_merchant_orders').endpointMapping.path).toBe('/merchant_orders/search');
    expect(tool('mercado_pago_search_subscriptions').endpointMapping.path).toBe('/preapproval/search');
  });

  it('moves no money: the only non-GET tools generate reports', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(['mercado_pago_create_release_report', 'mercado_pago_create_settlement_report']);
    for (const n of writes) expect(tool(n).annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/refund|payouts|money_requests|preferences/);
  });

  it('keeps a page of payments small', () => {
    const raw = { paging: { total: 1, limit: 30, offset: 0 }, results: [{ id: 1, status: 'approved', transaction_amount: 10, transaction_details: { net_received_amount: 9.1 }, charges_details: [{ big: 'x' }], card: { first_six_digits: '1' } }] };
    const out = applyResponseTransform(raw, tool('mercado_pago_search_payments').responseMapping as never).value as { paging: unknown; results: Record<string, unknown>[] };
    expect(out.paging).toEqual(raw.paging);
    expect(out.results[0]).toMatchObject({ id: 1, status: 'approved', transaction_amount: 10, net_received_amount: 9.1 });
    expect(out.results[0].charges_details).toBeUndefined();
    expect(out.results[0].card).toBeUndefined();
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

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
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
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_MERCADO_PAGO_LIVE === '1' && process.env.MERCADO_PAGO_ACCESS_TOKEN ? describe : describe.skip;
live('mercado-pago adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN ?? ''}`, Accept: 'application/json' };
  it('reads the account, a page of payments and the release report list', async () => {
    const me = (await (await fetch(`${a.connector.baseUrl}/users/me`, { headers })).json()) as { id: number; site_id: string };
    expect(typeof me.id).toBe('number');
    const pays = (await (await fetch(`${a.connector.baseUrl}/v1/payments/search?limit=1&begin_date=NOW-30DAYS&end_date=NOW`, { headers })).json()) as { paging: { total: number } };
    expect(typeof pays.paging.total).toBe('number');
    const reports = await (await fetch(`${a.connector.baseUrl}/v1/account/release_report/list`, { headers })).json();
    expect(Array.isArray(reports)).toBe(true);
  }, 60_000);
});
