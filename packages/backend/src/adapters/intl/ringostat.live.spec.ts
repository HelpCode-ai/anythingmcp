import * as adapter from './ringostat.json';

/**
 * Ringostat API (help.ringostat.com API articles, reference at ringostat.readme.io):
 * Auth-key header on https://api.ringostat.net; GET /calls/list (export_type, from, to, fields,
 * filters, order, merge), GET /sipstatus/online and /sipstatus/speaking, JSON-RPC on /api/json-rpc
 * and /rsp-api-v3 with the project id in params, POST /callback/outward_call.
 * Live part: RINGOSTAT_AUTH_KEY=... RINGOSTAT_PROJECT_ID=... RUN_RINGOSTAT_LIVE=1 npx jest src/adapters/intl/ringostat
 * (reads only: online SIP accounts, yesterday's call log, employees).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; bodyEncoding?: string; querySpaces?: string; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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

describe('ringostat adapter: static spec conformance', () => {
  it('sends the Auth-key header to api.ringostat.net', () => {
    expect(a.requiredEnvVars).toEqual(['RINGOSTAT_AUTH_KEY', 'RINGOSTAT_PROJECT_ID']);
    expect(a.connector.baseUrl).toBe('https://api.ringostat.net');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Auth-key', apiKey: '{{RINGOSTAT_AUTH_KEY}}' });
    expect(a.envVarMeta?.RINGOSTAT_AUTH_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.RINGOSTAT_PROJECT_ID.pattern as string).test('39071')).toBe(true);
  });

  it('exports the call log as JSON with the documented query names', () => {
    const t = tool('ringostat_list_calls');
    expect(t.endpointMapping).toEqual({
      method: 'GET',
      path: '/calls/list',
      querySpaces: '%20',
      queryParams: { export_type: 'json', from: '$from', to: '$to', fields: '$fields', filters: '$filters', order: '$order', merge: '$merge' },
    });
    const fields = String(t.parameters?.properties?.fields.default).split(',');
    for (const f of ['calldate', 'caller', 'dst', 'disposition', 'billsec', 'employee_fio', 'utm_source']) expect(fields).toContain(f);
  });

  it('maps the SIP status reads and the JSON-RPC reads with the project id', () => {
    expect(tool('ringostat_list_online_sip').endpointMapping).toEqual({ method: 'GET', path: '/sipstatus/online' });
    expect(tool('ringostat_list_speaking_sip').endpointMapping).toEqual({ method: 'GET', path: '/sipstatus/speaking' });
    expect(tool('ringostat_list_employees').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/json-rpc',
      bodyMapping: { jsonrpc: '2.0', id: 1, method: 'getProjectStaffListAndDirections', params: { projectId: '{{RINGOSTAT_PROJECT_ID}}', departmentsFullFormat: true, filter: '$filter' } },
    });
    expect(tool('ringostat_list_employees').parameters?.properties?.filter.default).toEqual([{}]);
    expect(tool('ringostat_get_sip_status_report').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/json-rpc',
      bodyMapping: { jsonrpc: '2.0', id: 1, method: 'getSipStatusDailyReport', params: { projectId: '{{RINGOSTAT_PROJECT_ID}}', filter: { from: '$from', to: '$to' } } },
    });
    expect(tool('ringostat_list_custom_statuses').endpointMapping).toEqual({
      method: 'POST',
      path: '/rsp-api-v3',
      bodyMapping: { id: 1, method: 'getCustomStatuses', params: { projectId: '{{RINGOSTAT_PROJECT_ID}}' } },
    });
  });

  it('installs the callback, which dials and bills at once, switched off', () => {
    const t = tool('ringostat_start_callback');
    expect(t.endpointMapping).toEqual({ method: 'POST', path: '/callback/outward_call', bodyEncoding: 'form-urlencoded', bodyMapping: { extension: '$extension', destination: '$destination' } });
    expect(t.enabled).toBe(false);
    expect(t.annotations?.readOnlyHint).toBe(false);
    expect(a.tools.filter((x) => x.enabled === false).map((x) => x.name)).toEqual(['ringostat_start_callback']);
    for (const x of a.tools) {
      if (x.name === 'ringostat_start_callback') continue;
      if (x.endpointMapping.method !== 'GET') expect(`${x.name}:${x.annotations?.readOnlyHint}`).toBe(`${x.name}:true`);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('ringostat_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_RINGOSTAT_LIVE === '1' && process.env.RINGOSTAT_AUTH_KEY && process.env.RINGOSTAT_PROJECT_ID ? describe : describe.skip;
live('ringostat adapter: live (read-only)', () => {
  const base = 'https://api.ringostat.net';
  const headers = { 'Auth-key': process.env.RINGOSTAT_AUTH_KEY as string, Accept: 'application/json' };
  it('reads online SIP accounts, yesterday\'s call log and the employees', async () => {
    const online = await (await fetch(`${base}/sipstatus/online`, { headers })).json();
    expect(Array.isArray(online)).toBe(true);
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const q = `export_type=json&from=${day}%2000:00:00&to=${day}%2023:59:59&fields=calldate,caller,dst,disposition,billsec`;
    const calls = await (await fetch(`${base}/calls/list?${q}`, { headers })).json();
    expect(Array.isArray(calls)).toBe(true);
    const staff = (await (
      await fetch(`${base}/api/json-rpc`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProjectStaffListAndDirections', params: { projectId: process.env.RINGOSTAT_PROJECT_ID, departmentsFullFormat: true, filter: [{}] } }),
      })
    ).json()) as { result?: unknown; error?: unknown };
    expect(staff.error).toBeUndefined();
  }, 60_000);
});
