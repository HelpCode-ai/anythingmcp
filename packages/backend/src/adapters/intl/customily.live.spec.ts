import * as adapter from './customily.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('customily adapter: static spec conformance', () => {
  it('logs in with the documented password grant, form-encoded', () => {
    expect(a.connector.baseUrl).toBe('https://app.customily.com/api');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const ac = a.connector.authConfig as {
      loginUrl: string;
      loginHeaders: Record<string, string>;
      loginBody: Record<string, string>;
      tokenJsonPath: string;
      headerTemplate: string;
    };
    expect(ac.loginUrl).toBe('https://app.customily.com/api/token');
    expect(ac.loginHeaders['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(ac.loginBody).toEqual({ grant_type: 'password', username: '${username}', password: '${password}' });
    expect(ac.tokenJsonPath).toBe('access_token');
    expect(ac.headerTemplate).toBe('Bearer ${token}');
  });

  it('probes with the template count, which needs no parameters', () => {
    expect(a.probe.tool).toBe('customily_count_products');
    expect(tool('customily_count_products').parameters?.required).toBeUndefined();
  });

  it('personalization tools call the standalone host', () => {
    expect(tool('customily_get_personalization').endpointMapping.path).toBe('https://sh.customily.com/api/standalone/item/{personalization_id}');
    expect(tool('customily_list_order_personalizations').endpointMapping.queryParams).toEqual({ orderId: '$order_id' });
  });

  it('the template list always sends searchString, which the API requires', () => {
    expect(tool('customily_list_products').parameters?.properties?.search?.default).toBe(' ');
    expect(tool('customily_list_products').endpointMapping.queryParams?.searchString).toBe('$search');
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

  it('paid production-file generation and rename are installed off', () => {
    expect(tool('customily_generate_production_file').enabled).toBe(false);
    expect(tool('customily_generate_production_file').annotations?.destructiveHint).toBe(true);
    expect(tool('customily_rename_product').enabled).toBe(false);
  });
});
