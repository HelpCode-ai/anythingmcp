import * as adapter from './open-meteo.json';

/**
 * Open-Meteo free weather APIs (https://open-meteo.com/en/docs), no key, non-commercial use, CC BY 4.0.
 * One adapter over several hosts: api (forecast, elevation), archive-api, historical-forecast-api,
 * geocoding-api, air-quality-api, marine-api, flood-api, climate-api, ensemble-api, seasonal-api.
 * Tools on another host than the base URL carry an absolute path.
 * Live part (keyless, six calls): RUN_OPEN_METEO_LIVE=1 npx jest src/adapters/intl/open-meteo
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[] } };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  category: string;
  aliases?: string[];
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  verifyHints?: Record<string, unknown>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values in query, body and headers.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const SLUG = 'open-meteo';
const REGION = 'intl';
const BASE = 'https://api.open-meteo.com';
const PREFIX = 'open_meteo_';
const ENV_VARS: string[] = [];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  open_meteo_search_locations: ['GET', 'https://geocoding-api.open-meteo.com/v1/search', ['name']],
  open_meteo_get_location: ['GET', 'https://geocoding-api.open-meteo.com/v1/get', ['id']],
  open_meteo_get_forecast: ['GET', '/v1/forecast', ['latitude', 'longitude']],
  open_meteo_get_historical_weather: ['GET', 'https://archive-api.open-meteo.com/v1/archive', ['latitude', 'longitude', 'start_date', 'end_date']],
  open_meteo_get_historical_forecast: ['GET', 'https://historical-forecast-api.open-meteo.com/v1/forecast', ['latitude', 'longitude', 'start_date', 'end_date']],
  open_meteo_get_air_quality: ['GET', 'https://air-quality-api.open-meteo.com/v1/air-quality', ['latitude', 'longitude']],
  open_meteo_get_marine_forecast: ['GET', 'https://marine-api.open-meteo.com/v1/marine', ['latitude', 'longitude']],
  open_meteo_get_elevation: ['GET', '/v1/elevation', ['latitude', 'longitude']],
  open_meteo_get_flood_forecast: ['GET', 'https://flood-api.open-meteo.com/v1/flood', ['latitude', 'longitude']],
  open_meteo_get_climate_projection: ['GET', 'https://climate-api.open-meteo.com/v1/climate', ['latitude', 'longitude', 'start_date', 'end_date', 'daily']],
  open_meteo_get_ensemble_forecast: ['GET', 'https://ensemble-api.open-meteo.com/v1/ensemble', ['latitude', 'longitude', 'models']],
  open_meteo_get_seasonal_forecast: ['GET', 'https://seasonal-api.open-meteo.com/v1/seasonal', ['latitude', 'longitude', 'daily']],
};

describe('open-meteo adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('data');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.headers?.['User-Agent']).toBe('AnythingMCP');
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('probes with a read tool and arguments it declares', () => {
    const p = a.probe!;
    const t = tool(p.tool);
    expect(t.enabled).toBeUndefined();
    const props = Object.keys(t.parameters?.properties ?? {});
    for (const k of Object.keys(p.params ?? {})) expect(props).toContain(k);
    for (const r of t.parameters?.required ?? []) expect(Object.keys(p.params ?? {})).toContain(r);
  });

  it('pins the method, path and required arguments of every tool', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const [name, [method, path, required]] of Object.entries(TOOLS)) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:${path}`);
      expect(`${name}:${(t.parameters?.required ?? []).join(',')}`).toBe(`${name}:${required.join(',')}`);
    }
  });

  it('every tool is prefixed, described, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || ENV_VARS.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs exactly the expected tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...OFF].sort());
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('is read-only and reaches the other Open-Meteo hosts with absolute paths', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    const hosts = new Set(a.tools.map((t) => (t.endpointMapping.path.startsWith('https://') ? new URL(t.endpointMapping.path).host : new URL(BASE).host)));
    expect([...hosts].sort()).toEqual([
      'air-quality-api.open-meteo.com',
      'api.open-meteo.com',
      'archive-api.open-meteo.com',
      'climate-api.open-meteo.com',
      'ensemble-api.open-meteo.com',
      'flood-api.open-meteo.com',
      'geocoding-api.open-meteo.com',
      'historical-forecast-api.open-meteo.com',
      'marine-api.open-meteo.com',
      'seasonal-api.open-meteo.com',
    ]);
    for (const h of hosts) expect(h.startsWith('customer-')).toBe(false);
  });

  it('maps the documented query names and unit choices', () => {
    expect(tool('open_meteo_search_locations').endpointMapping.queryParams).toMatchObject({ name: '$name', count: '$count', language: '$language', countryCode: '$country_code' });
    const f = tool('open_meteo_get_forecast');
    expect(f.endpointMapping.queryParams).toMatchObject({ latitude: '$latitude', longitude: '$longitude', current: '$current', hourly: '$hourly', daily: '$daily', timezone: '$timezone', forecast_days: '$forecast_days', past_days: '$past_days', temperature_unit: '$temperature_unit', wind_speed_unit: '$wind_speed_unit', precipitation_unit: '$precipitation_unit' });
    expect(f.parameters?.properties?.temperature_unit.enum).toEqual(['celsius', 'fahrenheit']);
    expect(f.parameters?.properties?.wind_speed_unit.enum).toEqual(['kmh', 'ms', 'mph', 'kn']);
    expect(tool('open_meteo_get_air_quality').parameters?.properties?.domains.enum).toEqual(['auto', 'cams_europe', 'cams_global']);
    expect(tool('open_meteo_get_ensemble_forecast').parameters?.required).toContain('models');
    expect(a.probe).toEqual({ tool: 'open_meteo_get_forecast', params: { latitude: 52.52, longitude: 13.41, current: 'temperature_2m' } });
  });
});

const live = process.env.RUN_OPEN_METEO_LIVE === '1' ? describe : describe.skip;
live('open-meteo adapter: live (keyless, read-only)', () => {
  const get = async (url: string) => (await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } })).json();
  it('finds a place, then reads forecast, archive, air quality, marine and elevation', async () => {
    const geo = (await get('https://geocoding-api.open-meteo.com/v1/search?name=Freiburg&count=1&countryCode=DE')) as { results: { id: number; latitude: number; timezone: string }[] };
    expect(geo.results[0].id).toBe(2925177);
    expect(geo.results[0].timezone).toBe('Europe/Berlin');
    const fc = (await get(`${BASE}/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m&daily=temperature_2m_max&timezone=auto&forecast_days=2`)) as { current_units: { temperature_2m: string }; daily: { time: string[]; temperature_2m_max: number[] } };
    expect(fc.current_units.temperature_2m).toBe('°C');
    expect(fc.daily.time).toHaveLength(2);
    const hist = (await get('https://archive-api.open-meteo.com/v1/archive?latitude=52.52&longitude=13.41&start_date=2024-01-01&end_date=2024-01-03&daily=precipitation_sum')) as { daily: { time: string[] } };
    expect(hist.daily.time).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    const air = (await get('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=52.52&longitude=13.41&current=european_aqi,pm2_5')) as { current: { european_aqi: number } };
    expect(typeof air.current.european_aqi).toBe('number');
    const sea = (await get('https://marine-api.open-meteo.com/v1/marine?latitude=54.54&longitude=10.23&current=wave_height')) as { current_units: { wave_height: string } };
    expect(sea.current_units.wave_height).toBe('m');
    const ele = (await get(`${BASE}/v1/elevation?latitude=52.52,47.99&longitude=13.41,7.85`)) as { elevation: number[] };
    expect(ele.elevation).toHaveLength(2);
  }, 60_000);
});
