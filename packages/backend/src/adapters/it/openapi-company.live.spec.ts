import * as adapter from './openapi-company.json';

/**
 * Openapi.com Company API (console.openapi.com/apis/company/documentation, OAS
 * console.openapi.com/oas/en/company.openapi.json): production https://company.openapi.com,
 * sandbox https://test.company.openapi.com, Bearer token with Company scopes. Every call is billed.
 * Live part (sandbox only, so nothing is billed): OPENAPI_COMPANY_SANDBOX_TOKEN=... RUN_OPENAPI_COMPANY_LIVE=1
 * npx jest src/adapters/it/openapi-company (reads the legal forms and one sandbox company).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  description: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'openapi_company_';

describe('openapi-company adapter: static spec conformance', () => {
  it('calls the production host with a Bearer token and says every call is paid', () => {
    expect(a.requiredEnvVars).toEqual(['OPENAPI_COMPANY_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://company.openapi.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{OPENAPI_COMPANY_TOKEN}}' });
    expect(a.envVarMeta?.OPENAPI_COMPANY_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.OPENAPI_COMPANY_TOKEN.pattern ?? '');
    expect(re.test('a1b2c3d4e5f6a7b8c9d0e1f2')).toBe(true);
    expect(re.test('Bearer a1b2c3d4e5f6a7b8c9d0e1f2')).toBe(false);
    expect(a.instructions).toContain('test.company.openapi.com');
    expect(a.instructions).toContain('Every call is paid');
    expect(a.description).toMatch(/billed per request/);
    for (const t of a.tools) expect(`${t.name}:${/\bfree\b/i.test(t.description)}`).toBe(`${t.name}:false`);
    // No probe: a setup check would be a billed call.
    expect(a.probe).toBeUndefined();
  });

  it('maps the Italian lookups to the documented routes', () => {
    const paths: Record<string, string> = {
      it_start: '/IT-start/{id}',
      it_advanced: '/IT-advanced/{id}',
      it_full: '/IT-full/{vat_or_tax_code}',
      it_name: '/IT-name/{id}',
      it_address: '/IT-address/{id}',
      it_pec: '/IT-pec/{id}',
      it_sdi_code: '/IT-sdicode/{id}',
      it_shareholders: '/IT-shareholders/{id}',
      it_stakeholders: '/IT-stakeholders/{vat_or_tax_code}',
      it_ubo: '/IT-ubo/{id}',
      it_closed: '/IT-closed/{id}',
      it_vat_group: '/IT-vatgroup/{vat_code}',
      it_public_administration: '/IT-pa/{tax_or_vat_code}',
      it_split_payment: '/IT-splitpayment/{tax_or_vat_code}',
      it_search: '/IT-search',
      it_legal_forms: '/IT-legalforms',
      check_request: '/IT-check_id/{request_id}',
      eu_vies_check: '/EU-vies/{country}/{vat_code}',
      eu_start: '/EU-start/{vat_code}',
      ww_start: '/WW-start/{country}/{company_id}',
      ww_advanced: '/WW-advanced/{country}/{company_id}',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(paths).map((k) => PREFIX + k).sort());
    for (const [k, p] of Object.entries(paths)) expect(`${k}:${tool(PREFIX + k).endpointMapping.path}`).toBe(`${k}:${p}`);
    expect(tool('openapi_company_it_closed').endpointMapping.queryParams).toEqual({ date: '$date' });
    expect(tool('openapi_company_it_vat_group').endpointMapping.queryParams).toEqual({ taxCode: '$tax_code' });
    expect(tool('openapi_company_it_search').endpointMapping.queryParams).toMatchObject({ dryRun: '$dryRun', companyName: '$companyName', dataEnrichment: '$dataEnrichment', skip: '$skip', limit: '$limit' });
    expect((tool('openapi_company_it_search').parameters?.properties?.limit as { maximum: number }).maximum).toBe(1000);
  });

  it('every tool is prefixed, read-only GET, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.enabled).toBeUndefined();
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const env = process.env;
const live = env.RUN_OPENAPI_COMPANY_LIVE === '1' && env.OPENAPI_COMPANY_SANDBOX_TOKEN ? describe : describe.skip;
live('openapi-company adapter: live against the sandbox (not billed)', () => {
  const base = 'https://test.company.openapi.com';
  const headers = { Accept: 'application/json', Authorization: `Bearer ${env.OPENAPI_COMPANY_SANDBOX_TOKEN}` };
  it('reads the legal forms and the basic data of a sandbox company', async () => {
    const forms = (await (await fetch(`${base}/IT-legalforms`, { headers })).json()) as { success: boolean; data: unknown[] };
    expect(forms.success).toBe(true);
    expect(Array.isArray(forms.data)).toBe(true);
    const company = (await (await fetch(`${base}/IT-start/${env.OPENAPI_COMPANY_SANDBOX_VAT ?? '12485671007'}`, { headers })).json()) as { success: boolean; data: unknown[] };
    expect(company.success).toBe(true);
  }, 60_000);
});
