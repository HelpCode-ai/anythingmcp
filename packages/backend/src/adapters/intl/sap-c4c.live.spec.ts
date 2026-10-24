import * as adapter from './sap-c4c.json';
import { ODataEngine } from '../../connectors/engines/odata.engine';
import { buildODataBuiltinTools, odataToolPrefix } from '../../connectors/odata/odata-builtins';
import { renderStaticResponse } from '../../connectors/static-response.util';
/**
 * SAP Sales Cloud and Service Cloud (Cloud for Customer, C4C) OData API (help.sap.com OData API reference
 * d0f9ba822c08405da7d88174b304df84 and SAP's C4C OData developer guide on GitHub): OData V2 service
 * https://<tenant>.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi with Basic authentication.
 * Live part: SAP_C4C_HOST=... SAP_C4C_USER=... SAP_C4C_PASSWORD=... RUN_SAP_C4C_LIVE=1 npx jest src/adapters/intl/sap-c4c
 * (reads only: one account and the service document).
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
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, any>; headers?: Record<string, string>; config?: Record<string, any> };
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
const PREFIX = 'sap_c4c_';
const WRITES: string[] = [];
const SWITCHED_OFF: string[] = [];

describe('sap-c4c adapter: static spec conformance', () => {

  it('is an OData V2 connector on the c4codataapi service with Basic authentication', () => {
    expect(a.requiredEnvVars).toEqual(['SAP_C4C_HOST', 'SAP_C4C_USER', 'SAP_C4C_PASSWORD']);
    expect(a.connector.type).toBe('ODATA');
    expect(a.connector.baseUrl).toBe('https://{{SAP_C4C_HOST}}/sap/c4c/odata/v1/c4codataapi');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{SAP_C4C_USER}}', password: '{{SAP_C4C_PASSWORD}}' });
    expect(a.connector.config?.odata).toEqual({ version: 'v2', toolPrefix: 'sap_c4c', maxRows: 1000 });
    expect(a.envVarMeta?.SAP_C4C_PASSWORD.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.SAP_C4C_HOST.pattern ?? '');
    expect(host.test('my123456.crm.ondemand.com')).toBe(true);
    expect(host.test('https://my123456.crm.ondemand.com')).toBe(false);
    expect(a.probe).toEqual({ tool: 'sap_c4c_list_accounts', params: { top: 1, select: 'ObjectID' } });
  });

  it('gets the five OData built-ins under its own prefix, without clashing, and names them in the instructions', () => {
    const prefix = odataToolPrefix({ toolPrefix: a.connector.config?.odata.toolPrefix as string, name: a.slug });
    expect(prefix).toBe('sap_c4c');
    const builtins = buildODataBuiltinTools({ prefix, displayName: 'SAP C4C', sap: false }).map((t) => t.name);
    expect(builtins).toEqual(expect.arrayContaining(['sap_c4c_query', 'sap_c4c_describe_entity', 'sap_c4c_get_entity']));
    const own = a.tools.map((t) => t.name);
    expect(builtins.filter((n) => own.includes(n))).toEqual([]);
    for (const n of builtins) expect(`${n}:${a.instructions.includes(n)}`).toBe(`${n}:true`);
  });

  it('maps the ready tools to documented entity sets with the OData query options', () => {
    const sets: Record<string, string> = {
      sap_c4c_list_accounts: '/CorporateAccountCollection', sap_c4c_list_contacts: '/ContactCollection', sap_c4c_list_leads: '/LeadCollection',
      sap_c4c_list_opportunities: '/OpportunityCollection', sap_c4c_list_sales_quotes: '/SalesQuoteCollection', sap_c4c_list_service_requests: '/ServiceRequestCollection',
      sap_c4c_list_products: '/ProductCollection', sap_c4c_list_employees: '/EmployeeCollection',
    };
    for (const [n, path] of Object.entries(sets)) {
      expect(tool(n).endpointMapping).toEqual({
        method: 'GET',
        path,
        queryParams: { $filter: '$filter', $search: '$search', $select: '$select', $orderby: '$orderby', $expand: '$expand', $top: '$top', $skip: '$skip', $inlinecount: 'allpages' },
      });
    }
  });

  it('answers every guide topic', () => {
    const guide = tool('sap_c4c_guide');
    for (const topic of (guide.parameters?.properties?.topic as { enum: string[] }).enum) {
      expect(renderStaticResponse(guide.endpointMapping as never, { topic })).not.toMatch(/^There is no topic/);
    }
  });

  it('sends a list as OData V2 JSON and flattens the rows', async () => {
    const executeWithMeta = jest.fn().mockResolvedValue({ body: { d: { results: [{ ObjectID: '00163E03A0701ED28A8644CF8D83AE76', AccountID: '1001' }], __count: '1' } }, headers: {} });
    const engine = new ODataEngine({ executeWithMeta } as never);
    const out = (await engine.execute(
      { baseUrl: 'https://my123456.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi', authType: 'BASIC_AUTH' },
      tool('sap_c4c_list_accounts').endpointMapping as never,
      { top: 5, filter: "RoleCode eq 'CRM000'", select: 'ObjectID,AccountID' },
      a.connector.config?.odata,
    )) as { rows: unknown[] };
    expect(out.rows).toEqual([{ ObjectID: '00163E03A0701ED28A8644CF8D83AE76', AccountID: '1001' }]);
    const [, mapping, params] = executeWithMeta.mock.calls[0];
    expect(mapping.path).toBe('/CorporateAccountCollection');
    expect(mapping.queryParams).toMatchObject({ $format: 'json', $filter: '$filter', $top: '$top' });
    expect(params).toMatchObject({ top: 5, filter: "RoleCode eq 'CRM000'" });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      if (t.endpointMapping.method === 'static') continue;
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (!['GET', 'static'].includes(t.endpointMapping.method) && !t.endpointMapping.method.startsWith('odata_')) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('documents every tool in the instructions, marks secrets and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    for (const [name, meta] of Object.entries(a.envVarMeta ?? {})) if (/PASSWORD|SECRET|TOKEN|_KEY$/.test(name)) expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
    if (a.probe) {
      const probe = tool(a.probe.tool);
      expect(probe.annotations?.readOnlyHint === false).toBe(false);
      expect(probe.parameters?.required ?? []).toEqual([]);
    }
  });
});

const live = process.env.RUN_SAP_C4C_LIVE === '1' && process.env.SAP_C4C_HOST && process.env.SAP_C4C_USER && process.env.SAP_C4C_PASSWORD ? describe : describe.skip;
live('sap-c4c adapter: live (read-only)', () => {
  const base = `https://${process.env.SAP_C4C_HOST}/sap/c4c/odata/v1/c4codataapi`;
  const headers = { Authorization: `Basic ${Buffer.from(`${process.env.SAP_C4C_USER}:${process.env.SAP_C4C_PASSWORD}`).toString('base64')}`, Accept: 'application/json' };
  it('reads the service document and one account', async () => {
    const doc = (await (await fetch(`${base}/?$format=json`, { headers })).json()) as { d: { EntitySets: string[] } };
    expect(doc.d.EntitySets).toEqual(expect.arrayContaining(['CorporateAccountCollection', 'OpportunityCollection']));
    const acc = (await (await fetch(`${base}/CorporateAccountCollection?$top=1&$select=ObjectID&$format=json`, { headers })).json()) as { d: { results: unknown[] } };
    expect(Array.isArray(acc.d.results)).toBe(true);
  }, 60_000);
});
