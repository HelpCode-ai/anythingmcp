import * as adapter from './phorest.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('phorest adapter: static spec conformance', () => {
  it('uses Basic auth on the third-party API server, scoped to the business', () => {
    expect(a.connector.baseUrl).toBe('{{PHOREST_API_URL}}/third-party-api-server/api/business/{{PHOREST_BUSINESS_ID}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{PHOREST_USERNAME}}', password: '{{PHOREST_PASSWORD}}' });
  });

  it('accepts the documented regional hosts and the global/ username form', () => {
    const host = new RegExp(a.envVarMeta.PHOREST_API_URL.pattern as string);
    expect(host.test('https://api-gateway-eu.phorest.com')).toBe(true);
    expect(host.test('https://api-gateway-us.phorest.com')).toBe(true);
    expect(host.test('https://api-gateway-eu.phorest.com/third-party-api-server')).toBe(false);
    expect(new RegExp(a.envVarMeta.PHOREST_USERNAME.pattern as string).test('global/name@example.com')).toBe(true);
  });

  it('probes with the branch list', () => {
    expect(a.probe.tool).toBe('phorest_list_branches');
    expect(tool('phorest_list_branches').endpointMapping.path).toBe('/branch');
  });

  it('branch-scoped tools put branch_id in the path', () => {
    for (const n of ['phorest_list_staff', 'phorest_list_appointments', 'phorest_list_services', 'phorest_list_products', 'phorest_check_availability']) {
      expect(tool(n).endpointMapping.path.startsWith('/branch/{branch_id}/')).toBe(true);
      expect(tool(n).parameters?.required).toContain('branch_id');
    }
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

  it('availability is a POST read; writes are installed off', () => {
    expect(tool('phorest_check_availability').annotations).toEqual({ readOnlyHint: true });
    for (const n of ['phorest_create_client', 'phorest_create_booking', 'phorest_cancel_appointments']) expect(tool(n).enabled).toBe(false);
    expect(tool('phorest_cancel_appointments').annotations?.destructiveHint).toBe(true);
  });
});
