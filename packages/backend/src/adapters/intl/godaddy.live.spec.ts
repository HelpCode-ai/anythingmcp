import * as adapter from './godaddy.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * GoDaddy Domains API v1 (developer.godaddy.com, OpenAPI at
 * developer.godaddy.com/openapi/domains-v1.json): base https://api.godaddy.com,
 * a Personal Access Token as Bearer token (the classic sso-key credential is
 * being retired for the Domains API in 2026).
 * Live part (reads only: TLDs, availability, the account's domains, one domain and its DNS records):
 *   GODADDY_PAT=... RUN_GODADDY_LIVE=1 npx jest src/adapters/intl/godaddy
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
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
  return out;
};
const PREFIX = 'godaddy_';
const D = '/v1/domains';
const READS = [
  'godaddy_list_domains',
  'godaddy_get_domain',
  'godaddy_check_availability',
  'godaddy_check_availability_bulk',
  'godaddy_suggest_domains',
  'godaddy_list_tlds',
  'godaddy_list_dns_records',
  'godaddy_get_dns_records',
];

describe('godaddy adapter: static spec conformance', () => {
  it('authenticates with a Personal Access Token as Bearer token on api.godaddy.com', () => {
    expect(a.requiredEnvVars).toEqual(['GODADDY_PAT']);
    expect(a.connector.baseUrl).toBe('https://api.godaddy.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GODADDY_PAT}}' });
    expect(a.envVarMeta?.GODADDY_PAT.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.GODADDY_PAT.pattern ?? '');
    expect(re.test('Bearer abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(re.test('sso-key abcdefghijklmnopqrstuvwxyz:secret')).toBe(false);
    expect(re.test('gdpat_AbCdEfGhIjKlMnOpQrStUvWxYz0123')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith(D)).toBe(true);
  });

  it('maps the domain, availability and suggestion endpoints with the documented query names', () => {
    expect(tool('godaddy_list_domains').endpointMapping).toEqual({
      method: 'GET',
      path: D,
      queryParams: { statuses: '$statuses', statusGroups: '$status_groups', includes: '$includes', modifiedDate: '$modified_date', limit: '$limit', marker: '$marker' },
    });
    expect(tool('godaddy_get_domain').endpointMapping).toEqual({ method: 'GET', path: `${D}/{domain}` });
    expect(tool('godaddy_check_availability').endpointMapping).toEqual({
      method: 'GET',
      path: `${D}/available`,
      queryParams: { domain: '$domain', checkType: '$check_type', forTransfer: '$for_transfer' },
    });
    expect(tool('godaddy_check_availability_bulk').endpointMapping).toEqual({
      method: 'POST',
      path: `${D}/available`,
      queryParams: { checkType: '$check_type' },
      bodyMapping: { __raw: '$domains' },
    });
    expect(tool('godaddy_suggest_domains').endpointMapping).toMatchObject({
      path: `${D}/suggest`,
      queryParams: { query: '$query', tlds: '$tlds', sources: '$sources', lengthMin: '$length_min', lengthMax: '$length_max', waitMs: '$wait_ms' },
    });
    expect(tool('godaddy_list_tlds').endpointMapping).toEqual({ method: 'GET', path: `${D}/tlds` });
  });

  it('maps DNS reads and writes per type and name; the array body goes out as given', () => {
    expect(tool('godaddy_list_dns_records').endpointMapping).toEqual({ method: 'GET', path: `${D}/{domain}/records`, queryParams: { offset: '$offset', limit: '$limit' } });
    expect(tool('godaddy_get_dns_records').endpointMapping.path).toBe(`${D}/{domain}/records/{type}/{name}`);
    expect(tool('godaddy_add_dns_records').endpointMapping).toEqual({ method: 'PATCH', path: `${D}/{domain}/records`, bodyMapping: { __raw: '$records' } });
    expect(tool('godaddy_replace_dns_records').endpointMapping).toEqual({ method: 'PUT', path: `${D}/{domain}/records/{type}/{name}`, bodyMapping: { __raw: '$records' } });
    expect(tool('godaddy_delete_dns_records').endpointMapping).toEqual({ method: 'DELETE', path: `${D}/{domain}/records/{type}/{name}` });
    // The API refuses to delete NS and SOA records by type and name.
    expect(tool('godaddy_delete_dns_records').parameters?.properties?.type.enum).not.toContain('NS');
    expect(tool('godaddy_delete_dns_records').parameters?.properties?.type.enum).not.toContain('SOA');
    // The whole-zone PUT and the per-type PUT are left out on purpose.
    for (const t of a.tools) expect(`${t.endpointMapping.method} ${t.endpointMapping.path}`).not.toMatch(/^PUT .*\/records(\/\{type\})?$/);
  });

  it('maps settings, contacts, verification and renewal; buying and cancelling are not offered', () => {
    expect(tool('godaddy_update_domain').endpointMapping).toEqual({
      method: 'PATCH',
      path: `${D}/{domain}`,
      bodyMapping: { locked: '$locked', renewAuto: '$renew_auto', nameServers: '$name_servers' },
    });
    expect(tool('godaddy_update_contacts').endpointMapping).toEqual({
      method: 'PATCH',
      path: `${D}/{domain}/contacts`,
      bodyMapping: { contactRegistrant: '$contact_registrant', contactAdmin: '$contact_admin', contactBilling: '$contact_billing', contactTech: '$contact_tech' },
    });
    expect(tool('godaddy_resend_registrant_verification').endpointMapping).toEqual({ method: 'POST', path: `${D}/{domain}/verifyRegistrantEmail` });
    expect(tool('godaddy_renew_domain').endpointMapping).toEqual({ method: 'POST', path: `${D}/{domain}/renew`, bodyMapping: { period: '$period' } });
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/purchase|transfer|agreements/);
      expect(`${t.endpointMapping.method} ${t.endpointMapping.path}`).not.toBe(`DELETE ${D}/{domain}`);
    }
  });

  it('marks reads read-only, destructive writes destructive, and installs the paid renewal switched off', () => {
    for (const n of READS) {
      const t = tool(n);
      expect(`${n}:${t.endpointMapping.method === 'GET' || t.annotations?.readOnlyHint === true}`).toBe(`${n}:true`);
      expect(t.enabled).toBeUndefined();
    }
    for (const n of ['godaddy_replace_dns_records', 'godaddy_delete_dns_records', 'godaddy_update_domain', 'godaddy_update_contacts', 'godaddy_renew_domain']) {
      expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tool('godaddy_add_dns_records').annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(tool('godaddy_renew_domain').enabled).toBe(false);
    expect(tool('godaddy_renew_domain').annotations?.idempotentHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['godaddy_renew_domain']);
  });

  it('drops the transfer authorization code from a domain', () => {
    const out = applyResponseTransform(
      { domain: 'example.com', status: 'ACTIVE', authCode: 'secret-epp', nameServers: ['ns1.domaincontrol.com'] },
      tool('godaddy_get_domain').responseMapping as never,
    ).value;
    expect(out).toEqual({ domain: 'example.com', status: 'ACTIVE', nameServers: ['ns1.domaincontrol.com'] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('godaddy_list_domains');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/10 or more domains/);
    expect(a.instructions).toMatch(/micro units/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_GODADDY_LIVE === '1' && process.env.GODADDY_PAT ? describe : describe.skip;
live('godaddy adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.GODADDY_PAT}`, Accept: 'application/json' } });
    expect(`${path} ${res.status}`).toBe(`${path} 200`);
    return res.json() as Promise<unknown>;
  };
  it('reads TLDs, an availability check, the domain list and the first domain with its DNS records', async () => {
    const tlds = (await get(`${D}/tlds`)) as Array<{ name: string }>;
    expect(tlds.map((t) => t.name)).toContain('com');
    const avail = (await get(`${D}/available?domain=example.com`)) as { available: boolean; domain: string };
    expect(avail).toMatchObject({ domain: 'example.com', available: false });
    const domains = (await get(`${D}?limit=5`)) as Array<{ domain: string; status: string }>;
    expect(Array.isArray(domains)).toBe(true);
    if (domains.length) {
      const d = domains[0].domain;
      const detail = (await get(`${D}/${d}`)) as { domain: string; expires?: string };
      expect(detail.domain).toBe(d);
      expect(Array.isArray(await get(`${D}/${d}/records?limit=20`))).toBe(true);
    }
  }, 60_000);
});
