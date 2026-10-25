import * as adapter from './xovi.json';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
/**
 * XOVI Suite API (developers.xovi.net, API reference per service and method): root
 * https://suite.xovi.net/api/<service>/<method>, personal key in the key parameter, JSON envelope
 * {apiErrorCode, apiErrorMessage, apiResult} with errors reported inside HTTP 200.
 * Live part: XOVI_API_KEY=... RUN_XOVI_LIVE=1 npx jest src/adapters/de/xovi
 * (reads only: the credit state, which costs no credits).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, any>; headers?: Record<string, string>; config?: Record<string, any> };
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
const PREFIX = 'xovi_';
const WRITES: string[] = [];
const SWITCHED_OFF: string[] = [];

describe('xovi adapter: static spec conformance', () => {

  it('calls the XOVI Suite API directly with the key as query parameter and JSON output', () => {
    expect(a.requiredEnvVars).toEqual(['XOVI_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://suite.xovi.net/api');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{XOVI_API_KEY}}' });
    expect(a.envVarMeta?.XOVI_API_KEY.secret).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/workers\.dev|proxy/i);
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.queryParams?.format}`).toBe(`${t.name}:json`);
    expect(a.probe?.tool).toBe('xovi_get_credit_state');
    expect(tool('xovi_get_credit_state').endpointMapping.path).toBe('/user/getCreditstate');
  });

  it('maps the documented service/method routes and their parameters', () => {
    expect(tool('xovi_get_ovi_trend').endpointMapping).toEqual({ method: 'GET', path: '/keywords/getStaticOviTrend', queryParams: { format: 'json', urlpattern: '$urlpattern', sengine: '$sengine', limit: '$limit', skip: '$skip', date: '$date' } });
    expect(tool('xovi_list_ranking_keywords').endpointMapping).toMatchObject({ path: '/keywords/getKeywords', queryParams: { urlpattern: '$urlpattern', sengine: '$sengine' } });
    expect(tool('xovi_get_ranking_value').endpointMapping.path).toBe('/keywords/getRankingValue');
    expect(tool('xovi_get_ranking_trend').endpointMapping.path).toBe('/keywords/getRankingTrend');
    expect(tool('xovi_get_keyword_trend').endpointMapping).toMatchObject({ path: '/keywords/getKeywordTrend', queryParams: { keyword: '$keyword' } });
    expect(tool('xovi_get_keyword_serp').endpointMapping.path).toBe('/keywords/getKeywordRankings');
    expect(tool('xovi_list_search_engines').endpointMapping).toMatchObject({ path: '/keywords/getSearchEngines', queryParams: { interval: '$interval' } });
    expect(tool('xovi_list_monitoring_domains').endpointMapping).toMatchObject({ path: '/monitor/getDomains', queryParams: { sengineid: '$sengineid' } });
    expect(tool('xovi_list_monitoring_keywords').endpointMapping).toMatchObject({ path: '/monitor/getKeywords', queryParams: { isRanking: '$isRanking', posMin: '$posMin', posMax: '$posMax', labelid: '$labelid' } });
    expect(tool('xovi_get_monitoring_keyword_trend').parameters?.required).toEqual(['sengineid', 'domain', 'keyword']);
    expect(tool('xovi_get_monitoring_serp').endpointMapping.path).toBe('/monitor/getKeywordRankings');
    expect(tool('xovi_get_monitoring_ovi_trend').endpointMapping).toMatchObject({ path: '/monitor/getOviTrend', queryParams: { projhash: '$projhash' } });
    expect(tool('xovi_get_monitoring_keyword_limits').endpointMapping.path).toBe('/monitor/getKeywordLimits');
    expect(tool('xovi_list_projects').endpointMapping.path).toBe('/project/getProjects');
    expect(tool('xovi_list_labels').endpointMapping.path).toBe('/project/getLabels');
    expect(tool('xovi_get_limits').endpointMapping.path).toBe('/user/getXoviLimits');
    for (const t of a.tools) {
      const lim = t.parameters?.properties?.limit as { maximum?: number } | undefined;
      if (lim) expect(`${t.name}:${lim.maximum}`).toBe(`${t.name}:1000`);
    }
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('turns the errors XOVI reports inside HTTP 200 into failed calls', () => {
    const rules = (a.connector.config as { errorWhen: unknown }).errorWhen;
    const status = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, rules);
        return 200;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(status({ apiErrorCode: 2, apiErrorMessage: 'param invalid', paramname: 'key' })).toBe(401);
    expect(status({ apiErrorCode: 1, apiErrorMessage: 'param missing', paramname: 'key' })).toBe(401);
    expect(status({ apiErrorCode: 2, apiErrorMessage: 'param invalid', paramname: 'sengine' })).toBe(400);
    expect(status({ apiErrorCode: 4, apiErrorMessage: 'no permission' })).toBe(403);
    expect(status({ apiErrorCode: 7, apiErrorMessage: 'cost error' })).toBe(429);
    expect(status({ apiErrorCode: 0, apiErrorMessage: '0k.', apiResult: { creditsleft: 5280 } })).toBe(200);
    expect(status({ apiErrorCode: 6, apiErrorMessage: 'result empty', apiResult: [] })).toBe(200);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      if (t.endpointMapping.method === 'static') continue;
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (!['GET', 'static'].includes(t.endpointMapping.method) && !t.endpointMapping.method.startsWith('odata_')) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('documents every tool in the instructions, marks secrets and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    for (const [name, meta] of Object.entries(a.envVarMeta ?? {})) if (/PASSWORD|SECRET|TOKEN/.test(name) || name.endsWith('_KEY')) expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
    if (a.probe) {
      const probe = tool(a.probe.tool);
      expect(probe.annotations?.readOnlyHint === false).toBe(false);
      expect(probe.parameters?.required ?? []).toEqual([]);
    }
  });
});

const live = process.env.RUN_XOVI_LIVE === '1' && process.env.XOVI_API_KEY ? describe : describe.skip;
live('xovi adapter: live (read-only)', () => {
  it('reads the credit state (free of credits)', async () => {
    const url = `${a.connector.baseUrl}/user/getCreditstate?format=json&key=${encodeURIComponent(process.env.XOVI_API_KEY ?? '')}`;
    const body = (await (await fetch(url)).json()) as { apiErrorCode: number; apiResult: { creditsleft: number } };
    expect(body.apiErrorCode).toBe(0);
    expect(typeof body.apiResult.creditsleft).toBe('number');
  }, 60_000);
});
