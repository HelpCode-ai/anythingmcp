import axios from 'axios';
import * as adapter from './loja-integrada.json';
import * as ssrf from '../../common/ssrf.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Loja Integrada adapter (API v1).
 *
 * Static checks always run: base URL, the combined
 * `Authorization: chave_api <key> aplicacao <app key>` header, env vars, tool
 * names, every argument a mapping reads is declared, read/write hints, and the
 * requests several tools build through the real RestEngine (axios mocked).
 * Paths and fields follow the published OpenAPI document behind
 * https://api-docs.lojaintegrada.com.br/ (openapi/API-Loja-Integrada.json):
 *   GET  /v1/produto/                 GET/PUT /v1/produto/{id}
 *   GET  /v1/produto_estoque/{id}     PUT /v1/produto_estoque/{id}
 *   PUT  /v1/produto_preco/{id}       GET /v1/pedido/search/
 *   PUT  /v1/situacao/pedido/{numero} PUT /v1/pedido_envio/{id}
 *
 * Live checks run only with RUN_LOJA_INTEGRADA_LIVE=1. Without keys they check
 * that the API refuses a call without credentials; with LOJA_INTEGRADA_API_KEY
 * and LOJA_INTEGRADA_APP_KEY (from an IP registered with the application key)
 * they read order statuses, one page of products and one page of orders:
 *
 *   RUN_LOJA_INTEGRADA_LIVE=1 LOJA_INTEGRADA_API_KEY=... LOJA_INTEGRADA_APP_KEY=... \
 *     npx jest src/adapters/br/loja-integrada.live.spec.ts
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
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  requiresIpAllowlist?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });
// Every argument a mapping reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

// Built at runtime so no literal looks like a real credential.
const API_KEY = ['q9r1', 'abcd', 'efgh', 'ijkl', 'mnop'].join('');
const APP_KEY = ['dc6049f0', '0000', '4000', '8000', '000000000000'].join('-');
const ENV: Record<string, string> = { LOJA_INTEGRADA_API_KEY: API_KEY, LOJA_INTEGRADA_APP_KEY: APP_KEY };
const AUTH = `chave_api ${API_KEY} aplicacao ${APP_KEY}`;
const BASE = 'https://api.awsli.com.br/v1';
const stubLogin = {} as LoginTokenService;

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin).execute(
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
const ok = (data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: {} });

const WRITES = [
  'loja_integrada_create_brand',
  'loja_integrada_create_category',
  'loja_integrada_create_product',
  'loja_integrada_update_order_status',
  'loja_integrada_update_price',
  'loja_integrada_update_product',
  'loja_integrada_update_stock',
  'loja_integrada_update_tracking_code',
];

describe('loja-integrada adapter: static contract', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    jest.spyOn(ssrf, 'assertSafeOutboundUrl').mockResolvedValue(undefined);
  });

  it('sends chave_api and aplicacao in one Authorization header to api.awsli.com.br/v1', () => {
    expect(a.slug).toBe('loja-integrada');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('loja-integrada');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: 'chave_api {{LOJA_INTEGRADA_API_KEY}} aplicacao {{LOJA_INTEGRADA_APP_KEY}}',
    });
    expect(interpolateDeep(a.connector.authConfig, ENV)).toEqual({ headerName: 'Authorization', apiKey: AUTH });
    expect(a.requiredEnvVars).toEqual(['LOJA_INTEGRADA_API_KEY', 'LOJA_INTEGRADA_APP_KEY']);
    expect(a.requiresIpAllowlist).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) {
      expect(described.find((entry) => entry.name === name)).toMatchObject({ kind: 'credential', secret: true, required: true });
    }
  });

  it('accepts the key shapes and refuses pasted header prefixes', () => {
    const key = new RegExp(a.envVarMeta.LOJA_INTEGRADA_API_KEY.pattern!);
    expect(key.test(API_KEY)).toBe(true);
    for (const bad of ['', 'short', `chave_api ${API_KEY}`]) expect(key.test(bad)).toBe(false);
    const app = new RegExp(a.envVarMeta.LOJA_INTEGRADA_APP_KEY.pattern!);
    expect(app.test(APP_KEY)).toBe(true);
    for (const bad of ['', `aplicacao ${APP_KEY}`]) expect(app.test(bad)).toBe(false);
  });

  it('probes with a list that needs no argument and explains 401, 403 and 429', () => {
    expect(a.probe).toEqual({ tool: 'loja_integrada_list_order_statuses' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^loja_integrada_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(`${entry.name}:${declared.has(arg) || envNames.has(arg)}`).toBe(`${entry.name}:true`);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
      for (const [p, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${p}:${typeof schema.description}`).toBe(`${entry.name}.${p}:string`);
      }
    }
  });

  it('marks every GET read-only, keeps writes to creates and updates, and deletes nothing', () => {
    const writes = a.tools.filter((entry) => annotationsOf(entry).readOnlyHint !== true).map((entry) => entry.name).sort();
    expect(writes).toEqual(WRITES);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).not.toBe('DELETE');
      if (entry.endpointMapping.method === 'GET') expect(annotationsOf(entry).destructiveHint).toBe(false);
    }
    expect(tool('loja_integrada_update_order_status').description).toMatch(/confirm with the user/);
    expect(tool('loja_integrada_update_price').description).toMatch(/Confirm new prices/);
  });

  it('names every tool in the instructions and writes no em dash', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(`\`${entry.name}\``);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('lists products with filters, limit and offset', async () => {
    ok({ meta: { next: null }, objects: [] });
    await call('loja_integrada_list_products', { sku: 'prod-009', ativo: true, modified_since: '2026-10-01' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/produto/`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.headers.Authorization).toBe(AUTH);
    expect(req.params).toEqual({ sku: 'prod-009', ativo: true, data_modificacao__gte: '2026-10-01', limit: 20, offset: 0 });
  });

  it('reads a product by external id with the full description', async () => {
    ok();
    await call('loja_integrada_get_product', { produto_id: '8558855', id_externo: 1, descricao_completa: 1 });
    expect(sent().url).toBe(`${BASE}/produto/8558855`);
    expect(sent().params).toEqual({ id_externo: 1, descricao_completa: 1 });
  });

  it('sets stock and prices with PUT bodies', async () => {
    ok();
    await call('loja_integrada_update_stock', { produto_id: '174389010', quantidade: 12, gerenciado: true });
    expect(sent().url).toBe(`${BASE}/produto_estoque/174389010`);
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ quantidade: 12, gerenciado: true });
    expect(sent().headers.Authorization).toBe(AUTH);

    ok();
    await call('loja_integrada_update_price', { produto_id: '174389010', cheio: 32.9, promocional: 22.9 });
    expect(sent().url).toBe(`${BASE}/produto_preco/174389010`);
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ cheio: 32.9, promocional: 22.9 });
  });

  it('creates a simple product with category and brand URIs', async () => {
    ok({ id: 1 });
    await call('loja_integrada_create_product', {
      nome: 'Camiseta azul',
      sku: 'cam-azul',
      tipo: 'normal',
      ativo: true,
      categorias: ['/api/v1/categoria/15246059'],
      marca: '/api/v1/marca/123456',
    });
    expect(sent().url).toBe(`${BASE}/produto/`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      nome: 'Camiseta azul',
      sku: 'cam-azul',
      tipo: 'normal',
      ativo: true,
      categorias: ['/api/v1/categoria/15246059'],
      marca: '/api/v1/marca/123456',
    });
  });

  it('searches orders, reads one, changes its status and sets a tracking code', async () => {
    ok({ meta: {}, objects: [] });
    await call('loja_integrada_search_orders', { situacao_id: 4, since_criado: '2026-11-01', limit: 50 });
    expect(sent().url).toBe(`${BASE}/pedido/search/`);
    expect(sent().params).toEqual({ situacao_id: 4, since_criado: '2026-11-01', limit: 50, offset: 0 });

    ok();
    await call('loja_integrada_get_order', { numero: 164 });
    expect(sent().url).toBe(`${BASE}/pedido/164`);

    ok();
    await call('loja_integrada_update_order_status', { numero: 164, codigo: 'pedido_enviado' });
    expect(sent().url).toBe(`${BASE}/situacao/pedido/164`);
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ codigo: 'pedido_enviado' });

    ok();
    await call('loja_integrada_update_tracking_code', { pedido_envio_id: 69291055, objeto: 'AA123456789BR' });
    expect(sent().url).toBe(`${BASE}/pedido_envio/69291055`);
    expect(sent().data).toEqual({ objeto: 'AA123456789BR' });
  });

  it('finds a customer by e-mail', async () => {
    ok({ meta: {}, objects: [] });
    await call('loja_integrada_search_customers', { cliente_email: 'ana@example.com.br' });
    expect(sent().url).toBe(`${BASE}/cliente/search/`);
    expect(sent().params).toEqual({ cliente_email: 'ana@example.com.br', limit: 20, offset: 0 });
  });
});

// Opt-in: RUN_LOJA_INTEGRADA_LIVE=1. Reads only.
const live = process.env.RUN_LOJA_INTEGRADA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Loja Integrada: live', () => {
  it('refuses a call without credentials', async () => {
    const response = await liveFetch.get(`${BASE}/situacao/`, { validateStatus: () => true });
    expect([401, 403]).toContain(response.status);
  });

  it('reads order statuses, one page of products and one page of orders', async () => {
    const key = process.env.LOJA_INTEGRADA_API_KEY;
    const app = process.env.LOJA_INTEGRADA_APP_KEY;
    if (!key || !app) throw new Error('Set LOJA_INTEGRADA_API_KEY and LOJA_INTEGRADA_APP_KEY for the authenticated live check');
    const headers = { Authorization: `chave_api ${key} aplicacao ${app}`, Accept: 'application/json' };
    const statuses = await liveFetch.get(`${BASE}/situacao/`, { headers, validateStatus: () => true });
    expect(statuses.status).toBe(200);
    expect(Array.isArray(statuses.data.objects)).toBe(true);
    const products = await liveFetch.get(`${BASE}/produto/`, { headers, params: { limit: 1 }, validateStatus: () => true });
    expect(products.status).toBe(200);
    expect(typeof products.data.meta.total_count).toBe('number');
    const orders = await liveFetch.get(`${BASE}/pedido/search/`, { headers, params: { limit: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.objects)).toBe(true);
  });
});
