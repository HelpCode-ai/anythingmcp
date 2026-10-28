import * as adapter from './fred.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * FRED API (fred.stlouisfed.org/docs/api/fred/): api_key and file_type=json as
 * query parameters on https://api.stlouisfed.org/fred/<request>, all GET.
 * Live part: RUN_FRED_LIVE=1 FRED_API_KEY=... npx jest src/adapters/intl/fred
 * (reads only: a series, its latest observations, the root categories, a release calendar).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'fred_';

describe('fred adapter: static spec conformance', () => {
  it('sends the key as the api_key query parameter to api.stlouisfed.org/fred', () => {
    expect(a.slug).toBe('fred');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('fred');
    expect(a.docsUrl).toBe('https://fred.stlouisfed.org/docs/api/fred/');
    expect(a.requiredEnvVars).toEqual(['FRED_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.stlouisfed.org/fred');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ api_key: '{{FRED_API_KEY}}' });
    expect(a.envVarMeta?.FRED_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.FRED_API_KEY.pattern as string).test('abcdef0123456789abcdef0123456789')).toBe(true);
    expect(new RegExp(a.envVarMeta?.FRED_API_KEY.pattern as string).test('ABCDEF0123456789abcdef0123456789')).toBe(false);
  });

  it('asks every request for JSON (FRED defaults to XML)', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.queryParams?.file_type}`).toBe(`${t.name}:json`);
  });

  it('maps the documented FRED requests', () => {
    const routes: Record<string, string> = {
      fred_search_series: '/series/search',
      fred_get_series: '/series',
      fred_get_observations: '/series/observations',
      fred_get_series_categories: '/series/categories',
      fred_get_series_release: '/series/release',
      fred_get_series_tags: '/series/tags',
      fred_list_vintage_dates: '/series/vintagedates',
      fred_list_series_updates: '/series/updates',
      fred_get_category: '/category',
      fred_list_category_children: '/category/children',
      fred_list_category_series: '/category/series',
      fred_list_releases: '/releases',
      fred_list_release_dates: '/releases/dates',
      fred_get_release: '/release',
      fred_get_release_dates: '/release/dates',
      fred_list_release_series: '/release/series',
      fred_list_sources: '/sources',
      fred_get_source: '/source',
      fred_list_source_releases: '/source/releases',
      fred_search_tags: '/tags',
      fred_list_tag_series: '/tags/series',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, path] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path });
  });

  it('exposes the observation options with the documented values', () => {
    const t = tool('fred_get_observations');
    expect(t.endpointMapping.queryParams).toEqual({
      series_id: '$series_id',
      observation_start: '$observation_start',
      observation_end: '$observation_end',
      units: '$units',
      frequency: '$frequency',
      aggregation_method: '$aggregation_method',
      sort_order: '$sort_order',
      limit: '$limit',
      offset: '$offset',
      realtime_start: '$realtime_start',
      realtime_end: '$realtime_end',
      file_type: 'json',
    });
    const p = t.parameters?.properties ?? {};
    expect(p.units.enum).toEqual(['lin', 'chg', 'ch1', 'pch', 'pc1', 'pca', 'cch', 'cca', 'log']);
    expect(p.frequency.enum).toEqual(['d', 'w', 'bw', 'm', 'q', 'sa', 'a', 'wef', 'weth', 'wew', 'wetu', 'wem', 'wesu', 'wesa', 'bwew', 'bwem']);
    expect(p.aggregation_method.enum).toEqual(['avg', 'sum', 'eop']);
    expect(p.sort_order.default).toBe('desc');
    expect(p.limit).toMatchObject({ default: 1000, maximum: 100000 });
    expect(t.parameters?.required).toEqual(['series_id']);
    expect(tool('fred_search_series').endpointMapping.queryParams).toMatchObject({ search_text: '$search_text', search_type: '$search_type', filter_variable: '$filter_variable', filter_value: '$filter_value', tag_names: '$tag_names' });
    expect(tool('fred_list_tag_series').parameters?.required).toEqual(['tag_names']);
    expect(tool('fred_get_release_dates').endpointMapping.queryParams).toMatchObject({ release_id: '$release_id', include_release_dates_with_no_data: '$include_release_dates_with_no_data' });
  });

  it('slims observations to date and value and keeps the period metadata', () => {
    const out = applyResponseTransform(
      {
        realtime_start: '2026-10-27', realtime_end: '2026-10-27', observation_start: '1600-01-01', observation_end: '9999-12-31',
        units: 'lin', output_type: 1, file_type: 'json', order_by: 'observation_date', sort_order: 'desc', count: 2, offset: 0, limit: 1000,
        observations: [
          { realtime_start: '2026-10-27', realtime_end: '2026-10-27', date: '2026-10-24', value: '4.02' },
          { realtime_start: '2026-10-27', realtime_end: '2026-10-27', date: '2026-10-23', value: '.' },
        ],
      },
      tool('fred_get_observations').responseMapping as never,
    ).value as Record<string, unknown>;
    expect(out).toMatchObject({ count: 2, sort_order: 'desc', units: 'lin', realtime_start: '2026-10-27' });
    expect(out.observations).toEqual([{ date: '2026-10-24', value: '4.02' }, { date: '2026-10-23', value: '.' }]);
  });

  it('slims series listings and leaves the long notes to fred_get_series', () => {
    const raw = {
      count: 1, offset: 0, limit: 25,
      seriess: [{ id: 'UNRATE', title: 'Unemployment Rate', frequency: 'Monthly', frequency_short: 'M', units: 'Percent', units_short: '%', seasonal_adjustment_short: 'SA', observation_start: '1948-01-01', observation_end: '2026-09-01', last_updated: '2026-10-03 07:51:01-05', popularity: 95, notes: 'long text' }],
    };
    for (const n of ['fred_search_series', 'fred_list_category_series', 'fred_list_release_series', 'fred_list_tag_series', 'fred_list_series_updates']) {
      const out = applyResponseTransform(raw, tool(n).responseMapping as never).value as { count: number; series: Record<string, unknown>[] };
      expect(out.count).toBe(1);
      expect(out.series[0]).toEqual({ id: 'UNRATE', title: 'Unemployment Rate', frequency: 'M', units: '%', seasonal_adjustment: 'SA', observation_start: '1948-01-01', observation_end: '2026-09-01', last_updated: '2026-10-03 07:51:01-05', popularity: 95 });
    }
    expect(tool('fred_get_series').responseMapping).toBeUndefined();
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

  it('is read-only: every tool is a GET marked read-only and installs enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('fred_get_category');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FRED_LIVE === '1' && process.env.FRED_API_KEY ? describe : describe.skip;
live('fred adapter: live (read-only)', () => {
  const base = 'https://api.stlouisfed.org/fred';
  const q = (params: Record<string, string>) => new URLSearchParams({ ...params, api_key: process.env.FRED_API_KEY as string, file_type: 'json' }).toString();
  const getJson = async (path: string, params: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}?${q(params)}`);
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it('reads a series, its latest observation, the root categories and a release calendar', async () => {
    const series = (await getJson('/series', { series_id: 'UNRATE' })) as { seriess: Array<{ id: string; frequency_short: string }> };
    expect(series.seriess[0]).toMatchObject({ id: 'UNRATE', frequency_short: 'M' });
    const obs = await getJson('/series/observations', { series_id: 'DGS10', sort_order: 'desc', limit: '1' });
    const shaped = applyResponseTransform(obs, tool('fred_get_observations').responseMapping as never).value as { observations: Array<{ date: string; value: string }> };
    expect(shaped.observations).toHaveLength(1);
    expect(shaped.observations[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const children = (await getJson('/category/children', { category_id: '0' })) as { categories: unknown[] };
    expect(children.categories.length).toBeGreaterThan(3);
    const dates = (await getJson('/release/dates', { release_id: '50', sort_order: 'desc', limit: '3' })) as { release_dates: Array<{ release_id: number }> };
    expect(dates.release_dates[0].release_id).toBe(50);
    const search = await getJson('/series/search', { search_text: 'consumer price index', limit: '3' });
    const rows = applyResponseTransform(search, tool('fred_search_series').responseMapping as never).value as { series: unknown[] };
    expect(rows.series.length).toBeGreaterThan(0);
  }, 60_000);
});
