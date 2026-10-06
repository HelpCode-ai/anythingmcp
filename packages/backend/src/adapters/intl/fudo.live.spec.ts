import * as adapter from './fudo.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
    for (const [, n] of v.matchAll(/\$\{(\w+)\}/g)) out.add(n);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('fudo adapter: static spec conformance', () => {
  it('exchanges apiKey and apiSecret at auth.fu.do for a bearer token', () => {
    expect(a.connector.baseUrl).toBe('https://api.fu.do/v1alpha1');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const ac = a.connector.authConfig as Record<string, unknown>;
    expect(ac.loginUrl).toBe('https://auth.fu.do/api');
    expect(ac.loginBody).toEqual({ apiKey: '${username}', apiSecret: '${password}' });
    expect(ac.tokenJsonPath).toBe('token');
    expect(ac.expiryJsonPath).toBe('exp');
    expect(ac.expiryFormat).toBe('unix');
    expect(ac.headerTemplate).toBe('Bearer ${token}');
  });

  it('probes with the payment methods list', () => {
    expect(a.probe.tool).toBe('fudo_list_payment_methods');
  });

  it('lists page with page[size] and page[number]', () => {
    for (const t of a.tools.filter((x) => x.name.startsWith('fudo_list_'))) {
      expect(t.endpointMapping.queryParams?.['page[size]']).toBe('$page_size');
      expect(t.endpointMapping.queryParams?.['page[number]']).toBe('$page_number');
    }
  });

  it('filters use the documented filter[column] names and operators', () => {
    const q = tool('fudo_list_sales').endpointMapping.queryParams ?? {};
    expect(q['filter[createdAt]']).toBe('$created_at');
    expect(q['filter[tableId]']).toBe('eq.${table_id}');
    expect(tool('fudo_list_customers').endpointMapping.queryParams?.['filter[@all]']).toBe('fts.${search}');
    expect(tool('fudo_list_products').endpointMapping.queryParams?.['filter[name]']).toBe('ilike.${name}');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('every write is installed off and uses a JSON:API body', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      expect((t.endpointMapping.bodyMapping as { data?: { type?: string } }).data?.type).toBeTruthy();
    }
  });
});
