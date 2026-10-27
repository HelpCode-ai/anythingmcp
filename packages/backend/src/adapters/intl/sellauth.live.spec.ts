import * as adapter from './sellauth.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * SellAuth API v1 (docs.sellauth.com, OpenAPI at /openapi.yaml): Bearer API key, shop-scoped routes.
 * Every tool was checked read-only against a live
 * account on 22 Oct 2026.
 * Live part: SELLAUTH_API_KEY=... SELLAUTH_SHOP_ID=... RUN_SELLAUTH_LIVE=1 npx jest src/adapters/intl/sellauth
 * (reads only: shops, analytics, one invoice page).
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
const PREFIX = 'sellauth_';
const WRITES: string[] = [];

describe('sellauth adapter: static spec conformance', () => {

  it('sends the API key as Bearer and scopes every shop route to SELLAUTH_SHOP_ID', () => {
    expect(a.requiredEnvVars).toEqual(['SELLAUTH_API_KEY', 'SELLAUTH_SHOP_ID']);
    expect(a.connector.baseUrl).toBe('https://api.sellauth.com/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SELLAUTH_API_KEY}}' });
    expect(a.envVarMeta?.SELLAUTH_API_KEY.secret).toBe(true);
    for (const t of a.tools) if (t.name !== 'sellauth_list_shops') expect(t.endpointMapping.path.startsWith('/shops/{{SELLAUTH_SHOP_ID}}/')).toBe(true);
    expect(tool('sellauth_list_invoices').endpointMapping.queryParams).toMatchObject({ 'statuses[]': '$statuses', created_at_start: '$created_at_start', perPage: '$perPage' });
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('never hands shop secrets or delivered product keys to the model', () => {
    const shops = applyResponseTransform([{ id: 1, name: 'S', discord_bot_token: 't', discord_client_secret: 'c', webhook_secret: 'w', subscription_plan: { name: 'Pro' } }], tool('sellauth_list_shops').responseMapping as never).value;
    expect(JSON.stringify(shops)).not.toMatch(/discord_bot_token|discord_client_secret|webhook_secret/);
    const inv = applyResponseTransform(
      { id: 5, salt: 's', delivered: 'KEY-1', ip: '1.2.3.4', items: [{ id: 1, delivered: 'KEY-2', deliverables: ['KEY-3'], product: { name: 'P', deliverables: 'KEY-4' } }] },
      tool('sellauth_get_invoice').responseMapping as never,
    ).value;
    expect(JSON.stringify(inv)).not.toMatch(/KEY-|"salt"|1\.2\.3\.4/);
    expect(inv).toMatchObject({ id: 5, items: [{ id: 1, product: { name: 'P' } }] });
    const prod = applyResponseTransform({ id: 9, name: 'P', deliverables: 'KEY-5', variants: [{ id: 1, name: 'V', deliverables: 'KEY-6' }] }, tool('sellauth_get_product').responseMapping as never).value;
    expect(JSON.stringify(prod)).not.toMatch(/KEY-/);
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

const live = process.env.RUN_SELLAUTH_LIVE === '1' && process.env.SELLAUTH_API_KEY && process.env.SELLAUTH_SHOP_ID ? describe : describe.skip;
live('sellauth adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.SELLAUTH_API_KEY ?? ''}`, Accept: 'application/json' };
  const shop = `${a.connector.baseUrl}/shops/${process.env.SELLAUTH_SHOP_ID ?? ''}`;
  it('reads shops, analytics and a page of invoices', async () => {
    const shops = (await (await fetch(`${a.connector.baseUrl}/shops`, { headers })).json()) as Array<{ id: number }>;
    expect(shops.map((s) => String(s.id))).toContain(process.env.SELLAUTH_SHOP_ID);
    const stats = (await (await fetch(`${shop}/analytics`, { headers })).json()) as { revenue: number };
    expect(typeof stats.revenue).toBe('number');
    const inv = (await (await fetch(`${shop}/invoices?perPage=1`, { headers })).json()) as { total: number };
    expect(typeof inv.total).toBe('number');
  }, 60_000);
});
