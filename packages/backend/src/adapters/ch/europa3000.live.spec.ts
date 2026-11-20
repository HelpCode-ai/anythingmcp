import axios from 'axios';
import * as adapter from './europa3000.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * europa3000 Web API adapter (self-hosted REST API of europa3000 neo).
 *
 * Static checks always run: the base URL built from the installation's own
 * address, HTTP Basic auth, the optional E3k-Api-Key header, every tool's
 * method and path against the vendor's public OpenAPI description (Web API
 * V1.4, https://webapi.europa3000.ch, "Web API Interface Description"), the
 * filter and update bodies, and which tool installs switched off. No tool
 * creates vouchers, books payments or stock movements, or deletes.
 *
 * Live checks run only with RUN_EUROPA3000_LIVE=1. Without credentials they
 * call the vendor's public demo instance: readiness answers without a login
 * and a data call is refused with 401. With EUROPA3000_URL,
 * EUROPA3000_USERNAME and EUROPA3000_PASSWORD (and EUROPA3000_API_KEY when
 * the installation needs one) they read the active client and one article.
 * Reads only.
 *
 *   RUN_EUROPA3000_LIVE=1 EUROPA3000_URL=https://erp.example.ch/E3k.Web \
 *     EUROPA3000_USERNAME=... EUROPA3000_PASSWORD=... \
 *     npx jest src/adapters/ch/europa3000.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown> | unknown[];
    headers?: Record<string, string>;
    encodePathParams?: boolean;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
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
  return out;
};

const BASE = 'https://erp.example.ch/E3k.Web';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'ab12'.repeat(16);
const ENV: Record<string, string> = {
  EUROPA3000_URL: BASE,
  EUROPA3000_USERNAME: 'webapi',
  EUROPA3000_PASSWORD: ['test', 'only', 'password'].join('-'),
};

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as Parameters<typeof interpolateConnectorConfig>[1],
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('europa3000 adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('builds the base URL from the installation address and signs in with Basic auth', () => {
    expect(a.slug).toBe('europa3000');
    expect(a.region).toBe('ch');
    expect(a.category).toBe('erp');
    expect(a.icon).toBe('europa3000');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{EUROPA3000_URL}}/api');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{EUROPA3000_USERNAME}}', password: '{{EUROPA3000_PASSWORD}}' });
    expect(a.requiredEnvVars).toEqual(['EUROPA3000_URL', 'EUROPA3000_USERNAME', 'EUROPA3000_PASSWORD']);
    expect(a.optionalEnvVars).toEqual(['EUROPA3000_API_KEY']);
    expect(a.envVarMeta.EUROPA3000_URL.kind).toBe('address');
    expect(a.envVarMeta.EUROPA3000_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.EUROPA3000_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const url = new RegExp(a.envVarMeta.EUROPA3000_URL.pattern!);
    for (const good of [BASE, 'http://192.168.1.20/E3k.Web', 'https://webapi.example.ch/e3k.web.v14', 'https://erp.example.ch']) {
      expect(url.test(good)).toBe(true);
    }
    for (const bad of ['', 'erp.example.ch/E3k.Web', `${BASE}/`, 'https://erp example.ch']) expect(url.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.EUROPA3000_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    expect(key.test('too-short')).toBe(false);
    // The optional key never sits in a connector-level header: an empty one would be sent as text.
    expect(JSON.stringify(a.connector.headers)).not.toContain('EUROPA3000_API_KEY');
  });

  it('probes the active client and explains 401, 403, 404 and an unreachable server', () => {
    expect(a.probe.tool).toBe('europa3000_get_active_client');
    expect(tool('europa3000_get_active_client').endpointMapping).toMatchObject({ method: 'GET', path: '/Client/ActiveFull' });
    for (const key of ['401', '403', '404', 'unreachable']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^europa3000_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${param}:${typeof schema.description}`).toBe(`${entry.name}.${param}:string`);
      }
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.endpointMapping.headers).toEqual({ 'E3k-Api-Key': '${EUROPA3000_API_KEY}' });
    }
  });

  it('marks every read read-only, installs the generic table update switched off, and never deletes or books', () => {
    const writes = a.tools.filter((entry) => annotationsOf(entry).readOnlyHint !== true).map((entry) => entry.name).sort();
    expect(writes).toEqual([
      'europa3000_create_address',
      'europa3000_update_article',
      'europa3000_update_supplier_article',
      'europa3000_update_table_record',
    ]);
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name)).toEqual(['europa3000_update_table_record']);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).not.toBe('DELETE');
      expect(entry.endpointMapping.path).not.toMatch(/StockMovement|DebtorPayment|Switch|FileUpload|\/Create$|\/New$/);
    }
    const creates = a.tools.filter((entry) => entry.endpointMapping.path.endsWith('/NewObject')).map((entry) => entry.name);
    expect(creates).toEqual(['europa3000_create_address']);
    for (const name of ['europa3000_create_address', 'europa3000_update_article', 'europa3000_update_supplier_article', 'europa3000_update_table_record']) {
      expect(tool(name).description).toMatch(/wait for their yes/);
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(`\`${entry.name}\``);
    const names = new Set(a.tools.map((entry) => entry.name));
    const mentioned = [
      ...a.instructions.matchAll(/\beuropa3000_[a-z0-9_]+/g),
      ...a.tools.flatMap((entry) => [...entry.description.matchAll(/\beuropa3000_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names.has(name)).toBe(true);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads the active client with Basic auth and no API key header when none is set', async () => {
    ok();
    await call('europa3000_get_active_client', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/api/Client/ActiveFull`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.auth).toEqual({ username: ENV.EUROPA3000_USERNAME, password: ENV.EUROPA3000_PASSWORD });
    expect(header(req, 'E3k-Api-Key')).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('sends the application key as E3k-Api-Key when the installation needs one', async () => {
    ok();
    await call('europa3000_get_active_client', {}, { ...ENV, EUROPA3000_API_KEY: FAKE_KEY });
    expect(header(sent(), 'E3k-Api-Key')).toBe(FAKE_KEY);
  });

  it('lists and reads master data on the documented paths', async () => {
    ok([]);
    await call('europa3000_list_articles', {});
    expect(sent().url).toBe(`${BASE}/api/Article`);
    expect(sent().params).toEqual({ top: 50 });

    ok();
    await call('europa3000_get_article', { article_number: '200.100' });
    expect(sent().url).toBe(`${BASE}/api/Article/Key/200.100`);

    ok();
    await call('europa3000_get_article_price', { article_number: '200.100', address_number: '000001', quantity: 10 });
    expect(sent().url).toBe(`${BASE}/api/Article/CalculatedPricesOfArticle`);
    expect(sent().params).toEqual({ article: '200.100', address: '000001', voucherGrossNet: 'BaseRecord', quantity: 10 });

    ok([]);
    await call('europa3000_list_sales_statistics', { top: 100, start: 200 });
    expect(sent().url).toBe(`${BASE}/api/SalesStatistic`);
    expect(sent().params).toEqual({ top: 100, start: 200 });

    ok();
    await call('europa3000_get_address', { address_number: '000001' });
    expect(sent().url).toBe(`${BASE}/api/Address/Key/000001`);

    ok();
    await call('europa3000_get_voucher', { voucher_type: 'Invoice', voucher_number: '100234' });
    expect(sent().url).toBe(`${BASE}/api/Invoice/WithLines/Key/100234`);

    ok([]);
    await call('europa3000_list_vouchers', { voucher_type: 'Order' });
    expect(sent().url).toBe(`${BASE}/api/Order`);

    ok([]);
    await call('europa3000_list_stocks', {});
    expect(sent().url).toBe(`${BASE}/api/MultipleStock`);
  });

  it('reaches every object through the shared endpoint actions', async () => {
    ok([]);
    await call('europa3000_list_records', { endpoint: 'Debtor', top: 10 });
    expect(sent().url).toBe(`${BASE}/api/Debtor`);
    expect(sent().params).toEqual({ top: 10 });

    ok([]);
    await call('europa3000_search_records', {
      endpoint: 'Address',
      filters: [{ FieldNumber: 4, Value: 'Muster%', Type: 'Like', Combine: 'AndClampNo' }],
    });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/api/Address`);
    expect(sent().data).toEqual({ Filters: [{ FieldNumber: 4, Value: 'Muster%', Type: 'Like', Combine: 'AndClampNo' }], Sortings: [] });

    ok();
    await call('europa3000_get_record_by_key', { endpoint: 'Project', key: 'P-0001' });
    expect(sent().url).toBe(`${BASE}/api/Project/Key/P-0001`);

    ok(42);
    await call('europa3000_count_records', { endpoint: 'Article' });
    expect(sent().url).toBe(`${BASE}/api/Article/Count`);

    ok(66);
    await call('europa3000_get_endpoint_info', { endpoint: 'Article' });
    expect(sent().url).toBe(`${BASE}/api/Article/Tablenumber`);

    ok(['F004']);
    await call('europa3000_get_endpoint_info', { endpoint: 'Article', info: 'RequiredFields' });
    expect(sent().url).toBe(`${BASE}/api/Article/RequiredFields`);
  });

  it('queries and counts tables by number with the documented filter model', async () => {
    ok([]);
    await call('europa3000_query_table', { table: 66, fields: ['F001', 'F004'] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/api/Table/66/Custom`);
    expect(sent().params).toEqual({ top: 50 });
    expect(sent().data).toEqual({ Fields: ['F001', 'F004'], Filters: [], Sortings: [] });

    ok([]);
    await call('europa3000_query_table', {
      table: 66,
      fields: ['F001'],
      filters: [{ FieldNumber: 51, Value: '!', Type: 'SmallerAs', Combine: 'AndClampNo' }],
      sortings: [{ FieldNumber: 1, Descending: true }],
      top: 10,
      start: 20,
    });
    expect(sent().params).toEqual({ top: 10, start: 20 });
    expect(sent().data).toEqual({
      Fields: ['F001'],
      Filters: [{ FieldNumber: 51, Value: '!', Type: 'SmallerAs', Combine: 'AndClampNo' }],
      Sortings: [{ FieldNumber: 1, Descending: true }],
    });

    ok(1200);
    await call('europa3000_count_table_records', { table: 66 });
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().url).toBe(`${BASE}/api/Table/66/Count`);

    ok(12);
    await call('europa3000_count_table_records_filtered', { table: 66, field_number: 7, value: 'A' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/api/Table/66/Count`);
    expect(sent().data).toEqual([{ FieldNumber: 7, Value: 'A', Type: 'Equal', Combine: 'AndClampNo' }]);

    ok();
    await call('europa3000_get_table_record', { table: 65, record_id: 1 });
    expect(sent().url).toBe(`${BASE}/api/Table/65/1`);

    ok([]);
    await call('europa3000_list_table_fields', { table: 66 });
    expect(sent().url).toBe(`${BASE}/api/Field/Details/66`);

    ok([]);
    await call('europa3000_get_table_field_names', { table: 66 });
    expect(sent().url).toBe(`${BASE}/api/Field/Localization/66`);
  });

  it('builds the update and create bodies as the Web API documents them', async () => {
    ok('1');
    await call('europa3000_update_article', { values: { F001: '200.100', F002: '5901234123457' }, skip_synchronization: true });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/api/Article/Update`);
    expect(sent().params).toEqual({ skipSynchronization: true });
    expect(sent().data).toEqual({ F001: '200.100', F002: '5901234123457' });

    ok('7');
    await call('europa3000_update_supplier_article', { values: { F001: '000002', F009: '12.50' }, skip_synchronization: true });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/api/SupplierArticle/Update`);
    expect(sent().data).toEqual({ F001: '000002', F009: '12.50' });

    ok('15');
    await call('europa3000_create_address', { last_name: 'Muster', first_name: 'Hans', street: 'Musterstrasse 1', postcode: '5000', place: 'Aarau' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/api/Address/NewObject`);
    expect(sent().data).toEqual({ LastName: 'Muster', FirstName: 'Hans', Street: 'Musterstrasse 1', Postcode: '5000', Place: 'Aarau' });

    ok('3');
    await call('europa3000_update_table_record', { table: 66, values: { F001: '200.100', F004: 'Halter' } });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/api/Table/66/Update`);
    expect(sent().data).toEqual({ F001: '200.100', F004: 'Halter' });
  });
});

// Opt-in: RUN_EUROPA3000_LIVE=1. The first two checks use the vendor's public
// demo instance and need no account; the reads need your own installation.
const live = process.env.RUN_EUROPA3000_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const DEMO = 'https://webapi.europa3000.ch/E3k.Web.Demo.V14/api';
(live ? describe : describe.skip)('europa3000: live', () => {
  it('answers readiness on the public demo without a login', async () => {
    const response = await liveFetch.get(`${DEMO}/Monitoring/Readiness`, {
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
      timeout: 30000,
    });
    expect([200, 503]).toContain(response.status);
    expect(Array.isArray(response.data)).toBe(true);
  }, 40000);

  it('refuses a data call on the public demo without a login', async () => {
    const response = await liveFetch.get(`${DEMO}/Client/ActiveFull`, {
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
      timeout: 30000,
    });
    expect(response.status).toBe(401);
  }, 40000);

  const base = process.env.EUROPA3000_URL;
  const username = process.env.EUROPA3000_USERNAME;
  const password = process.env.EUROPA3000_PASSWORD;
  const real = !!base && !!username && !!password;
  (real ? it : it.skip)('reads the active client and one article', async () => {
    const options = {
      auth: { username: username!, password: password! },
      headers: {
        Accept: 'application/json',
        ...(process.env.EUROPA3000_API_KEY ? { 'E3k-Api-Key': process.env.EUROPA3000_API_KEY } : {}),
      },
      validateStatus: () => true,
      timeout: 30000,
    };
    const client = await liveFetch.get(`${base}/api/Client/ActiveFull`, options);
    expect(client.status).toBe(200);
    const articles = await liveFetch.get(`${base}/api/Article`, { ...options, params: { top: 1 } });
    expect(articles.status).toBe(200);
    expect(Array.isArray(articles.data)).toBe(true);
    const count = await liveFetch.get(`${base}/api/Table/66/Count`, options);
    expect(count.status).toBe(200);
  }, 90000);
});
