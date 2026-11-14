import * as adapter from './flour.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Flour REST API v3 (OpenAPI at backend.flour.cloud/api/docs-json; base URL https://flour.host/v3; Bearer
 * token issued by developer@flour.io). Sold articles, documents,
 * articles, stocks and branches were checked read-only against a live account on 22 Oct 2026.
 * Live part: FLOUR_API_TOKEN=... RUN_FLOUR_LIVE=1 npx jest src/adapters/de/flour
 * (reads only: stocks, one article, the last day's sold articles).
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
const PREFIX = 'flour_';
const WRITES: string[] = [];

describe('flour adapter: static spec conformance', () => {

  it('sends the token as Bearer to the documented v3 base URL', () => {
    expect(a.requiredEnvVars).toEqual(['FLOUR_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://flour.host');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{FLOUR_API_TOKEN}}' });
    expect(a.envVarMeta?.FLOUR_API_TOKEN.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v3/')).toBe(true);
  });

  it('maps the documented read routes', () => {
    expect(tool('flour_get_sold_articles').endpointMapping).toMatchObject({ path: '/v3/documents/sold-articles', queryParams: { dateAfter: '$dateAfter', dateBefore: '$dateBefore', pointofsale: '$pointofsale' } });
    expect(tool('flour_get_sold_articles').parameters?.required).toEqual(['dateAfter', 'dateBefore']);
    expect(tool('flour_list_documents').endpointMapping).toMatchObject({ path: '/v3/documents', queryParams: { type: '$type', dateAfter: '$dateAfter', limit: '$limit', skip: '$skip' } });
    expect(tool('flour_find_article').endpointMapping).toMatchObject({ path: '/v3/articles/find-by-number-or-ean', queryParams: { number: '$number' } });
    // The documented topseller route answered 500 on every live call; sold-articles covers it.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/topseller/);
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('never hands stored credentials (terminal, TSE, bank) to the model', () => {
    const pos = applyResponseTransform(
      [{ _id: 'p1', name: 'Kasse 1', avs: { password: 'x' }, secucard: { key: 'y' }, legal: { de: { fiskaly: { auth: 'z' } } } }],
      tool('flour_list_points_of_sale').responseMapping as never,
    ).value;
    expect(JSON.stringify(pos)).not.toMatch(/password|secucard|fiskaly/);
    const branch = applyResponseTransform([{ _id: 'b1', name: 'Fulda', legal: { de: { fiskaly: { auth: 'z' } } } }], tool('flour_list_branches').responseMapping as never).value;
    expect(JSON.stringify(branch)).not.toMatch(/fiskaly/);
    const bp = applyResponseTransform([{ _id: 'c1', displayName: 'Kunde', bank: { iban: 'DE00' } }], tool('flour_list_business_partners').responseMapping as never).value;
    expect(JSON.stringify(bp)).not.toMatch(/iban/);
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

const live = process.env.RUN_FLOUR_LIVE === '1' && process.env.FLOUR_API_TOKEN ? describe : describe.skip;
live('flour adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.FLOUR_API_TOKEN ?? ''}`, Accept: 'application/json' };
  it('reads stocks, one article and yesterday\'s sold articles', async () => {
    const stocks = await (await fetch(`${a.connector.baseUrl}/v3/stocks?limit=1`, { headers })).json();
    expect(Array.isArray(stocks)).toBe(true);
    const arts = await (await fetch(`${a.connector.baseUrl}/v3/articles?limit=1`, { headers })).json();
    expect(Array.isArray(arts)).toBe(true);
    const to = new Date();
    const from = new Date(to.getTime() - 86_400_000);
    const sold = await (await fetch(`${a.connector.baseUrl}/v3/documents/sold-articles?dateAfter=${from.toISOString()}&dateBefore=${to.toISOString()}`, { headers })).json();
    expect(Array.isArray(sold)).toBe(true);
  }, 60_000);
});
