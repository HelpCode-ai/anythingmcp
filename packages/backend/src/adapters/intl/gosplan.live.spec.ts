import * as adapter from './gosplan.json';

/**
 * GosPlan API v2 (https://gosplan.info/docs/, OpenAPI at https://swagger.gosplan.info/fz44/swagger.yaml and the
 * fz223, pprf615 and nsi siblings). Key in the apikey header (Kong key authentication).
 * Paths, parameters and index answers were confirmed on the vendor's keyless test server v2test.gosplan.info
 * (10 requests a minute) on 2026-11-19; the adapter itself points at the production host, which needs a key.
 * Live part (test server, keyless, three calls): RUN_GOSPLAN_LIVE=1 npx jest src/adapters/intl/gosplan
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[] } };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  category: string;
  aliases?: string[];
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  verifyHints?: Record<string, unknown>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values in query, body and headers.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const SLUG = 'gosplan';
const REGION = 'intl';
const BASE = 'https://v2.gosplan.info';
const PREFIX = 'gosplan_';
const ENV_VARS: string[] = ['GOSPLAN_API_KEY'];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  gosplan_search_purchases_44: ['GET', '/fz44/purchases', []],
  gosplan_get_purchase_44: ['GET', '/fz44/purchases/{purchase_number}', ['purchase_number']],
  gosplan_get_purchase_notification: ['GET', '/fz44/purchases/{purchase_number}/notification', ['purchase_number']],
  gosplan_get_purchase_protocols: ['GET', '/fz44/purchases/{purchase_number}/protocols', ['purchase_number']],
  gosplan_get_purchase_clarifications: ['GET', '/fz44/purchases/{purchase_number}/clarifications', ['purchase_number']],
  gosplan_get_purchase_result: ['GET', '/fz44/purchases/{purchase_number}/result', ['purchase_number']],
  gosplan_get_purchase_complaints: ['GET', '/fz44/purchases/{purchase_number}/complaints', ['purchase_number']],
  gosplan_search_contracts_44: ['GET', '/fz44/contracts', []],
  gosplan_get_contract_44: ['GET', '/fz44/contracts/{reg_num}', ['reg_num']],
  gosplan_get_contract_document: ['GET', '/fz44/contracts/{reg_num}/contract', ['reg_num']],
  gosplan_get_contract_procedures: ['GET', '/fz44/contracts/{reg_num}/procedures', ['reg_num']],
  gosplan_search_contract_procedures: ['GET', '/fz44/procedures', []],
  gosplan_get_contract_procedure: ['GET', '/fz44/procedures/{contract_project_number}', ['contract_project_number']],
  gosplan_search_complaints: ['GET', '/fz44/complaints', []],
  gosplan_get_complaint: ['GET', '/fz44/complaints/{reg_number}', ['reg_number']],
  gosplan_search_organizations_44: ['GET', '/fz44/organizations', []],
  gosplan_get_organization_44: ['GET', '/fz44/organizations/{reg_num}', ['reg_num']],
  gosplan_search_tender_plans: ['GET', '/fz44/tenderplans', []],
  gosplan_get_tender_plan: ['GET', '/fz44/tenderplans/{plan_number}', ['plan_number']],
  gosplan_search_plan_positions: ['GET', '/fz44/tenderplans/positions', []],
  gosplan_search_purchases_223: ['GET', '/fz223/purchases', []],
  gosplan_get_purchase_223: ['GET', '/fz223/purchases/{purchase_number}', ['purchase_number']],
  gosplan_search_contracts_223: ['GET', '/fz223/contracts', []],
  gosplan_get_contract_223: ['GET', '/fz223/contracts/{reg_num}', ['reg_num']],
  gosplan_search_organizations_223: ['GET', '/fz223/organizations', []],
  gosplan_search_purchase_plans_223: ['GET', '/fz223/purchaseplans', []],
  gosplan_get_purchase_plan_223: ['GET', '/fz223/purchaseplans/{plan_number}', ['plan_number']],
  gosplan_search_purchases_615: ['GET', '/pprf615/purchases', []],
  gosplan_get_purchase_615: ['GET', '/pprf615/purchases/{purchase_number}', ['purchase_number']],
  gosplan_search_contracts_615: ['GET', '/pprf615/contracts', []],
  gosplan_get_contract_615: ['GET', '/pprf615/contracts/{reg_num}', ['reg_num']],
  gosplan_search_ktru: ['GET', '/nsi/ktru', []],
  gosplan_get_ktru: ['GET', '/nsi/ktru/{code}', ['code']],
};

describe('gosplan adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('government');
    expect(a.requiredEnvVars).toEqual(['GOSPLAN_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'apikey', apiKey: '{{GOSPLAN_API_KEY}}' });
    expect(a.envVarMeta?.GOSPLAN_API_KEY).toMatchObject({ secret: true, kind: 'credential' });
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('probes with a read tool and arguments it declares', () => {
    const p = a.probe!;
    const t = tool(p.tool);
    expect(t.enabled).toBeUndefined();
    const props = Object.keys(t.parameters?.properties ?? {});
    for (const k of Object.keys(p.params ?? {})) expect(props).toContain(k);
    for (const r of t.parameters?.required ?? []) expect(Object.keys(p.params ?? {})).toContain(r);
  });

  it('pins the method, path and required arguments of every tool', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const [name, [method, path, required]] of Object.entries(TOOLS)) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:${path}`);
      expect(`${name}:${(t.parameters?.required ?? []).join(',')}`).toBe(`${name}:${required.join(',')}`);
    }
  });

  it('every tool is prefixed, described, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || ENV_VARS.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs exactly the expected tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...OFF].sort());
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('is read-only and stays on the production host', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.path.startsWith('/')).toBe(true);
      expect(t.endpointMapping.path).toMatch(/^\/(fz44|fz223|pprf615|nsi)\//);
    }
    expect(JSON.stringify(a.connector)).not.toContain('v2test');
  });

  it('covers the endpoints in use and keeps the API parameter names', () => {
    const q = (name: string) => tool(name).endpointMapping.queryParams as Record<string, unknown>;
    expect(q('gosplan_search_purchases_44')).toMatchObject({ object_info: '$object_info', classifier: '$classifier', customer: '$customer', region: '$region', stage: '$stage', max_price_ge: '$max_price_ge', max_price_le: '$max_price_le', published_after: '$published_after', published_before: '$published_before', published_forpast: '$published_forpast', purchase_number: '$purchase_number', limit: '$limit', skip: '$skip', sort: '$sort' });
    expect(q('gosplan_search_contracts_44')).toMatchObject({ supplier: '$supplier', customer: '$customer', subject: '$subject', price_ge: '$price_ge', stage: '$stage', reg_num: '$reg_num' });
    expect(q('gosplan_search_organizations_44')).toMatchObject({ inn: '$inn', reg_num: '$reg_num', region: '$region' });
    for (const s of ['notification', 'protocols', 'clarifications']) expect(a.tools.some((t) => t.endpointMapping.path === `/fz44/purchases/{purchase_number}/${s}`)).toBe(true);
    const p = tool('gosplan_search_purchases_44').parameters?.properties ?? {};
    expect(p.region.type).toBe('integer');
    // One region and one classifier per request: the API answers 422 to several.
    expect(p.classifier.type).toBe('string');
    expect(p.purchase_type.type).toBe('string');
    expect(p.stage.enum).toEqual([1, 2, 3, 4]);
    expect(p.limit).toMatchObject({ minimum: 1, maximum: 100 });
    expect(new RegExp(p.published_forpast.pattern ?? '').test('6m')).toBe(true);
    expect(tool('gosplan_search_contracts_44').parameters?.properties?.stage.enum).toEqual(['E', 'ET', 'EC', 'IN']);
    expect(tool('gosplan_search_purchases_223').endpointMapping.queryParams).toMatchObject({ submission_close_after: '$submission_close_after', placer: '$placer' });
    expect(a.probe).toEqual({ tool: 'gosplan_search_organizations_44', params: { inn: '7707083893' } });
  });
});

const live = process.env.RUN_GOSPLAN_LIVE === '1' ? describe : describe.skip;
live('gosplan adapter: live against the keyless test server (read-only)', () => {
  const TEST = 'https://v2test.gosplan.info';
  const get = async (path: string) => (await fetch(`${TEST}${path}`, { headers: { Accept: 'application/json' } })).json();
  it('finds an organisation, lists purchases and contracts', async () => {
    const orgs = (await get('/fz44/organizations?inn=7707083893')) as { region: number; source: { INN: string; regNumber: string } }[];
    expect(orgs[0].source.INN).toBe('7707083893');
    const purchases = (await get('/fz44/purchases?limit=1&stage=1')) as { purchase_number: string; stage: number; docs: unknown[] }[];
    expect(purchases).toHaveLength(1);
    expect(purchases[0].stage).toBe(1);
    const contracts = (await get('/fz44/contracts?limit=1&price_ge=1000000')) as { reg_num: string; price: number; suppliers: string[] }[];
    expect(contracts[0].price).toBeGreaterThanOrEqual(1000000);
  }, 60_000);
});
