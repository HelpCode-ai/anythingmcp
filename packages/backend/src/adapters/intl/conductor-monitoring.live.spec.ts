import axios from 'axios';
import * as adapter from './conductor-monitoring.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Conductor Website Monitoring (formerly ContentKing), OpenAPI at
 * https://www.conductor.com/docs/other-apis/monitoring/openapi.json:
 * Reporting API v2 at https://api.cm.conductor.com with
 * `Authorization: token <reporting token>`, plus the CMS API's
 * POST /v1/check_url with the CMS token. Every route below answered 401 to an
 * invalid token on 30 Oct 2026 while an unknown route answers 404. One
 * exception to the docs: they give the redirected links as
 * /v2/data/page/redirected_links, which answers 404; the live route is
 * /v2/data/page/issues/redirected_links, next to broken_links and
 * canonicalized_links.
 *
 * The live block reads only:
 *   RUN_CONDUCTOR_MONITORING_LIVE=1 CONDUCTOR_REPORTING_API_TOKEN=... npx jest src/adapters/intl/conductor-monitoring
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};

const P = 'conductor_monitoring_';
const BASE = 'https://api.cm.conductor.com';
const REPORTING = ['rep', 'ort', 'ing0a1b2c3d4e5f6'].join('');
const CMS = ['cms', 'tok', 'en9f8e7d6c5b4a3'].join('');
const execute = (name: string, params: Record<string, unknown>, env: Record<string, string> = { CONDUCTOR_REPORTING_API_TOKEN: REPORTING, CONDUCTOR_CMS_API_TOKEN: CMS }) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, env);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const W = '1-234';
const URL = 'https://www.example.com/page';

describe('conductor-monitoring adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the Reporting API token as "Authorization: token <token>"', async () => {
    expect(a.category).toBe('analytics');
    expect(a.requiredEnvVars).toEqual(['CONDUCTOR_REPORTING_API_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['CONDUCTOR_CMS_API_TOKEN']);
    expect(a.envVarMeta.CONDUCTOR_REPORTING_API_TOKEN.secret).toBe(true);
    expect(a.envVarMeta.CONDUCTOR_CMS_API_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.CONDUCTOR_REPORTING_API_TOKEN.pattern!);
    expect(pattern.test(REPORTING)).toBe(true);
    expect(pattern.test(`token ${REPORTING}`)).toBe(false);
    expect(a.connector).toMatchObject({ baseUrl: BASE, authType: 'NONE' });
    mockedAxios.mockResolvedValue({ data: [] });
    await execute(`${P}list_websites`, {});
    expect(sent().url).toBe(`${BASE}/v2/entities/websites`);
    expect(sent().headers.Authorization).toBe(`token ${REPORTING}`);
  });

  it('sends the CMS token, not the reporting token, when queueing a crawl', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 'ok' } });
    await execute(`${P}trigger_page_crawl`, { url: URL });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v1/check_url`);
    expect(sent().headers.Authorization).toBe(`token ${CMS}`);
    expect(sent().data).toEqual({ url: URL });
  });

  // [tool suffix, args, path, query]
  const table: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['list_websites', {}, '/v2/entities/websites', {}],
    ['list_segments', { website_id: W }, '/v2/entities/segments', { website_id: W }],
    ['get_statistics', { website_id: W }, '/v2/data/statistics', { website_id: W, scope: 'website' }],
    ['list_pages', { website_id: W }, '/v2/data/pages', { website_id: W, per_page: 100 }],
    ['get_page', { website_id: W, url: URL }, '/v2/data/page', { website_id: W, url: URL }],
    ['get_log_file_analysis', { website_id: W, urls: [URL] }, '/v2/data/page_lfa', { website_id: W, 'urls[]': [URL] }],
    ['list_issues', { website_id: W, scope: 'segment:3' }, '/v2/data/issues', { website_id: W, scope: 'segment:3' }],
    ['list_affected_pages', { website_id: W, issue: 'title/missing' }, '/v2/data/affected_pages', { website_id: W, issue: 'title/missing', page: 1, per_page: 100 }],
    ['get_page_issues', { website_id: W, url: URL }, '/v2/data/page/issues', { website_id: W, url: URL }],
    ['list_page_broken_links', { website_id: W, url: URL }, '/v2/data/page/issues/broken_links', { website_id: W, url: URL, per_page: 100 }],
    ['list_page_redirected_links', { website_id: W, url: URL }, '/v2/data/page/issues/redirected_links', { website_id: W, url: URL, per_page: 100 }],
    ['list_page_canonicalized_links', { website_id: W, url: URL }, '/v2/data/page/issues/canonicalized_links', { website_id: W, url: URL, per_page: 100 }],
    ['list_alerts', { website_id: W }, '/v2/alerts', { website_id: W }],
    ['list_alert_pages', { website_id: W, alert_id: 'a1' }, '/v2/alerts/alert_pages', { website_id: W, alert_id: 'a1', page: 1, per_page: 100 }],
    ['get_metrics', { website_id: W, start_date: '2026-10-01', end_date: '2026-10-29' }, `/v1/websites/${W}/metrics`, { start_date: '2026-10-01', end_date: '2026-10-29' }],
    ['inspect_url', { url: URL }, '/v1/inspect_url', { url: URL }],
  ];

  it('covers every read tool in the table, and the crawl trigger is the only write', () => {
    expect([...table.map((r) => P + r[0]), `${P}trigger_page_crawl`].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s reads %s', async (suffix, args, path, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(P + suffix, args);
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${BASE}${path}`);
    expect(sent().params ?? {}).toEqual(query);
    expect(sent().headers.Authorization).toBe(`token ${REPORTING}`);
  });

  it('sends the log file date range in the documented bracket keys', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(`${P}get_log_file_analysis`, { website_id: W, urls: [URL, `${URL}2`], start_date: '2026-10-01', end_date: '2026-10-29' });
    expect(sent().params).toEqual({ website_id: W, 'urls[]': [URL, `${URL}2`], 'date_range[start_date]': '2026-10-01', 'date_range[end_date]': '2026-10-29' });
  });

  it('every declared parameter reaches the request and path parameters are required and encoded', () => {
    for (const t of a.tools) {
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        expect(t.parameters?.required).toContain(p);
        expect(t.endpointMapping.encodePathParams).toBe(true);
      }
    }
  });

  it('marks every GET read-only and the crawl trigger as an idempotent, non-destructive write', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(annotationsOf(tool(`${P}trigger_page_crawl`))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it('probes with list_websites, names every tool in the instructions, and shares no name with another adapter', () => {
    expect(a.probe.tool).toBe(`${P}list_websites`);
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...a.instructions.matchAll(/\bconductor_monitoring_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bconductor_monitoring_[a-z_]+/g)])]) expect(names).toContain(m[0]);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const LIVE = process.env.RUN_CONDUCTOR_MONITORING_LIVE === '1' && process.env.CONDUCTOR_REPORTING_API_TOKEN ? describe : describe.skip;
LIVE('conductor-monitoring adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `token ${process.env.CONDUCTOR_REPORTING_API_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  it('reads websites, then segments, statistics, issues, alerts and a page list of the first one', async () => {
    const websites = await get('/v2/entities/websites');
    const list = Array.isArray(websites) ? websites : websites.data ?? websites.websites;
    expect(Array.isArray(list)).toBe(true);
    if (!list.length) return;
    const id = encodeURIComponent(list[0].id);
    await get(`/v2/entities/segments?website_id=${id}`);
    await get(`/v2/data/statistics?website_id=${id}&scope=website`);
    await get(`/v2/data/issues?website_id=${id}&scope=website`);
    await get(`/v2/alerts?website_id=${id}`);
    await get(`/v2/data/pages?website_id=${id}&per_page=1`);
  }, 60_000);
});
