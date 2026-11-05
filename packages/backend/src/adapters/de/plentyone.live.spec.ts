import axios from 'axios';
import * as adapter from './plentyone.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return { __esModule: true, default: Object.assign(mocked, actual.default, { __actual: actual.default }), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

/**
 * PlentyONE (plentymarkets) REST API (developers.plentymarkets.com): POST /rest/login with an API user,
 * then Bearer. Checked read-only with an API user on 22 Oct 2026; that user has no order
 * or contact rights, so orders, order statuses and contacts follow the official reference only.
 * Live part: PLENTYONE_URL=https://pXXXXX.my.plentysystems.com PLENTYONE_USERNAME=... PLENTYONE_PASSWORD=...
 * RUN_PLENTYONE_LIVE=1 npx jest src/adapters/de/plentyone (reads only: webstores, variations, warehouses).
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
  unlisted?: boolean;
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
const PREFIX = 'plentyone_';
// Installed switched off.
const WRITES: string[] = ["plentyone_create_item", "plentyone_update_variation"];
// Edits installed on: they ask for a yes before every call.
const EDITS = [
  'plentyone_edit_item',
  'plentyone_edit_item_texts',
  'plentyone_link_property',
  'plentyone_add_property_relation_value',
  'plentyone_set_property_relation_values',
  'plentyone_edit_variation_market_sku',
  'plentyone_check_listing_market',
  'plentyone_edit_order',
];
const ENV = { PLENTYONE_URL: 'https://p12345.my.plentysystems.com', PLENTYONE_USERNAME: 'api', PLENTYONE_PASSWORD: 'secret-pass' };
const stubLogin = { getToken: async () => ({ token: 'tok', expiresAt: Date.now() + 86_400_000 }), forceRelogin: async () => ({ token: 'tok', expiresAt: Date.now() + 86_400_000 }) } as unknown as LoginTokenService;
const send = async (name: string, params: Record<string, unknown>) => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ data: {} });
  const { config: cfg, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  await new RestEngine({} as OAuth2TokenService, stubLogin).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: cfg.headers } as never,
    endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return mockedAxios.mock.calls[0][0];
};

describe('plentyone adapter: static spec conformance', () => {

  it('signs in at /rest/login with the API user and sends the access token as Bearer', () => {
    expect(a.requiredEnvVars).toEqual(['PLENTYONE_URL', 'PLENTYONE_USERNAME', 'PLENTYONE_PASSWORD']);
    expect(a.connector.baseUrl).toBe('{{PLENTYONE_URL}}/rest');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{PLENTYONE_URL}}/rest/login',
      loginMethod: 'POST',
      loginBody: { username: '${username}', password: '${password}' },
      username: '{{PLENTYONE_USERNAME}}',
      password: '{{PLENTYONE_PASSWORD}}',
      tokenJsonPath: 'access_token',
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
      refreshOn401: true,
    });
    expect(a.envVarMeta?.PLENTYONE_PASSWORD.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.PLENTYONE_URL.pattern as string).test('https://p72240.my.plentysystems.com')).toBe(true);
    expect(new RegExp(a.envVarMeta?.PLENTYONE_URL.pattern as string).test('https://p72240.my.plentysystems.com/rest')).toBe(false);
    expect(a.region).toBe('de');
  });

  it('maps the documented routes', () => {
    expect(tool('plentyone_search_orders').endpointMapping).toMatchObject({ method: 'GET', path: '/orders/search', queryParams: { statusId: '$statusId', createdAt: '$createdAt', page: '$page', itemsPerPage: '$itemsPerPage' } });
    expect(tool('plentyone_get_order').endpointMapping).toMatchObject({ path: '/orders/{orderId}', queryParams: { 'with[]': '$with' } });
    expect(tool('plentyone_search_variations').endpointMapping).toMatchObject({ path: '/items/variations', queryParams: { numberExact: '$numberExact', barcode: '$barcode', with: '$with' } });
    expect(tool('plentyone_get_warehouse_stock').endpointMapping.path).toBe('/stockmanagement/warehouses/{warehouseId}/stock');
    expect(tool('plentyone_create_item').endpointMapping).toMatchObject({ method: 'POST', path: '/items', bodyMapping: { variations: '$variations' } });
    expect(tool('plentyone_update_variation').endpointMapping).toMatchObject({ method: 'PUT', path: '/items/{itemId}/variations/{variationId}' });
  });

  // Routes and fields from the official OpenAPI reference (openApiV2WithExamples.json, 5 Nov 2026).
  it('maps the property, marketplace, item edit and order edit routes', async () => {
    const R = 'https://p12345.my.plentysystems.com/rest';
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['plentyone_list_property_relations', { relationTypeIdentifier: 'item', relationTargetId: 1001 }, 'GET', '/properties/relations'],
      ['plentyone_get_variation_market_skus', { itemId: 10, variationId: 1001 }, 'GET', '/items/10/variations/1001/variation_skus'],
      ['plentyone_get_variation_property_values', { itemId: 10, variationId: 1001 }, 'GET', '/items/10/variations/1001/variation_properties'],
      ['plentyone_search_listing_markets', { itemId: 10 }, 'GET', '/listings/markets'],
      ['plentyone_search_listing_market_messages', { listingMarketId: 7 }, 'GET', '/listings/markets/infos'],
      ['plentyone_search_listing_market_history', { listingMarketId: 7 }, 'GET', '/listings/markets/histories'],
      ['plentyone_edit_item', { itemId: 10, manufacturerId: 3 }, 'PUT', '/items/10'],
      ['plentyone_edit_item_texts', { itemId: 10, variationId: 1001, lang: 'de', name: 'Tasse' }, 'PUT', '/items/10/variations/1001/descriptions/de'],
      ['plentyone_link_property', { propertyId: 5, relationTypeIdentifier: 'item', relationTargetId: 1001 }, 'POST', '/properties/relations'],
      ['plentyone_add_property_relation_value', { propertyRelationId: 120, lang: 'de', value: 'Baumwolle' }, 'POST', '/properties/relations/values'],
      ['plentyone_set_property_relation_values', { values: [{ id: 55, lang: 'de', value: 'Leinen' }] }, 'PUT', '/properties/relations/values'],
      ['plentyone_edit_variation_market_sku', { itemId: 10, variationId: 1001, skuId: 9, sku: 'ABC-1' }, 'PUT', '/items/10/variations/1001/variation_skus/9'],
      ['plentyone_check_listing_market', { listingMarketId: 7 }, 'POST', '/listings/markets/verify/7'],
      ['plentyone_edit_order', { orderId: 500, statusId: 5 }, 'PUT', '/orders/500'],
    ];
    for (const [name, params, method, path] of cases) {
      const req = await send(name, params);
      expect(`${name}:${req.method} ${req.url}`).toBe(`${name}:${method} ${R}${path}`);
      expect(req.headers.Authorization).toBe('Bearer tok');
    }
  });

  it('builds the documented bodies and queries', async () => {
    expect((await send('plentyone_edit_item', { itemId: 10, manufacturerId: 3, flagOne: 2, fields: { amazonFedas: 'X', manufacturerId: 9 } })).data).toEqual({ amazonFedas: 'X', manufacturerId: 3, flagOne: 2 });
    expect((await send('plentyone_edit_item_texts', { itemId: 10, variationId: 1001, lang: 'de', name: 'Tasse', description: '<p>Neu</p>' })).data).toEqual({ name: 'Tasse', description: '<p>Neu</p>' });
    expect((await send('plentyone_link_property', { propertyId: 5, relationTypeIdentifier: 'item', relationTargetId: 1001 })).data).toEqual({ propertyId: 5, relationTypeIdentifier: 'item', relationTargetId: 1001 });
    expect((await send('plentyone_add_property_relation_value', { propertyRelationId: 120, lang: 'de', value: 'Baumwolle' })).data).toEqual({ propertyRelationId: 120, lang: 'de', value: 'Baumwolle' });
    // The bulk update takes a top-level JSON array.
    const bulk = [{ id: 55, relationId: 120, lang: 'de', value: 'Leinen' }];
    expect((await send('plentyone_set_property_relation_values', { values: bulk })).data).toEqual(bulk);
    expect((await send('plentyone_edit_variation_market_sku', { itemId: 10, variationId: 1001, skuId: 9, marketId: 4.01, accountId: 2, sku: 'ABC-1' })).data).toEqual({ marketId: 4.01, accountId: 2, sku: 'ABC-1' });
    expect((await send('plentyone_edit_order', { orderId: 500, orderItems: [{ id: 345, quantity: 2 }] })).data).toEqual({ orderItems: [{ id: 345, quantity: 2 }] });
    expect((await send('plentyone_search_listing_markets', { status: 'online', with: ['infos'] })).params).toEqual({ status: 'online', 'with[]': ['infos'], page: 1, itemsPerPage: 25 });
    expect((await send('plentyone_list_property_relations', { relationTypeIdentifier: 'item', relationTargetId: 1001 })).params).toEqual({ relationTypeIdentifier: 'item', relationTargetId: 1001, paginate: 1, page: 1, itemsPerPage: 25 });
  });

  it('edits are annotated as writes, installed on, and ask for a yes', () => {
    for (const n of EDITS) {
      expect(tool(n).annotations?.readOnlyHint).toBe(false);
      expect(tool(n).enabled).toBeUndefined();
      if (n !== 'plentyone_check_listing_market') expect(`${n}:${/yes/.test(tool(n).description)}`).toBe(`${n}:true`);
    }
  });

  it('keeps the price list definitions small (each repeats every country)', () => {
    const out = applyResponseTransform(
      { page: 1, totalsCount: 1, isLastPage: true, lastPageNumber: 1, entries: [{ id: 1, type: 'default', countries: new Array(277).fill({ countryId: 1 }), names: [{ nameExternal: 'Preis' }] }] },
      tool('plentyone_list_sales_prices').responseMapping as never,
    ).value as { entries: Record<string, unknown>[] };
    expect(out.entries[0]).toMatchObject({ id: 1, type: 'default' });
    expect(out.entries[0].countries).toBeUndefined();
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

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });


  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_PLENTYONE_LIVE === '1' && process.env.PLENTYONE_URL && process.env.PLENTYONE_USERNAME && process.env.PLENTYONE_PASSWORD ? describe : describe.skip;
live('plentyone adapter: live (read-only)', () => {
  const base = (process.env.PLENTYONE_URL ?? '').replace(/\/$/, '');
  it('signs in and reads webstores, variations and warehouses', async () => {
    const login = (await (
      await fetch(`${base}/rest/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: process.env.PLENTYONE_USERNAME, password: process.env.PLENTYONE_PASSWORD }),
      })
    ).json()) as { access_token: string };
    expect(login.access_token).toBeTruthy();
    const headers = { Authorization: `Bearer ${login.access_token}`, Accept: 'application/json' };
    const stores = await (await fetch(`${base}/rest/webstores`, { headers })).json();
    expect(Array.isArray(stores)).toBe(true);
    const vars = (await (await fetch(`${base}/rest/items/variations?itemsPerPage=1`, { headers })).json()) as { totalsCount: number };
    expect(typeof vars.totalsCount).toBe('number');
    const wh = await (await fetch(`${base}/rest/stockmanagement/warehouses`, { headers })).json();
    expect(Array.isArray(wh)).toBe(true);
  }, 60_000);
});
