import * as adapter from './orderful.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: {
      method: string;
      path: string;
      headers?: Record<string, string>;
      queryParams?: Record<string, string>;
      bodyMapping?: Record<string, string>;
    };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('orderful adapter: static spec conformance', () => {
  it('sends the token in the orderful-api-key header to a regional host', () => {
    expect(a.connector.baseUrl).toBe('{{ORDERFUL_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('orderful-api-key');
    const re = new RegExp(a.envVarMeta.ORDERFUL_API_URL.pattern as string);
    expect(re.test('https://api.orderful.com')).toBe(true);
    expect(re.test('https://api-eu.orderful.com')).toBe(true);
    expect(re.test('https://api.orderful.com/')).toBe(false);
  });

  it('probes with the own organization', () => {
    expect(a.probe.tool).toBe('orderful_get_organization');
    expect(tool('orderful_get_organization').endpointMapping.path).toBe('/v3/organizations/me');
  });

  it('every unversioned path sends orderful-api-version v4, /v3 paths do not', () => {
    for (const t of a.tools) {
      const v = t.endpointMapping.headers?.['orderful-api-version'];
      if (t.endpointMapping.path.startsWith('/v3/')) expect(`${t.name}:${v}`).toBe(`${t.name}:undefined`);
      else expect(`${t.name}:${v}`).toBe(`${t.name}:v4`);
    }
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) })) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('list filters use the documented camelCase query names', () => {
    const q = tool('orderful_list_transactions').endpointMapping.queryParams ?? {};
    expect(q.simplifiedTransactionType).toBe('$simplified_transaction_type');
    expect(q.createdAtStart).toBe('$created_at_start');
    expect(q.nextCursor).toBe('$next_cursor');
  });

  it('delivery accept and fail post a note; sending and acknowledging are destructive', () => {
    expect(tool('orderful_accept_delivery').endpointMapping.bodyMapping).toEqual({ note: '$note' });
    expect(tool('orderful_fail_delivery').endpointMapping.path).toBe('/transactions/{transaction_id}/deliveries/{delivery_id}/fail');
    expect(tool('orderful_create_transaction').annotations?.destructiveHint).toBe(true);
    expect(tool('orderful_acknowledge_transaction').annotations?.destructiveHint).toBe(true);
  });
});
