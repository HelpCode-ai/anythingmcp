import * as adapter from './virustotal.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * VirusTotal API v3 (docs.virustotal.com/reference/overview; every reference page embeds
 * its OpenAPI definition): base https://www.virustotal.com/api/v3, API key in the x-apikey
 * header, JSON:API objects, cursor paging through meta.cursor.
 * Live part (reads only: threat categories, a domain report, the EICAR test file report):
 *   VIRUSTOTAL_API_KEY=... RUN_VIRUSTOTAL_LIVE=1 npx jest src/adapters/intl/virustotal
 * A public key allows 4 requests a minute, so the live part spaces its calls.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; bodyEncoding?: string; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
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
const PREFIX = 'virustotal_';
const COLLECTIONS = ['files', 'urls', 'domains', 'ip_addresses'];
const WRITES = ['virustotal_scan_url', 'virustotal_rescan', 'virustotal_add_comment', 'virustotal_add_vote', 'virustotal_delete_comment'];

describe('virustotal adapter: static spec conformance', () => {
  it('sends the key in the x-apikey header against the v3 base URL', () => {
    expect(a.requiredEnvVars).toEqual(['VIRUSTOTAL_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://www.virustotal.com/api/v3');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-apikey', apiKey: '{{VIRUSTOTAL_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/popular_threat_categories');
    expect(a.envVarMeta?.VIRUSTOTAL_API_KEY.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.VIRUSTOTAL_API_KEY.pattern ?? '');
    expect(pattern.test('0123456789abcdef'.repeat(4))).toBe(true);
    expect(pattern.test('0123456789abcdef'.repeat(3))).toBe(false);
  });

  it('maps the four report endpoints, analyses and search', () => {
    expect(tool('virustotal_get_file_report').endpointMapping).toEqual({ method: 'GET', path: '/files/{hash}', queryParams: { relationships: '$relationships' } });
    expect(tool('virustotal_get_url_report').endpointMapping).toEqual({ method: 'GET', path: '/urls/{url_id}', queryParams: { relationships: '$relationships' } });
    expect(tool('virustotal_get_domain_report').endpointMapping).toEqual({ method: 'GET', path: '/domains/{domain}', queryParams: { relationships: '$relationships' } });
    expect(tool('virustotal_get_ip_report').endpointMapping).toEqual({ method: 'GET', path: '/ip_addresses/{ip}', queryParams: { relationships: '$relationships' } });
    expect(tool('virustotal_get_analysis').endpointMapping).toEqual({ method: 'GET', path: '/analyses/{analysis_id}' });
    expect(tool('virustotal_search').endpointMapping).toEqual({ method: 'GET', path: '/search', queryParams: { query: '$query', limit: '$limit', cursor: '$cursor' } });
    expect(tool('virustotal_intelligence_search').endpointMapping).toMatchObject({ path: '/intelligence/search', queryParams: { query: '$query', order: '$order', descriptors_only: '$descriptors_only' } });
  });

  it('maps comments, votes and relationships on any of the four collections', () => {
    expect(tool('virustotal_list_comments').endpointMapping).toEqual({ method: 'GET', path: '/{collection}/{id}/comments', queryParams: { limit: '$limit', cursor: '$cursor' } });
    expect(tool('virustotal_list_votes').endpointMapping.path).toBe('/{collection}/{id}/votes');
    expect(tool('virustotal_list_related_objects').endpointMapping.path).toBe('/{collection}/{id}/{relationship}');
    expect(tool('virustotal_list_related_ids').endpointMapping.path).toBe('/{collection}/{id}/relationships/{relationship}');
    for (const t of a.tools.filter((x) => x.endpointMapping.path.startsWith('/{collection}/'))) {
      expect(t.parameters?.properties?.collection.enum).toEqual(COLLECTIONS);
    }
    expect(tool('virustotal_get_file_behaviour_summary').endpointMapping.path).toBe('/files/{hash}/behaviour_summary');
    expect(tool('virustotal_get_file_mitre_attack').endpointMapping.path).toBe('/files/{hash}/behaviour_mitre_trees');
    expect(tool('virustotal_list_latest_comments').endpointMapping).toEqual({ method: 'GET', path: '/comments', queryParams: { filter: '$filter', limit: '$limit', cursor: '$cursor' } });
    expect(tool('virustotal_get_comment').endpointMapping.path).toBe('/comments/{comment_id}');
    expect(tool('virustotal_get_resolution').endpointMapping.path).toBe('/resolutions/{resolution_id}');
    expect(tool('virustotal_list_popular_threat_categories').endpointMapping).toEqual({ method: 'GET', path: '/popular_threat_categories' });
    expect(tool('virustotal_get_api_usage').endpointMapping).toEqual({ method: 'GET', path: '/users/{user_id}/api_usage', queryParams: { start_date: '$start_date', end_date: '$end_date' } });
  });

  it('builds the write bodies as documented', () => {
    expect(tool('virustotal_scan_url').endpointMapping).toEqual({ method: 'POST', path: '/urls', bodyMapping: { url: '$url' }, bodyEncoding: 'form-urlencoded' });
    expect(tool('virustotal_scan_url').description).toMatch(/shared with the community/);
    expect(tool('virustotal_rescan').endpointMapping).toEqual({ method: 'POST', path: '/{collection}/{id}/analyse' });
    expect(tool('virustotal_add_comment').endpointMapping).toEqual({ method: 'POST', path: '/{collection}/{id}/comments', bodyMapping: { data: { type: 'comment', attributes: { text: '$text' } } } });
    expect(tool('virustotal_add_vote').endpointMapping).toEqual({ method: 'POST', path: '/{collection}/{id}/votes', bodyMapping: { data: { type: 'vote', attributes: { verdict: '$verdict' } } } });
    expect(tool('virustotal_add_vote').parameters?.properties?.verdict.enum).toEqual(['harmless', 'malicious']);
    expect(tool('virustotal_delete_comment').endpointMapping).toEqual({ method: 'DELETE', path: '/comments/{comment_id}' });
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(tool(name).annotations?.readOnlyHint).toBe(false);
    expect(tool('virustotal_delete_comment').annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.endpointMapping.path.includes('upload'))).toEqual([]);
  });

  it('switches off exactly the irreversible URL submission and delete', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['virustotal_scan_url', 'virustotal_delete_comment']);
    expect(a.instructions).toContain('**Switched off at install**: `virustotal_scan_url` and `virustotal_delete_comment`');
  });

  it('drops bulky HTTP and certificate fields from URL, domain and IP reports', () => {
    const url = applyResponseTransform(
      { data: { id: 'u1', attributes: { last_analysis_stats: { malicious: 2 }, last_http_response_headers: { a: 'b' }, html_meta: { x: ['y'] }, trackers: {}, title: 'Login' } } },
      tool('virustotal_get_url_report').responseMapping as never,
    ).value;
    expect(url).toEqual({ data: { id: 'u1', attributes: { last_analysis_stats: { malicious: 2 }, title: 'Login' } } });
    const domain = applyResponseTransform(
      { data: { id: 'example.com', attributes: { reputation: -5, last_https_certificate: { extensions: {} }, whois: 'w' } } },
      tool('virustotal_get_domain_report').responseMapping as never,
    ).value;
    expect(domain).toEqual({ data: { id: 'example.com', attributes: { reputation: -5, whois: 'w' } } });
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('virustotal_list_popular_threat_categories');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_VIRUSTOTAL_LIVE === '1' && process.env.VIRUSTOTAL_API_KEY ? describe : describe.skip;
live('virustotal adapter: live (read-only)', () => {
  const pause = () => new Promise((r) => setTimeout(r, 16_000));
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'x-apikey': String(process.env.VIRUSTOTAL_API_KEY), Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown };
  };
  it('reads threat categories, a domain report and the EICAR test file report', async () => {
    expect(Array.isArray((await get('/popular_threat_categories')).data)).toBe(true);
    await pause();
    const domain = (await get('/domains/virustotal.com')).data as { id: string; attributes: { last_analysis_stats: Record<string, number> } };
    expect(domain.id).toBe('virustotal.com');
    expect(typeof domain.attributes.last_analysis_stats.harmless).toBe('number');
    await pause();
    // MD5 of the harmless EICAR antivirus test string, published by EICAR.
    const file = (await get('/files/44d88612fea8a8f36de82e1278abb02f')).data as { attributes: { last_analysis_stats: { malicious: number } } };
    expect(file.attributes.last_analysis_stats.malicious).toBeGreaterThan(0);
  }, 120_000);
});
