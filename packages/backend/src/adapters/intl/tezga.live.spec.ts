import * as adapter from './tezga.json';

/**
 * Tezga eKasa public API (OpenAPI 3.1 at https://pos.narbiz.com/api/openapi.json, guide at
 * https://tezgafiskal.com/api-za-fiskalizaciju; key tzg_... in the X-Tezga-Api-Key header).
 * Reads tax labels and environment, documents and bank transactions; fiscal writes install switched off.
 * Live part: TEZGA_API_KEY=tzg_... RUN_TEZGA_LIVE=1 npx jest src/adapters/intl/tezga
 * (reads only: tax labels and environment, bank transactions).
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
const PREFIX = 'tezga_';
const WRITES: string[] = ['tezga_issue_receipt', 'tezga_refund_document', 'tezga_upsert_customers', 'tezga_upsert_products'];

describe('tezga adapter: static spec conformance', () => {
  it('sends the key in X-Tezga-Api-Key to the documented host', () => {
    expect(a.requiredEnvVars).toEqual(['TEZGA_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://pos.narbiz.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Tezga-Api-Key', apiKey: '{{TEZGA_API_KEY}}' });
    expect(a.envVarMeta?.TEZGA_API_KEY.secret).toBe(true);
    const key = new RegExp(a.envVarMeta?.TEZGA_API_KEY.pattern as string);
    expect(key.test(`tzg_${'a1'.repeat(24)}`)).toBe(true);
    expect(key.test('tzg_short')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/api/integrations/')).toBe(true);
  });

  it('maps the documented routes', () => {
    expect(tool('tezga_get_account_setup').endpointMapping).toEqual({ method: 'GET', path: '/api/integrations/tax-labels' });
    expect(tool('tezga_get_document').endpointMapping).toEqual({ method: 'GET', path: '/api/integrations/documents/{document_id}' });
    expect(tool('tezga_find_document').endpointMapping).toEqual({ method: 'GET', path: '/api/integrations/documents', queryParams: { externalId: '$externalId', provider: '$provider' } });
    expect(tool('tezga_list_bank_transactions').endpointMapping).toEqual({ method: 'GET', path: '/api/integrations/transactions', queryParams: { smer: '$smer', since: '$since', limit: '$limit' } });
    expect(tool('tezga_issue_receipt').endpointMapping).toMatchObject({ method: 'POST', path: '/api/integrations/order', queryParams: { provider: 'custom' }, bodyMapping: { externalId: '$externalId', stavke: '$stavke', kupac: '$kupac', nacinPlacanja: '$nacinPlacanja', tok: '$tok' } });
    expect(tool('tezga_issue_receipt').parameters?.required).toEqual(['externalId', 'stavke']);
    expect(tool('tezga_refund_document').endpointMapping).toMatchObject({ method: 'POST', path: '/api/integrations/refund', bodyMapping: { vrsta: '$vrsta', documentId: '$documentId', externalId: '$externalId', stavke: '$stavke' } });
    expect(tool('tezga_upsert_customers').endpointMapping).toEqual({ method: 'POST', path: '/api/integrations/customers', bodyMapping: { kupci: '$kupci' } });
    expect(tool('tezga_upsert_products').endpointMapping).toEqual({ method: 'POST', path: '/api/integrations/products', bodyMapping: { stavke: '$stavke' } });
    for (const n of ['tezga_refund_document', 'tezga_upsert_customers', 'tezga_upsert_products']) expect(tool(n).annotations?.destructiveHint).toBe(true);
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
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('probes with a parameter-free read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});


const live = process.env.RUN_TEZGA_LIVE === '1' && process.env.TEZGA_API_KEY ? describe : describe.skip;
live('tezga adapter: live (read-only)', () => {
  const headers = { 'X-Tezga-Api-Key': process.env.TEZGA_API_KEY ?? '', Accept: 'application/json' };
  it('reads the environment and tax labels, then bank transactions', async () => {
    const setup = (await (await fetch(`${a.connector.baseUrl}/api/integrations/tax-labels`, { headers })).json()) as { okruzenje: string; oznake: unknown[] };
    expect(['produkcija', 'sandbox', 'simulacija', 'nepovezano']).toContain(setup.okruzenje);
    expect(Array.isArray(setup.oznake)).toBe(true);
    const tx = await fetch(`${a.connector.baseUrl}/api/integrations/transactions?limit=1`, { headers });
    expect(tx.status).toBe(200);
  }, 60_000);
});
