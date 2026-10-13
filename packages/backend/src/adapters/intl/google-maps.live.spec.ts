import axios from 'axios';
import * as adapter from './google-maps.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Three layers of verification for the Google Maps adapter:
 *
 *   1. Static: always runs. Pins the API key header, every tool's method and
 *      URL on the three Google hosts (Places API (New) checked against its
 *      discovery document, revision 20261011; Geocoding v4 and Routes v2
 *      against Google's REST reference), the request bodies, the default
 *      field masks (which decide the billed SKU) and that every tool reads.
 *
 *   2. Routes: RUN_GOOGLE_MAPS_LIVE=1 sends every tool through the real engine
 *      with a placeholder key. Each route answers 400 "API key not valid",
 *      which proves the method and path exist (an unknown path answers 404).
 *
 *   3. Live reads: skipped unless GOOGLE_MAPS_API_KEY is set. Runs the free
 *      install probe, one text search, a geocode, a reverse geocode and a
 *      route; each billable call stays well inside the free monthly caps.
 *
 *        GOOGLE_MAPS_API_KEY=... npx jest src/adapters/intl/google-maps.live.spec.ts
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
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real key.
const KEY = `AIza${'k3y'.repeat(12)}`;
const ENV = { GOOGLE_MAPS_API_KEY: KEY };
const PLACES = 'https://places.googleapis.com/v1';
const GEOCODE = 'https://geocode.googleapis.com/v4';
const ROUTES = 'https://routes.googleapis.com';
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const SEARCH_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.businessStatus,places.googleMapsUri';
// Fields Google bills above Pro on searches and details (Enterprise and Enterprise + Atmosphere).
const EXPENSIVE = ['rating', 'userRatingCount', 'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'regularOpeningHours', 'currentOpeningHours', 'priceLevel', 'reviews', 'editorialSummary', 'reviewSummary'];

const WAYPOINT_A = { address: 'Freiburg Hauptbahnhof' };
const WAYPOINT_B = { placeId: PLACE_ID };

// [tool, args, method, full URL]
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['google_maps_search_text', { text_query: 'pizza in Freiburg' }, 'POST', `${PLACES}/places:searchText`],
  ['google_maps_search_nearby', { latitude: 47.995, longitude: 7.85 }, 'POST', `${PLACES}/places:searchNearby`],
  ['google_maps_get_place', { place_id: PLACE_ID }, 'GET', `${PLACES}/places/${PLACE_ID}`],
  ['google_maps_get_place_photo', { photo_name: `places/${PLACE_ID}/photos/AXCi2Q` }, 'GET', `${PLACES}/places/${PLACE_ID}/photos/AXCi2Q/media`],
  ['google_maps_autocomplete', { input: 'Münsterpl' }, 'POST', `${PLACES}/places:autocomplete`],
  ['google_maps_geocode_address', { address: 'Kaiser-Joseph-Straße 167, Freiburg' }, 'GET', `${GEOCODE}/geocode/address/Kaiser-Joseph-Stra%C3%9Fe%20167%2C%20Freiburg`],
  ['google_maps_reverse_geocode', { latitude: 47.995, longitude: 7.85 }, 'GET', `${GEOCODE}/geocode/location`],
  ['google_maps_compute_routes', { origin: WAYPOINT_A, destination: WAYPOINT_B }, 'POST', `${ROUTES}/directions/v2:computeRoutes`],
  ['google_maps_compute_route_matrix', { origins: [{ waypoint: WAYPOINT_A }], destinations: [{ waypoint: WAYPOINT_B }] }, 'POST', `${ROUTES}/distanceMatrix/v2:computeRouteMatrix`],
];

describe('google-maps adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (routes probed, Places bodies checked against the discovery document, customer traffic on searchText)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the key in X-Goog-Api-Key, never in the URL', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Goog-Api-Key', apiKey: '{{GOOGLE_MAPS_API_KEY}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    for (const [name, params] of table) {
      mockedAxios.mockClear();
      await call(name, params);
      expect(`${name}:${sent().headers['X-Goog-Api-Key']}`).toBe(`${name}:${KEY}`);
      expect(sent().url).not.toContain(KEY);
      expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY);
      expect(JSON.stringify(sent().data ?? {})).not.toContain(KEY);
    }
  });

  it('only talks to the three Google Maps Platform hosts', () => {
    for (const t of a.tools) {
      const url = /^https:/.test(t.endpointMapping.path) ? t.endpointMapping.path : `${a.connector.baseUrl}${t.endpointMapping.path}`;
      expect(url).toMatch(/^https:\/\/(places|geocode|routes)\.googleapis\.com\//);
    }
  });

  it('describes the key and keeps it secret', () => {
    expect(a.requiredEnvVars).toEqual(['GOOGLE_MAPS_API_KEY']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'GOOGLE_MAPS_API_KEY')!.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.GOOGLE_MAPS_API_KEY.pattern!);
    expect(pattern.test(KEY)).toBe(true);
    expect(pattern.test(`${KEY} `)).toBe(false);
    expect(a.verifyHints['400']).toMatch(/API_KEY_INVALID/);
    expect(a.verifyHints['403']).toMatch(/Places API \(New\)/);
  });

  it('probes with the free ID-only Place Details call', async () => {
    expect(a.probe).toEqual({ tool: 'google_maps_get_place', params: { place_id: PLACE_ID, field_mask: 'id' } });
    mockedAxios.mockResolvedValue({ data: { id: PLACE_ID } });
    await call(a.probe.tool, a.probe.params!);
    expect(sent().headers['X-Goog-FieldMask']).toBe('id');
  });

  it('prefixes every tool with google_maps_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_maps_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every tool read-only, POST searches included, and installs them all switched on', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(t.enabled).toBeUndefined();
      expect(t.description).toMatch(/Read-only\.$/);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
  });

  it('keeps the default field masks on the Pro tier and never on Enterprise fields', () => {
    const search = tool('google_maps_search_text').parameters.properties!.field_mask.default as string;
    const nearby = tool('google_maps_search_nearby').parameters.properties!.field_mask.default as string;
    const details = tool('google_maps_get_place').parameters.properties!.field_mask.default as string;
    expect(search).toBe(`${SEARCH_MASK},nextPageToken`);
    expect(nearby).toBe(SEARCH_MASK);
    expect(details).toBe('id,displayName,formattedAddress,location,types,primaryType,businessStatus,googleMapsUri,utcOffsetMinutes');
    for (const mask of [search, nearby, details]) {
      const fields = mask.split(',').map((f) => f.replace(/^places\./, ''));
      for (const f of EXPENSIVE) expect(fields).not.toContain(f);
    }
    // Routes and matrices are refused without a mask; both send a lean default.
    expect(tool('google_maps_compute_routes').parameters.properties!.field_mask.default).not.toMatch(/polyline|steps/);
    expect(tool('google_maps_compute_route_matrix').parameters.properties!.field_mask.default).toContain('distanceMeters');
  });

  it('sends the field mask header, and a caller mask in place of the default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_maps_search_text', { text_query: 'dental clinic Al Yasmin Riyadh' });
    expect(sent().headers['X-Goog-FieldMask']).toBe(`${SEARCH_MASK},nextPageToken`);
    mockedAxios.mockClear();
    await call('google_maps_search_text', { text_query: 'x', field_mask: 'places.id,places.websiteUri' });
    expect(sent().headers['X-Goog-FieldMask']).toBe('places.id,places.websiteUri');
    // Geocoding needs no mask: without one the header is left out.
    mockedAxios.mockClear();
    await call('google_maps_geocode_address', { address: 'Freiburg' });
    expect(sent().headers).not.toHaveProperty('X-Goog-FieldMask');
  });

  it('builds a text search body from the arguments given, passing the bias through', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const bias = { circle: { center: { latitude: 24.82, longitude: 46.64 }, radius: 3000 } };
    await call('google_maps_search_text', {
      text_query: 'dental clinic',
      language_code: 'ar',
      region_code: 'SA',
      min_rating: 4,
      open_now: true,
      price_levels: ['PRICE_LEVEL_MODERATE'],
      location_bias: bias,
      page_token: 'tok',
    });
    expect(sent().data).toEqual({
      textQuery: 'dental clinic',
      pageSize: 10,
      pageToken: 'tok',
      languageCode: 'ar',
      regionCode: 'SA',
      openNow: true,
      minRating: 4,
      priceLevels: ['PRICE_LEVEL_MODERATE'],
      locationBias: bias,
    });
  });

  it('searches nearby inside a circle with the radius in meters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_maps_search_nearby', { latitude: 47.995, longitude: 7.85, radius_meters: 500, included_types: ['cafe'], rank_preference: 'DISTANCE' });
    expect(sent().data).toEqual({
      locationRestriction: { circle: { center: { latitude: 47.995, longitude: 7.85 }, radius: 500 } },
      includedTypes: ['cafe'],
      maxResultCount: 10,
      rankPreference: 'DISTANCE',
    });
  });

  it('encodes the place id, asks for a JSON photo link and passes the session token', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_maps_get_place', { place_id: '../places:searchText', session_token: 's-1' });
    expect(sent().url).toBe(`${PLACES}/places/..%2Fplaces%3AsearchText`);
    expect(sent().params).toEqual({ sessionToken: 's-1' });
    mockedAxios.mockClear();
    await call('google_maps_get_place_photo', { photo_name: `places/${PLACE_ID}/photos/AXCi2Q` });
    expect(sent().params).toEqual({ maxWidthPx: 800, skipHttpRedirect: 'true' });
  });

  it('reverse-geocodes with location.latitude and location.longitude and repeated filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_maps_reverse_geocode', { latitude: 47.995, longitude: 7.85, types: ['street_address'], language_code: 'de' });
    expect(sent().params).toEqual({ 'location.latitude': 47.995, 'location.longitude': 7.85, languageCode: 'de', types: ['street_address'] });
  });

  it('computes routes without a routing preference unless asked, so the cheapest SKU applies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_maps_compute_routes', { origin: WAYPOINT_A, destination: WAYPOINT_B, route_modifiers: { avoidTolls: true } });
    expect(sent().data).toEqual({ origin: WAYPOINT_A, destination: WAYPOINT_B, travelMode: 'DRIVE', routeModifiers: { avoidTolls: true } });
    mockedAxios.mockClear();
    await call('google_maps_compute_route_matrix', { origins: [{ waypoint: WAYPOINT_A }], destinations: [{ waypoint: WAYPOINT_B }], travel_mode: 'WALK' });
    expect(sent().data).toEqual({ origins: [{ waypoint: WAYPOINT_A }], destinations: [{ waypoint: WAYPOINT_B }], travelMode: 'WALK' });
  });

  it('explains billing per SKU, the setup and the alternative MCP server', () => {
    expect(a.instructions).toMatch(/Field masks decide the price/);
    for (const sku of ['IDs only', 'Essentials', 'Pro', 'Enterprise + Atmosphere', 'Place Details Photos', 'Geocoding', 'Compute Routes Essentials']) {
      expect(a.instructions).toContain(sku);
    }
    expect(a.instructions).toMatch(/Places API \(New\)/);
    expect(a.instructions).toMatch(/billing/);
    expect(a.instructions).toContain('mapstools.googleapis.com/mcp');
    expect(a.instructions).toContain('googleMapsUri');
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_maps_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_maps_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const routesLive = process.env.RUN_GOOGLE_MAPS_LIVE === '1' ? describe : describe.skip;

routesLive('google-maps adapter: every route exists (placeholder key)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it.each(table)('%s reaches a real route that refuses the placeholder key', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ status: 400 });
  }, 30_000);
});

const LIVE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const live = LIVE_KEY ? describe : describe.skip;

live('google-maps adapter: live reads', () => {
  const env = { GOOGLE_MAPS_API_KEY: LIVE_KEY as string };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown>): Promise<any> => execute(name, env, params);

  it('runs the free probe', async () => {
    expect((await run(a.probe.tool, a.probe.params!)).id).toBe(PLACE_ID);
  }, 30_000);

  it('searches, geocodes both ways and computes a route', async () => {
    const found = await run('google_maps_search_text', { text_query: 'Münster Freiburg im Breisgau', page_size: 1 });
    expect(found.places[0].displayName.text).toBeTruthy();
    const geo = await run('google_maps_geocode_address', { address: 'Münsterplatz, Freiburg im Breisgau' });
    const { latitude, longitude } = geo.results[0].location;
    expect(Math.round(latitude)).toBe(48);
    const back = await run('google_maps_reverse_geocode', { latitude, longitude, types: ['locality'] });
    expect(back.results[0].formattedAddress).toMatch(/Freiburg/);
    const route = await run('google_maps_compute_routes', { origin: { address: 'Freiburg Hauptbahnhof' }, destination: { address: 'Basel SBB' } });
    expect(route.routes[0].distanceMeters).toBeGreaterThan(50_000);
  }, 60_000);
});
