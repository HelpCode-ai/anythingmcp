import * as adapter from './nbb-cbso.json';

/**
 * NBB CBSO "authentic data" web service (developer.cbso.nbb.be, API "NBB CBSO Consultation service
 * for authentic data (prod)"): gateway https://ws.cbso.nbb.be, API path /authentic, subscription key
 * in the NBB-CBSO-Subscription-Key header, X-Request-Id (UUID v4) required on every operation,
 * format of accountingData chosen by Accept (application/x.jsonxbrl, application/x.xbrl, application/pdf).
 * Live part: NBB_CBSO_SUBSCRIPTION_KEY=... RUN_NBB_CBSO_LIVE=1 npx jest src/adapters/be/nbb-cbso
 * (lists the NBB's own filings, 0203201340, and reads the reference of the latest one).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; pattern?: string; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { binary?: { maxBytes?: number } };
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
const PREFIX = 'nbb_cbso_';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('nbb-cbso adapter: static spec conformance', () => {
  it('calls ws.cbso.nbb.be/authentic with the subscription key header', () => {
    expect(a.requiredEnvVars).toEqual(['NBB_CBSO_SUBSCRIPTION_KEY']);
    expect(a.connector.baseUrl).toBe('https://ws.cbso.nbb.be/authentic');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'NBB-CBSO-Subscription-Key', apiKey: '{{NBB_CBSO_SUBSCRIPTION_KEY}}' });
    expect(a.envVarMeta?.NBB_CBSO_SUBSCRIPTION_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.NBB_CBSO_SUBSCRIPTION_KEY.pattern ?? '').test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(a.probe).toEqual({ tool: 'nbb_cbso_list_annual_accounts', params: { enterprise_number: '0203201340' } });
  });

  it('maps the three documented operations, choosing the format through Accept', () => {
    expect(tool('nbb_cbso_list_annual_accounts').endpointMapping).toMatchObject({ method: 'GET', path: '/legalEntity/{enterprise_number}/references', queryParams: { year: '$year' } });
    expect(tool('nbb_cbso_get_annual_account_reference').endpointMapping).toMatchObject({ method: 'GET', path: '/deposit/{reference_number}/reference', headers: { Accept: 'application/json' } });
    const data = tool('nbb_cbso_get_annual_account_data');
    expect(data.endpointMapping).toMatchObject({ method: 'GET', path: '/deposit/{reference_number}/accountingData', headers: { Accept: '$format' } });
    expect(data.parameters?.properties?.format.enum).toEqual(['application/x.jsonxbrl', 'application/x.xbrl']);
    expect(data.parameters?.properties?.format.default).toBe('application/x.jsonxbrl');
    expect(tool('nbb_cbso_get_annual_account_pdf').endpointMapping).toMatchObject({ path: '/deposit/{reference_number}/accountingData', headers: { Accept: 'application/pdf' } });
    for (const n of ['nbb_cbso_get_annual_account_data', 'nbb_cbso_get_annual_account_pdf']) expect(tool(n).responseMapping?.binary?.maxBytes).toBe(10 * 1024 * 1024);
    const en = new RegExp(tool('nbb_cbso_list_annual_accounts').parameters?.properties?.enterprise_number.pattern ?? '');
    expect(en.test('0203201340')).toBe(true);
    expect(en.test('BE0203.201.340')).toBe(false);
  });

  it('sends a UUID v4 X-Request-Id on every call', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.['X-Request-Id']).toBe('$request_id');
      expect(String(t.parameters?.properties?.request_id.default)).toMatch(UUID_V4);
    }
  });

  it('every tool is prefixed, read-only GET, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
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
const live = env.RUN_NBB_CBSO_LIVE === '1' && env.NBB_CBSO_SUBSCRIPTION_KEY ? describe : describe.skip;
live('nbb-cbso adapter: live (read-only)', () => {
  const headers = () => ({ 'NBB-CBSO-Subscription-Key': env.NBB_CBSO_SUBSCRIPTION_KEY as string, 'X-Request-Id': crypto.randomUUID(), Accept: 'application/json' });
  it('lists the NBB filings and reads the reference of one', async () => {
    const res = await fetch(`${a.connector.baseUrl}/legalEntity/0203201340/references`, { headers: headers() });
    expect(res.status).toBe(200);
    const refs = (await res.json()) as { ReferenceNumber: string }[];
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBeGreaterThan(0);
    const ref = (await (await fetch(`${a.connector.baseUrl}/deposit/${refs[0].ReferenceNumber}/reference`, { headers: headers() })).json()) as { ReferenceNumber: string };
    expect(ref.ReferenceNumber).toBe(refs[0].ReferenceNumber);
  }, 60_000);
});
