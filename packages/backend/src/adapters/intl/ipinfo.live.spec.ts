import * as adapter from './ipinfo.json';

/**
 * IPinfo (ipinfo.io/developers, OpenAPI at ipinfo.io/developers/openapi.yaml): the current
 * API on https://api.ipinfo.io (lite, lookup, places, batch) and the classic API on
 * https://ipinfo.io (everything else). The token is optional and sent as a Bearer header
 * only when IPINFO_TOKEN is set; the classic IP lookups also answer without one.
 * Live part (reads only; keyless calls always, Lite and /me when a token is set):
 *   RUN_IPINFO_LIVE=1 [IPINFO_TOKEN=...] npx jest src/adapters/intl/ipinfo
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
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
  out.delete('IPINFO_TOKEN');
  return out;
};
const PREFIX = 'ipinfo_';
const API = 'https://api.ipinfo.io';

describe('ipinfo adapter: static spec conformance', () => {
  it('sends the optional token as a Bearer header on every tool, never in the URL', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['IPINFO_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://ipinfo.io');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.envVarMeta?.IPINFO_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.IPINFO_TOKEN.pattern ?? '');
    expect(pattern.test(['0123456', '789abcd'].join(''))).toBe(true);
    expect(pattern.test('Bearer x')).toBe(false);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.headers?.Authorization}`).toBe(`${t.name}:Bearer \${IPINFO_TOKEN}`);
      expect(JSON.stringify(t.endpointMapping.queryParams ?? {})).not.toContain('token');
    }
  });

  it('maps the current API on api.ipinfo.io', () => {
    expect(tool('ipinfo_lite_lookup').endpointMapping.path).toBe(`${API}/lite/{ip}`);
    expect(tool('ipinfo_lite_me').endpointMapping.path).toBe(`${API}/lite/me`);
    expect(tool('ipinfo_lookup').endpointMapping.path).toBe(`${API}/lookup/{ip}`);
    expect(tool('ipinfo_get_place').endpointMapping.path).toBe(`${API}/places/{ip}`);
    for (const [name, path] of [['ipinfo_batch_lite', `${API}/batch/lite`], ['ipinfo_batch', `${API}/batch`]]) {
      expect(tool(name).endpointMapping).toMatchObject({ method: 'POST', path, bodyMapping: { __raw: '$ips' }, queryParams: { filter: '$filter' } });
      expect(tool(name).parameters?.properties?.ips.type).toBe('array');
      expect(tool(name).annotations?.readOnlyHint).toBe(true);
    }
  });

  it('maps the classic API on ipinfo.io', () => {
    expect(tool('ipinfo_get_my_ip').endpointMapping.path).toBe('/json');
    expect(tool('ipinfo_get_ip_details').endpointMapping.path).toBe('/{ip}/json');
    expect(tool('ipinfo_get_ip_field').endpointMapping.path).toBe('/{ip}/{field}');
    expect(tool('ipinfo_get_ip_field').parameters?.properties?.field.enum).toEqual(['ip', 'hostname', 'city', 'region', 'country', 'loc', 'postal', 'timezone', 'org']);
    expect(tool('ipinfo_get_token_info').endpointMapping.path).toBe('/me');
    expect(tool('ipinfo_get_asn').endpointMapping.path).toBe('/AS{asn}');
    expect(tool('ipinfo_get_ip_ranges').endpointMapping.path).toBe('/ranges/{domain}');
    expect(tool('ipinfo_get_abuse_contact').endpointMapping.path).toBe('/{ip}/abuse');
    expect(tool('ipinfo_get_privacy').endpointMapping.path).toBe('/{ip}/privacy');
    expect(tool('ipinfo_get_residential_proxy').endpointMapping.path).toBe('/resproxy/{ip}');
    expect(tool('ipinfo_get_company').endpointMapping.path).toBe('/{ip}/company');
    expect(tool('ipinfo_get_carrier').endpointMapping.path).toBe('/{ip}/carrier');
    expect(tool('ipinfo_get_hosted_domains').endpointMapping).toMatchObject({ path: '/domains/{ip}', queryParams: { page: '$page', limit: '$limit' } });
    expect(tool('ipinfo_whois_net').endpointMapping).toMatchObject({ path: '/whois/net/{query}', queryParams: { page: '$page', source: '$source' } });
    expect(tool('ipinfo_whois_org').endpointMapping.path).toBe('/whois/org/{org_id}');
    expect(tool('ipinfo_whois_poc').endpointMapping.path).toBe('/whois/poc/{poc_id}');
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

  it('is read-only: GET everywhere except the two batch reads, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(['ipinfo_batch', 'ipinfo_batch_lite']);
  });

  it('probes with a keyless read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('ipinfo_get_my_ip');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_IPINFO_LIVE === '1' ? describe : describe.skip;
live('ipinfo adapter: live (read-only)', () => {
  const token = process.env.IPINFO_TOKEN;
  const get = async (url: string, withToken = false) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (withToken && token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    expect(res.status).toBe(200);
    return res;
  };
  it('reads the caller IP, an IP and a single field without a token', async () => {
    const me = (await (await get(`${a.connector.baseUrl}/json`)).json()) as { ip: string };
    expect(typeof me.ip).toBe('string');
    const dns = (await (await get(`${a.connector.baseUrl}/8.8.8.8/json`)).json()) as { ip: string; org: string };
    expect(dns.ip).toBe('8.8.8.8');
    expect(dns.org).toMatch(/^AS15169 /);
    expect((await (await get(`${a.connector.baseUrl}/8.8.8.8/country`)).text()).trim()).toBe('US');
  }, 60_000);

  (token ? it : it.skip)('reads Lite and the token info with a token', async () => {
    const lite = (await (await get(`${API}/lite/8.8.8.8`, true)).json()) as { asn: string; country_code: string };
    expect(lite).toMatchObject({ asn: 'AS15169', country_code: 'US' });
    const me = (await (await get(`${a.connector.baseUrl}/me`, true)).json()) as { token: string };
    expect(typeof me.token).toBe('string');
  }, 60_000);
});
