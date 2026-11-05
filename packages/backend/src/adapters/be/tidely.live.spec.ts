import * as adapter from './tidely.json';

/**
 * Tidely Public API v2 (developers.tidely.com, OpenAPI developers.tidely.com/redocusaurus/public-api.yaml):
 * production https://api.tidely.com/public/v2, API key in the X-Authorization header without prefix.
 * Live part: TIDELY_API_KEY=... RUN_TIDELY_LIVE=1 npx jest src/adapters/be/tidely
 * (reads only: verify-auth, scenarios, categories, bank accounts, monthly cash flow).
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
const PREFIX = 'tidely_';
const WRITES = [
  'tidely_create_invoice',
  'tidely_update_invoice',
  'tidely_delete_invoice',
  'tidely_create_category',
  'tidely_update_category',
  'tidely_delete_category',
  'tidely_create_plan',
  'tidely_delete_plans',
  'tidely_create_bank_account_transaction',
  'tidely_update_bank_account_transaction',
  'tidely_delete_bank_account_transaction',
];
const SWITCHED_OFF = ['tidely_delete_invoice', 'tidely_delete_category', 'tidely_delete_plans', 'tidely_delete_bank_account_transaction'];

describe('tidely adapter: static spec conformance', () => {
  it('calls the v2 public API with the key in X-Authorization', () => {
    expect(a.requiredEnvVars).toEqual(['TIDELY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.tidely.com/public/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Authorization', apiKey: '{{TIDELY_API_KEY}}' });
    expect(a.envVarMeta?.TIDELY_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.TIDELY_API_KEY.pattern ?? '').test('Bearer abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(a.probe?.tool).toBe('tidely_verify_auth');
    expect(tool('tidely_verify_auth').endpointMapping).toEqual({ method: 'GET', path: '/authentication/verify-auth' });
  });

  it('maps cash flow, scenarios, categories, companies and banking routes', () => {
    expect(tool('tidely_get_cashflow').endpointMapping).toEqual({ method: 'GET', path: '/cashflow', queryParams: { scenarioId: '$scenarioId', period: '$period', from: '$from', to: '$to' } });
    expect(tool('tidely_list_scenarios').endpointMapping.path).toBe('/scenarios');
    expect(tool('tidely_get_scenario').endpointMapping.path).toBe('/scenarios/{scenarioId}');
    expect(tool('tidely_list_categories').endpointMapping).toMatchObject({ path: '/categories', queryParams: { name: '$name' } });
    expect(tool('tidely_get_category').endpointMapping.path).toBe('/categories/{id}');
    expect(tool('tidely_list_companies').endpointMapping).toMatchObject({ path: '/companies', queryParams: { page: '$page', pageSize: '$pageSize' } });
    expect(tool('tidely_get_company').endpointMapping.path).toBe('/companies/{id}');
    expect(tool('tidely_list_bank_accounts').endpointMapping.path).toBe('/bank-accounts');
    expect(tool('tidely_get_bank_account').endpointMapping.path).toBe('/bank-accounts/{id}');
    expect(tool('tidely_list_bank_account_balances').endpointMapping.path).toBe('/bank-accounts/{id}/balances');
    expect(tool('tidely_list_bank_account_transactions').endpointMapping).toMatchObject({ path: '/bank-account-transactions', queryParams: { bankAccountId: '$bankAccountId' } });
    expect(tool('tidely_get_bank_account_transaction').endpointMapping.path).toBe('/bank-account-transactions/{id}');
    expect(tool('tidely_check_transactions_exist').endpointMapping).toEqual({ method: 'POST', path: '/bank-account-transactions/exists', bodyMapping: { bankAccountId: '$bankAccountId', externalIds: '$externalIds' } });
    expect(tool('tidely_check_transactions_exist').annotations?.readOnlyHint).toBe(true);
  });

  it('maps invoices with the required invoiceTypeFilter and the write bodies', () => {
    for (const n of ['tidely_list_invoices', 'tidely_get_invoice', 'tidely_update_invoice', 'tidely_delete_invoice']) {
      expect(tool(n).endpointMapping.queryParams?.invoiceTypeFilter).toBe('$invoiceTypeFilter');
      expect(tool(n).parameters?.required).toContain('invoiceTypeFilter');
    }
    expect(tool('tidely_create_invoice').endpointMapping).toMatchObject({ method: 'POST', path: '/invoices', bodyMapping: { invoiceType: '$invoiceType', invoiceNumber: '$invoiceNumber', contactName: '$contactName', totalGrossAmount: '$totalGrossAmount' } });
    expect(tool('tidely_update_invoice').endpointMapping).toMatchObject({ method: 'PATCH', path: '/invoices/{id}' });
    expect((tool('tidely_update_invoice').endpointMapping.bodyMapping as Record<string, unknown>).invoiceType).toBeUndefined();
    expect(tool('tidely_create_plan').endpointMapping).toMatchObject({ method: 'POST', path: '/plans', bodyMapping: { type: '$type', period: '$period', date: '$date' } });
    expect(tool('tidely_delete_plans').endpointMapping).toEqual({ method: 'DELETE', path: '/plans', queryParams: { categoryId: '$categoryId', scenarioId: '$scenarioId' } });
    expect(tool('tidely_create_bank_account_transaction').endpointMapping).toMatchObject({ method: 'POST', path: '/bank-account-transactions', bodyMapping: { bankAccountId: '$bankAccountId', transaction: { bookingDate: '$bookingDate', amount: '$amount', counterpartName: '$counterpartName' } } });
    expect(tool('tidely_update_bank_account_transaction').endpointMapping).toMatchObject({ method: 'PATCH', path: '/bank-account-transactions/{id}' });
    expect(tool('tidely_create_category').endpointMapping).toMatchObject({ method: 'POST', path: '/categories' });
    expect(tool('tidely_update_category').endpointMapping).toMatchObject({ method: 'PATCH', path: '/categories/{id}' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, deletes installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const n of SWITCHED_OFF) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'DELETE') expect(SWITCHED_OFF).toContain(t.name);
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const env = process.env;
const live = env.RUN_TIDELY_LIVE === '1' && env.TIDELY_API_KEY ? describe : describe.skip;
live('tidely adapter: live (read-only)', () => {
  const headers = { Accept: 'application/json', 'X-Authorization': env.TIDELY_API_KEY as string };
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.json() as Promise<unknown>;
  };
  it('verifies the key and reads scenarios, categories, bank accounts and the cash flow', async () => {
    expect(((await get('/authentication/verify-auth')) as { success: boolean }).success).toBe(true);
    expect(Array.isArray(await get('/scenarios'))).toBe(true);
    expect(Array.isArray(await get('/categories'))).toBe(true);
    await get('/bank-accounts');
    const cf = (await get('/cashflow?period=MONTH')) as { cashflow: unknown };
    expect(cf.cashflow).toBeDefined();
  }, 60_000);
});
