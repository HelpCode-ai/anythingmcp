import * as adapter from './internetdata.json';

/**
 * InternetData (docs.internetdata.io/api): address, AS and domain lookups on
 * https://api.internetdata.io. The key is optional and sent as a Bearer header
 * only when INTERNETDATA_API_KEY is set; every tool also answers without one.
 * Live part (reads only, without a key):
 *   RUN_INTERNETDATA_LIVE=1 npx jest src/adapters/intl/internetdata
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
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

describe('internetdata adapter: static spec conformance', () => {
  it('sends the optional key as a Bearer header on every tool, never in the URL', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['INTERNETDATA_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.internetdata.io');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.envVarMeta?.INTERNETDATA_API_KEY.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.INTERNETDATA_API_KEY.pattern ?? '');
    expect(pattern.test('Bearer x')).toBe(false);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.headers?.Authorization}`).toBe(`${t.name}:Bearer \${INTERNETDATA_API_KEY}`);
      expect(t.endpointMapping.queryParams).toBeUndefined();
    }
  });

  it('maps the address, own address, AS and domain lookups', () => {
    expect(tool('internetdata_lookup_ip').endpointMapping.path).toBe('/{ip}');
    expect(tool('internetdata_get_my_ip').endpointMapping.path).toBe('/myip');
    expect(tool('internetdata_lookup_asn').endpointMapping.path).toBe('/asn/{asn}');
    expect(tool('internetdata_lookup_asn').parameters?.properties?.asn.type).toBe('integer');
    expect(tool('internetdata_lookup_domain').endpointMapping.path).toBe('/domain/{domain}');
  });

  it('every tool is a prefixed GET read, its path parameters declared and required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('internetdata_')).toBe(true);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      const path = [...t.endpointMapping.path.matchAll(/\{(\w+)\}/g)].map(([, p]) => p);
      expect(Object.keys(t.parameters?.properties ?? {})).toEqual(path);
      expect(t.parameters?.required ?? []).toEqual(path);
    }
  });

  it('probes with a keyless tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('internetdata_get_my_ip');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_INTERNETDATA_LIVE === '1' ? describe : describe.skip;
live('internetdata adapter: live (read-only, no key)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('looks up an IPv4 and an IPv6 address', async () => {
    const dns = (await get('/8.8.8.8')) as { ip: string; is_anycast: boolean; location: { country: string }; asn: { asn: number; domain: string } };
    expect(dns).toMatchObject({ ip: '8.8.8.8', location: { country: 'US' }, asn: { asn: 15169, domain: 'google.com' } });
    expect(typeof dns.is_anycast).toBe('boolean');
    const v6 = (await get('/2001:4860:4860::8888')) as { ip: string; asn: { asn: number } };
    expect(v6).toMatchObject({ ip: '2001:4860:4860::8888', asn: { asn: 15169 } });
  }, 60_000);

  it('looks up the caller IP, an AS and a domain', async () => {
    const me = (await get('/myip')) as { ip: string; is_tor: boolean };
    expect(typeof me.ip).toBe('string');
    expect(typeof me.is_tor).toBe('boolean');
    expect(await get('/asn/15169')).toMatchObject({ asn: 15169, name: 'Google LLC', country: 'US' });
    expect(await get('/domain/example.com')).toMatchObject({ domain: 'example.com', is_registered: true });
  }, 60_000);
});
