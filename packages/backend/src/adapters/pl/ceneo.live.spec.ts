import axios from 'axios';
import * as adapter from './ceneo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Ceneo API adapter (developers.ceneo.pl).
 *
 * Static checks always run: the API key as the apiKey query parameter of
 * every call, JSON answers, every tool's path against Ceneo's Swagger file,
 * the annotations (this API changes data with GET requests, so the write
 * tools are marked as writes by hand), which tools install switched off (the
 * two bid changes), and that no tool needs Ceneo's bearer token: the order
 * calls ("Kup na Ceneo") and the v3 calls return that token in a response
 * header, which the LOGIN_TOKEN engine cannot read yet, so they are left out.
 * https://developers.ceneo.pl/swagger/ui/index
 *
 * Live checks run only with RUN_CENEO_LIVE=1. Without a key they confirm
 * Ceneo refuses a made-up one; with CENEO_API_KEY they read the call limits.
 *
 *   RUN_CENEO_LIVE=1 CENEO_API_KEY=... npx jest src/adapters/pl/ceneo.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
    download?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
type GuideStep = { id: string; fields?: string[]; values?: Array<{ label: string; value: string }>; confirm?: string };
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; advanced?: boolean; example?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide?: { effort: string; minutes: number; steps: GuideStep[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: Array<Record<string, unknown>> };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  walk(m.download ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://developers.ceneo.pl';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0F1E2D3C', '4B5A', '6978', '8796', 'A5B4C3D2E1F0'].join('-');
const ENV: Record<string, string> = { CENEO_API_KEY: FAKE_KEY };
const fn = (name: string) => `${BASE}/api/v2/function/${name}/Call`;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Every tool with its method, its path below the base URL and its required arguments,
// as the vendor documents them.
const EXPECTED: Array<[string, string, string, string[]]> = [
  ['ceneo_get_execution_limits', 'GET', '/api/v2/function/webapi_meta.GetExecutionLimits/Call', []],
  ['ceneo_get_product_offers', 'GET', '/api/v2/function/webapi_data_critical.shop_getProductOffersBy_IDs/Call', ['shop_product_ids']],
  ['ceneo_get_product_top10_offers', 'GET', '/api/v2/function/webapi_data_critical.shop_getProductTop10OffersBy_IDs/Call', ['shop_product_ids']],
  ['ceneo_get_product_bids_by_ceneo_id', 'GET', '/api/v2/function/bidding.GetProductsBidsByCeneoProductId/Call', ['products']],
  ['ceneo_get_product_bids_by_shop_id', 'GET', '/api/v2/function/bidding.GetProductsBidsByShopProductId/Call', ['products']],
  ['ceneo_get_category_bid', 'GET', '/api/v2/function/bidding.GetCategoryBidByCategoryId/Call', ['category_id']],
  ['ceneo_set_product_bids', 'GET', '/api/v2/function/bidding.SetProductsBids/Call', ['bids']],
  ['ceneo_set_category_bids', 'GET', '/api/v2/function/bidding.SetCategoryBids/Call', ['bids']],
  ['ceneo_update_offers', 'GET', '/api/v2/function/offer_processor.process_offers/Call', ['xml']],
];

describe('ceneo adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key as the apiKey query parameter', () => {
    expect(a.slug).toBe('ceneo');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('ceneo');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apiKey: '{{CENEO_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['CENEO_API_KEY']);
    expect(a.envVarMeta.CENEO_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.CENEO_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    expect(pattern.test(a.envVarMeta.CENEO_API_KEY.example!)).toBe(true);
    for (const bad of ['', `Basic ${FAKE_KEY}`, 'not-a-key', `${FAKE_KEY} `]) expect(pattern.test(bad)).toBe(false);
  });

  it('uses only the functions that take the API key, and asks for JSON', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).toMatch(/^\/api\/v2\/function\/[A-Za-z_.0-9]+\/Call$/);
      expect(entry.endpointMapping.path).not.toContain('BasketService');
      expect(entry.endpointMapping.queryParams?.resultFormatter).toBe('json');
      expect(entry.endpointMapping.queryParams?.apiKey).toBeUndefined();
    }
  });

  it('marks the GET requests that change data as writes', () => {
    const writes = ['ceneo_set_product_bids', 'ceneo_set_category_bids', 'ceneo_update_offers'];
    for (const name of writes) {
      expect(tool(name).annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toContain('it is a write');
    }
    for (const entry of a.tools) {
      if (!writes.includes(entry.name)) expect(entry.annotations).toEqual({ readOnlyHint: true });
    }
    expect(tool('ceneo_update_offers').enabled).not.toBe(false);
  });

  it('turns a FAILED answer inside a 200 response into an error', () => {
    const rules = a.connector.config!.errorWhen!;
    expect(rules.map((rule) => rule.status)).toEqual([401, 403, 429, 400]);
    for (const rule of rules) expect(rule).toMatchObject({ path: 'Response.Status', equals: 'FAILED', messagePath: 'Response.Exceptions.Exception[0]' });
  });

  it('probes the call limits and explains 400, 401, 403 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'ceneo_get_execution_limits', params: {} });
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('exposes every tool on the documented method and path, with its required arguments', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, method, path, required] of EXPECTED) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ceneo_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(schema.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('derives read-only for the reads only and installs both bid changes switched off', () => {
    const READS: string[] = ['ceneo_get_category_bid', 'ceneo_get_execution_limits', 'ceneo_get_product_bids_by_ceneo_id', 'ceneo_get_product_bids_by_shop_id', 'ceneo_get_product_offers', 'ceneo_get_product_top10_offers'];
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, READS.includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['ceneo_set_category_bids', 'ceneo_set_product_bids']);
    for (const name of off) expect(tool(name).description).toContain('Installed switched off');
  });

  it('names every tool in the instructions and keeps the texts safe for the website', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, ...a.tools.flatMap((entry) => [entry.description, ...Object.values(entry.parameters.properties ?? {}).map((p) => p.description ?? '')])];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('reads the call limits with the key and the JSON formatter in the query', async () => {
    ok();
    await call('ceneo_get_execution_limits', {});
    const req = sent();
    expect(req.url).toBe(fn('webapi_meta.GetExecutionLimits'));
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json' });
    expect(header(req, 'Authorization')).toBeUndefined();
  });

  it('passes shop product ids, bid lookups and the offer XML as Ceneo names them', async () => {
    ok();
    await call('ceneo_get_product_top10_offers', { shop_product_ids: 'item100,item200' });
    expect(sent().url).toBe(fn('webapi_data_critical.shop_getProductTop10OffersBy_IDs'));
    expect(sent().params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json', shop_product_ids_comma_separated: 'item100,item200' });

    ok();
    await call('ceneo_get_product_offers', { shop_product_ids: 'item100' });
    expect(sent().url).toBe(fn('webapi_data_critical.shop_getProductOffersBy_IDs'));

    const products = JSON.stringify([{ ShopProductId: 'item100' }]);
    ok();
    await call('ceneo_get_product_bids_by_shop_id', { products });
    expect(sent().url).toBe(fn('bidding.GetProductsBidsByShopProductId'));
    expect(sent().params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json', products });

    ok();
    await call('ceneo_get_category_bid', { category_id: 2111 });
    expect(sent().url).toBe(fn('bidding.GetCategoryBidByCategoryId'));
    expect(sent().params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json', categoryId: 2111 });

    const bids = JSON.stringify([{ CeneoProductId: 1, MaxBid: 0.25 }]);
    ok();
    await call('ceneo_set_product_bids', { bids });
    expect(sent().url).toBe(fn('bidding.SetProductsBids'));
    expect(sent().params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json', bids });

    const xml = '<offers><o id="37" price="899.00" avail="1" stock="2"><name><![CDATA[Product XYZ]]></name></o></offers>';
    ok();
    await call('ceneo_update_offers', { xml });
    expect(sent().url).toBe(fn('offer_processor.process_offers'));
    expect(sent().params).toEqual({ apiKey: FAKE_KEY, resultFormatter: 'json', xml });
  });
});

// Opt-in: RUN_CENEO_LIVE=1. The refusal check needs no account; the read needs
// CENEO_API_KEY. Nothing is written.
const live = process.env.RUN_CENEO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ceneo: live', () => {
  it('refuses a made-up key', async () => {
    const response = await liveFetch.get(fn('webapi_meta.GetExecutionLimits'), {
      params: { apiKey: 'not-a-key', resultFormatter: 'json' },
      validateStatus: () => true,
    });
    expect([400, 401, 403]).toContain(response.status);
  });

  it('reads the call limits', async () => {
    const key = process.env.CENEO_API_KEY;
    if (!key) throw new Error('Set CENEO_API_KEY for the live check');
    const response = await liveFetch.get(fn('webapi_meta.GetExecutionLimits'), {
      params: { apiKey: key, resultFormatter: 'json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.Response.Status).toBe('OK');
  });
});
