import * as adapter from './smarthr.json';

/**
 * SmartHR API v1 (developer.smarthr.jp/api; Swagger 2.0 at app.smarthr.jp/api/v1/swagger_doc):
 * base https://<tenant>.smarthr.jp/api (sandbox <tenant>.daruma.space), Bearer access token
 * issued by an administrator, page/per_page paging (max 100) with Link and x-total-count
 * headers. Employees are "crews" in the API.
 * Live part (reads only: companies, departments, job titles, employment types, custom fields, one page of crews):
 *   SMARTHR_HOST=example.daruma.space SMARTHR_ACCESS_TOKEN=... RUN_SMARTHR_LIVE=1 npx jest src/adapters/jp/smarthr
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const PREFIX = 'smarthr_';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === PREFIX + name);
  if (!t) throw new Error(`missing tool ${PREFIX}${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
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
  for (const e of ENV) out.delete(e);
  return out;
};

describe('smarthr adapter: static spec conformance', () => {
  it('sends the access token as Bearer to the tenant host, production or sandbox', () => {
    expect(a.slug).toBe('smarthr');
    expect(a.region).toBe('jp');
    expect(a.requiredEnvVars).toEqual(['SMARTHR_HOST', 'SMARTHR_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{SMARTHR_HOST}}/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SMARTHR_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.SMARTHR_ACCESS_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta!.SMARTHR_HOST.pattern!);
    expect(host.test('example.smarthr.jp')).toBe(true);
    expect(host.test('example.daruma.space')).toBe(true);
    expect(host.test('https://example.smarthr.jp')).toBe(false);
    expect(host.test('example.smarthr.jp/api')).toBe(false);
    expect(host.test('example.example.com')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v1/')).toBe(true);
  });

  it('maps crews, dependents and leaves to the documented paths and filters', () => {
    const lc = tool('list_crews');
    expect(lc.endpointMapping).toMatchObject({ method: 'GET', path: '/v1/crews' });
    expect(lc.endpointMapping.queryParams).toEqual({
      q: '$q', emp_code: '$emp_code', emp_status: '$emp_status', employment_type_id: '$employment_type_id', department_id: '$department_id', position_id: '$position_id', id: '$id', user_id: '$user_id', gender: '$gender',
      entered_at_from: '$entered_at_from', entered_at_to: '$entered_at_to', resigned_at_from: '$resigned_at_from', resigned_at_to: '$resigned_at_to', sort: '$sort', fields: '$fields', page: '$page', per_page: '$per_page',
    });
    expect(String(lc.parameters?.properties?.fields.default)).toContain('emp_code');
    expect(String(lc.parameters?.properties?.fields.default)).not.toContain('bank_accounts');
    expect(tool('get_crew').endpointMapping).toEqual({ method: 'GET', path: '/v1/crews/{id}', queryParams: { fields: '$fields' } });
    expect(tool('create_crew').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/crews', bodyMapping: { last_name: '$last_name', last_name_yomi: '$last_name_yomi', department_ids: '$department_ids', custom_fields: '$custom_fields' } });
    expect(tool('create_crew').parameters?.required).toEqual(['emp_status', 'last_name', 'first_name', 'last_name_yomi', 'first_name_yomi', 'gender']);
    expect(tool('update_crew').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/crews/{id}' });
    expect(tool('update_crew').parameters?.required).toEqual(['id']);
    expect(tool('invite_crew').endpointMapping).toEqual({ method: 'PUT', path: '/v1/crews/{id}/invite', bodyMapping: { inviter_user_id: '$inviter_user_id', crew_input_form_id: '$crew_input_form_id' } });
    expect(tool('list_crew_dependents').endpointMapping.path).toBe('/v1/crews/{crew_id}/dependents');
    expect(tool('get_crew_dependent').endpointMapping.path).toBe('/v1/crews/{crew_id}/dependents/{id}');
    expect(tool('list_crew_childcare_leaves').endpointMapping.path).toBe('/v1/crews/{crew_id}/maternity_childcare_leaves');
  });

  it('maps the company structure, custom fields, users and payroll', () => {
    expect(tool('list_companies').endpointMapping.path).toBe('/v1/companies');
    expect(tool('list_biz_establishments').endpointMapping.path).toBe('/v1/biz_establishments');
    expect(tool('list_departments').endpointMapping.queryParams).toEqual({ code: '$code', sort: '$sort', page: '$page', per_page: '$per_page' });
    expect(tool('create_department').endpointMapping).toEqual({ method: 'POST', path: '/v1/departments', bodyMapping: { name: '$name', code: '$code', parent_id: '$parent_id', position: '$position', company_id: '$company_id' } });
    expect(tool('update_department').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/departments/{id}' });
    expect(tool('list_job_titles').endpointMapping.path).toBe('/v1/job_titles');
    expect(tool('list_employment_types').endpointMapping.path).toBe('/v1/employment_types');
    expect(tool('list_grades').endpointMapping.path).toBe('/v1/grades');
    expect(tool('list_work_locations').endpointMapping.path).toBe('/v1/work_locations');
    expect(tool('list_payment_periods').endpointMapping.path).toBe('/v1/payment_periods');
    expect(tool('list_crew_custom_field_templates').endpointMapping.queryParams).toMatchObject({ embed: '$embed' });
    expect(tool('list_crew_custom_field_template_groups').endpointMapping.path).toBe('/v1/crew_custom_field_template_groups');
    expect(tool('list_crew_input_forms').endpointMapping.path).toBe('/v1/crew_input_forms');
    expect(tool('list_dependent_relations').endpointMapping.queryParams).toMatchObject({ filter: '$filter' });
    expect(tool('list_users').endpointMapping.path).toBe('/v1/users');
    expect(tool('get_user').endpointMapping).toEqual({ method: 'GET', path: '/v1/users/{id}', queryParams: { embed: '$embed' } });
    expect(tool('list_payrolls').endpointMapping.queryParams).toMatchObject({ payment_type: '$payment_type', paid_at_from: '$paid_at_from', paid_at_to: '$paid_at_to' });
    expect(tool('get_payroll').endpointMapping.path).toBe('/v1/payrolls/{id}');
    expect(tool('list_payslips').endpointMapping).toMatchObject({ path: '/v1/payrolls/{payroll_id}/payslips', queryParams: { crew_id: '$crew_id' } });
    expect(tool('get_payslip').endpointMapping.path).toBe('/v1/payrolls/{payroll_id}/payslips/{id}');
  });

  it('pages every list with page and per_page (max 100) and exposes Link and x-total-count', () => {
    const lists = a.tools.filter((t) => t.name.startsWith(`${PREFIX}list_`));
    expect(lists.length).toBeGreaterThan(15);
    for (const t of lists) {
      expect(`${t.name}:${t.endpointMapping.exposeHeaders?.join(',')}`).toBe(`${t.name}:link,x-total-count`);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', per_page: '$per_page' });
      expect(t.parameters?.properties?.per_page.maximum).toBe(100);
    }
  });

  it('installs only the employee delete switched off, and warns about personal data', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([`${PREFIX}delete_crew`]);
    expect(tool('delete_crew').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.instructions).toContain(`**Switched off at install**: \`${PREFIX}delete_crew\`; it cannot be undone`);
    expect(a.instructions).toContain('**Personal data**');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
      if (t.endpointMapping.method === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = a.tools.find((t) => t.name === a.probe.tool)!;
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SMARTHR_LIVE === '1' && process.env.SMARTHR_HOST && process.env.SMARTHR_ACCESS_TOKEN ? describe : describe.skip;
live('smarthr adapter: live (read-only)', () => {
  const base = `https://${process.env.SMARTHR_HOST}/api`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.SMARTHR_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-total-count')).not.toBeNull();
    return (await res.json()) as unknown[];
  };
  it('reads companies, departments, job titles, employment types, custom fields and one page of crews', async () => {
    for (const p of ['/v1/companies', '/v1/departments?per_page=1', '/v1/job_titles?per_page=1', '/v1/employment_types?per_page=1', '/v1/crew_custom_field_templates?per_page=1']) {
      expect(Array.isArray(await get(p))).toBe(true);
    }
    const crews = (await get('/v1/crews?per_page=2&fields=id,emp_code,emp_status')) as Array<Record<string, unknown>>;
    for (const c of crews) expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(['emp_code', 'id']));
  }, 60_000);
});
