import * as adapter from './bill-com.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; healthcheckPath: string };
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyTemplate?: string };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('bill-com adapter: static spec conformance', () => {
  it('signs in with POST /v3/login and sends sessionId plus devKey', () => {
    expect(a.connector.baseUrl).toBe('{{BILL_API_URL}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const ac = a.connector.authConfig as Record<string, unknown>;
    expect(ac.loginUrl).toBe('{{BILL_API_URL}}/v3/login');
    expect(ac.loginBody).toEqual({
      username: '${username}',
      password: '${password}',
      organizationId: '{{BILL_ORGANIZATION_ID}}',
      devKey: '{{BILL_DEV_KEY}}',
    });
    expect(ac.tokenJsonPath).toBe('sessionId');
    expect(ac.headerName).toBe('sessionId');
    expect(ac.headerTemplate).toBe('${token}');
    expect(ac.extraHeaders).toEqual({ devKey: '{{BILL_DEV_KEY}}' });
  });

  it('accepts only the documented production and sandbox gateways', () => {
    const re = new RegExp(a.envVarMeta.BILL_API_URL.pattern as string);
    expect(re.test('https://gateway.prod.bill.com/connect')).toBe(true);
    expect(re.test('https://gateway.stage.bill.com/connect')).toBe(true);
    expect(re.test('https://gateway.prod.bill.com/connect/')).toBe(false);
  });

  it('probes with the session details', () => {
    expect(a.probe.tool).toBe('bill_com_get_session');
    expect(tool('bill_com_get_session').endpointMapping.path).toBe('/v3/login/session');
  });

  it('every list passes filters, sort, max and page through', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.queryParams?.filters)) {
      expect(t.endpointMapping.queryParams).toEqual({ filters: '$filters', sort: '$sort', max: '$max', page: '$page' });
    }
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(m.queryParams ?? {})) used.add(String(v).replace(/^\$/, ''));
      for (const [, p] of (m.bodyTemplate ?? '').matchAll(/\$\{(\w+)\}/g)) used.add(p);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('the only write, bill approval, is installed off and sends the array as the body', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => t.name)).toEqual(['bill_com_approve_or_deny_bills']);
    expect(writes[0].enabled).toBe(false);
    expect(writes[0].endpointMapping.bodyTemplate).toBe('${actions}');
  });
});

const live = process.env.RUN_BILL_COM_LIVE === '1' ? describe : describe.skip;
live('bill-com adapter: live (keyless health endpoint, sandbox)', () => {
  it('GET /v3/health answers ok without credentials', async () => {
    const res = await fetch(`https://gateway.stage.bill.com/connect${a.connector.healthcheckPath}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
