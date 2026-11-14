import axios from 'axios';
import * as adapter from './ozon.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Ozon Seller adapter:
 *
 *   1. Static: always runs. Pins the two-header auth (Api-Key plus Client-Id),
 *      every tool's method, URL and request body through the real RestEngine,
 *      the current method versions (the paths Ozon deprecated or switched off
 *      are absent), the read-only hints on POST reads, the switched-off
 *      ship, cancel and archive tools, and the response mappings against payloads
 *      shaped like the official OpenAPI schema of the Seller API.
 *
 *   2. Live: skipped unless RUN_OZON_LIVE=1.
 *      - Without credentials it calls every route with a made-up key and
 *        expects 401 "Invalid Api-Key" (Ozon answers 404 for an unknown route,
 *        so a 401 proves the route exists):
 *          RUN_OZON_LIVE=1 npx jest src/adapters/intl/ozon.live.spec.ts
 *      - With OZON_CLIENT_ID and OZON_API_KEY it runs every read tool with
 *        its minimal arguments and applies the responseMapping the way the
 *        MCP layer does. Tools gated by a subscription or a key role may
 *        answer 403 or 400; that is reported, not hidden.
 *      - Writes run only with RUN_OZON_LIVE_WRITES=1 and OZON_TEST_OFFER_ID:
 *        the price of that product is read and written back unchanged.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; minimum?: number; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown>; queryParams?: Record<string, unknown> };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  name: string;
  category: string;
  icon: string;
  region: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string; link?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string; extraHeaders: Record<string, string> };
    headers: Record<string, string>;
    healthcheckPath: string;
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

const BASE = 'https://api-seller.ozon.ru';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const connectorFor = (clientId: string, apiKey: string) => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: interpolateDeep(a.connector.authConfig, { OZON_CLIENT_ID: clientId, OZON_API_KEY: apiKey }),
  headers: a.connector.headers,
});
let creds = { clientId: '1234567', apiKey: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' };
const run = async (name: string, params: Record<string, unknown>) => {
  const { body } = await engine().executeWithMeta(
    connectorFor(creds.clientId, creds.apiKey) as never,
    tool(name).endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  );
  return body as any;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);
const runShaped = async (name: string, params: Record<string, unknown>) => {
  const out = shape(name, await run(name, params));
  expect(out.error).toBeUndefined();
  return out.value as any;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'ozon_reply_to_review',
  'ozon_answer_question',
  'ozon_update_prices',
  'ozon_update_stocks',
  'ozon_update_product_characteristics',
  'ozon_create_or_update_product_cards',
  'ozon_replace_product_images',
  'ozon_move_products_to_archive',
  'ozon_ship_fbs_posting',
  'ozon_cancel_fbs_posting',
];
const SWITCHED_OFF = ['ozon_move_products_to_archive', 'ozon_ship_fbs_posting', 'ozon_cancel_fbs_posting'];
const ATTR = { id: 85, complex_id: 0, values: [{ dictionary_value_id: 971082156, value: 'Brand' }] };

// [tool, minimal arguments, method, path]
const TABLE: Array<[string, Record<string, unknown>, string, string]> = [
  ['ozon_get_api_key_info', {}, 'POST', '/v1/roles'],
  ['ozon_get_seller_info', {}, 'POST', '/v1/seller/info'],
  ['ozon_list_promotions', {}, 'GET', '/v1/actions'],
  ['ozon_list_products', {}, 'POST', '/v3/product/list'],
  ['ozon_get_products', { offer_ids: ['SKU-1'] }, 'POST', '/v3/product/info/list'],
  ['ozon_get_stocks', {}, 'POST', '/v4/product/info/stocks'],
  ['ozon_get_fbs_warehouse_stocks', { offer_ids: ['SKU-1'] }, 'POST', '/v2/product/info/stocks-by-warehouse/fbs'],
  ['ozon_get_prices', {}, 'POST', '/v5/product/info/prices'],
  ['ozon_list_fbs_postings', { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }, 'POST', '/v4/posting/fbs/list'],
  ['ozon_get_fbs_posting', { posting_number: '89491381-0072-1' }, 'POST', '/v3/posting/fbs/get'],
  ['ozon_list_fbo_postings', { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }, 'POST', '/v3/posting/fbo/list'],
  ['ozon_list_returns', {}, 'POST', '/v1/returns/list'],
  ['ozon_get_finance_balance', { date_from: '2026-09-15', date_to: '2026-10-14' }, 'POST', '/v1/finance/balance'],
  ['ozon_list_accruals_by_day', { date: '2026-10-01' }, 'POST', '/v1/finance/accrual/by-day'],
  ['ozon_get_posting_accruals', { posting_numbers: ['89491381-0072-1'] }, 'POST', '/v1/finance/accrual/postings'],
  ['ozon_list_accrual_types', {}, 'POST', '/v1/finance/accrual/types'],
  ['ozon_get_analytics', { date_from: '2026-09-15', date_to: '2026-10-14' }, 'POST', '/v1/analytics/data'],
  ['ozon_list_warehouses', {}, 'POST', '/v2/warehouse/list'],
  ['ozon_list_reviews', {}, 'POST', '/v2/review/list'],
  ['ozon_list_questions', {}, 'POST', '/v1/question/list'],
  ['ozon_get_cancel_reasons', { posting_numbers: ['89491381-0072-1'] }, 'POST', '/v1/posting/fbs/cancel-reason'],
  ['ozon_get_product_characteristics', {}, 'POST', '/v4/product/info/attributes'],
  ['ozon_get_product_description_text', { offer_id: 'SKU-1' }, 'POST', '/v1/product/info/description'],
  ['ozon_get_product_images', { product_ids: [1] }, 'POST', '/v2/product/pictures/info'],
  ['ozon_get_product_content_rating', { skus: [9] }, 'POST', '/v1/product/rating-by-sku'],
  ['ozon_get_product_import_task', { task_id: 172549793 }, 'POST', '/v1/product/import/info'],
  ['ozon_list_category_characteristics', { description_category_id: 17028922, type_id: 91565 }, 'POST', '/v1/description-category/attribute'],
  ['ozon_list_characteristic_values', { attribute_id: 85, description_category_id: 17028922, type_id: 91565 }, 'POST', '/v1/description-category/attribute/values'],
  ['ozon_search_characteristic_values', { attribute_id: 85, description_category_id: 17028922, type_id: 91565, value: 'Ozon' }, 'POST', '/v1/description-category/attribute/values/search'],
  ['ozon_reply_to_review', { review_id: 'r1', text: 'Спасибо за отзыв!' }, 'POST', '/v1/review/comment/create'],
  ['ozon_answer_question', { question_id: 'q1', sku: 1, text: 'Да, подходит.' }, 'POST', '/v1/question/answer/create'],
  ['ozon_update_prices', { prices: [{ offer_id: 'SKU-1', price: '1490' }] }, 'POST', '/v1/product/import/prices'],
  ['ozon_update_stocks', { stocks: [{ product_id: 1, warehouse_id: 2, stock: 3 }] }, 'POST', '/v2/products/stocks'],
  ['ozon_update_product_characteristics', { items: [{ offer_id: 'SKU-1', attributes: [ATTR] }] }, 'POST', '/v1/product/attributes/update'],
  ['ozon_create_or_update_product_cards', { items: [{ offer_id: 'SKU-1', description_category_id: 17028922, type_id: 91565, price: '1490' }] }, 'POST', '/v3/product/import'],
  ['ozon_replace_product_images', { items: [{ offer_id: 'SKU-1', images: ['https://example.com/1.jpg'] }] }, 'POST', '/v2/product/pictures/import'],
  ['ozon_move_products_to_archive', { product_ids: [1] }, 'POST', '/v1/product/archive'],
  ['ozon_ship_fbs_posting', { posting_number: 'p', packages: [{ products: [{ product_id: 1, quantity: 1 }] }] }, 'POST', '/v4/posting/fbs/ship'],
  ['ozon_cancel_fbs_posting', { posting_number: 'p', cancel_reason_id: 352 }, 'POST', '/v2/posting/fbs/cancel'],
];
const READS = TABLE.filter(([n]) => !WRITES.includes(n));

describe('ozon adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('ozon');
    expect(a.name).toBe('Ozon Seller');
    expect(a.icon).toBe('ozon');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
  });

  it('authenticates with the Api-Key header plus a Client-Id header, both from variables', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Api-Key',
      apiKey: '{{OZON_API_KEY}}',
      extraHeaders: { 'Client-Id': '{{OZON_CLIENT_ID}}' },
    });
    expect(a.requiredEnvVars).toEqual(['OZON_CLIENT_ID', 'OZON_API_KEY']);
    expect(a.envVarMeta.OZON_API_KEY.secret).toBe(true);
    for (const meta of Object.values(a.envVarMeta)) expect(meta.link).toBe('https://seller.ozon.ru/app/settings/api-keys');
  });

  it('accepts real-looking credentials and refuses pasted junk', () => {
    const key = new RegExp(a.envVarMeta.OZON_API_KEY.pattern!);
    expect(key.test('0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(true);
    for (const bad of ['Api-Key: 0a1b2c3d-4e5f-6789-abcd-ef0123456789', '0a1b2c3d4e5f6789abcdef0123456789', '']) expect(key.test(bad)).toBe(false);
    const id = new RegExp(a.envVarMeta.OZON_CLIENT_ID.pattern!);
    expect(id.test('1234567')).toBe(true);
    for (const bad of ['abc', '12 34', '-5']) expect(id.test(bad)).toBe(false);
  });

  it('probes with /v1/roles (any valid key) and health-checks with a GET route', () => {
    expect(a.probe.tool).toBe('ozon_get_api_key_info');
    expect(tool('ozon_get_api_key_info').parameters.required).toBeUndefined();
    // The connection test always sends GET; every POST-only route answers 405 to it.
    expect(a.connector.healthcheckPath).toBe('/v1/actions');
    expect(tool('ozon_list_promotions').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/actions' });
  });

  it('lists every tool in the URL table', () => {
    expect(TABLE.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(TABLE)('%s sends %s %s with both auth headers', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
    expect(sent().headers['Api-Key']).toBe(creds.apiKey);
    expect(sent().headers['Client-Id']).toBe(creds.clientId);
    if (method === 'POST') expect(sent().data).toEqual(expect.any(Object));
  });

  it('uses the current method versions, not the ones Ozon deprecated or switched off', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    // Switched off: answer 404 since September 2026 (checked with a made-up key on 15 Oct 2026).
    for (const gone of ['/v3/finance/transaction/list', '/v3/finance/transaction/totals', '/v4/product/info/prices', '/v2/product/info/stocks', '/v1/product/info/stocks']) {
      expect(paths).not.toContain(gone);
    }
    // Marked deprecated in the OpenAPI schema, with these successors.
    for (const old of ['/v3/posting/fbs/list', '/v2/posting/fbo/list', '/v1/warehouse/list', '/v1/review/list', '/v1/actions/products', '/v1/actions/candidates']) {
      expect(paths).not.toContain(old);
    }
    expect(paths).toEqual(expect.arrayContaining(['/v4/posting/fbs/list', '/v3/posting/fbo/list', '/v2/warehouse/list', '/v2/review/list']));
  });

  it('every tool is prefixed, unique, described, and every declared parameter reaches the request', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name).toMatch(/^ozon_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${p}:${mapping.includes(`"$${p}"`)}`).toBe(`${t.name}:${p}:true`);
      }
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
  });

  it('POST reads are read-only; writes are not, and ask for confirmation', () => {
    for (const [name, , method] of READS) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}`).toBe(`${name}:true`);
      if (method === 'POST') expect(tool(name).annotations).toEqual({ readOnlyHint: true });
      expect(tool(name).enabled).toBeUndefined();
    }
    for (const name of WRITES) {
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    for (const name of [
      'ozon_update_prices',
      'ozon_update_stocks',
      'ozon_update_product_characteristics',
      'ozon_create_or_update_product_cards',
      'ozon_replace_product_images',
      'ozon_move_products_to_archive',
      'ozon_ship_fbs_posting',
      'ozon_cancel_fbs_posting',
    ]) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    for (const name of ['ozon_reply_to_review', 'ozon_answer_question']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
      expect(tool(name).description).toMatch(/public/);
    }
  });

  it('installs shipping, cancelling and archiving switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${SWITCHED_OFF.includes(t.name)}`);
  });

  it('reads need few arguments: small default pages and no required filters', () => {
    const minimalRequired: Record<string, string[] | undefined> = {
      ozon_list_fbs_postings: ['since', 'to'],
      ozon_get_fbs_posting: ['posting_number'],
      ozon_list_fbo_postings: ['since', 'to'],
      ozon_get_finance_balance: ['date_from', 'date_to'],
      ozon_list_accruals_by_day: ['date'],
      ozon_get_posting_accruals: ['posting_numbers'],
      ozon_get_analytics: ['date_from', 'date_to'],
      ozon_get_cancel_reasons: ['posting_numbers'],
      ozon_get_product_images: ['product_ids'],
      ozon_get_product_content_rating: ['skus'],
      ozon_get_product_import_task: ['task_id'],
      ozon_list_category_characteristics: ['description_category_id', 'type_id'],
      ozon_list_characteristic_values: ['attribute_id', 'description_category_id', 'type_id'],
      ozon_search_characteristic_values: ['attribute_id', 'description_category_id', 'type_id', 'value'],
    };
    for (const [name] of READS) expect(`${name}:${JSON.stringify(tool(name).parameters.required)}`).toBe(`${name}:${JSON.stringify(minimalRequired[name])}`);
    for (const t of a.tools) {
      const limit = t.parameters.properties?.limit;
      if (limit) expect(`${t.name}:${limit.default}`).toBe(`${t.name}:20`);
    }
  });

  it('builds the bodies Ozon expects from minimal arguments', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await run(name, params);
      return sent().data;
    };
    expect(await body('ozon_get_api_key_info', {})).toEqual({});
    expect(await body('ozon_get_seller_info', {})).toEqual({});
    expect(await body('ozon_list_products', {})).toEqual({ filter: { visibility: 'ALL' }, limit: 20 });
    expect(await body('ozon_list_products', { offer_ids: ['A', 'B'], last_id: 'x' })).toEqual({ filter: { visibility: 'ALL', offer_id: ['A', 'B'] }, last_id: 'x', limit: 20 });
    expect(await body('ozon_get_products', { skus: [1, 2] })).toEqual({ sku: [1, 2] });
    expect(await body('ozon_get_stocks', {})).toEqual({ filter: { visibility: 'ALL' }, limit: 20 });
    expect(await body('ozon_get_prices', { product_ids: [5] })).toEqual({ filter: { visibility: 'ALL', product_id: [5] }, limit: 20 });
    expect(await body('ozon_get_fbs_warehouse_stocks', { skus: [9] })).toEqual({ sku: [9], limit: 20 });
    expect(await body('ozon_list_fbs_postings', { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z', statuses: ['awaiting_packaging'] })).toEqual({
      filter: { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z', statuses: ['awaiting_packaging'] },
      sort_dir: 'DESC',
      limit: 20,
    });
    expect(await body('ozon_get_fbs_posting', { posting_number: 'p-1' })).toEqual({ posting_number: 'p-1', with: { financial_data: false, analytics_data: false } });
    expect(await body('ozon_list_fbo_postings', { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' })).toEqual({
      filter: { since: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' },
      sort_dir: 'DESC',
      limit: 20,
    });
    expect(await body('ozon_list_returns', {})).toEqual({ filter: {}, limit: 20 });
    expect(await body('ozon_list_returns', { return_schema: 'FBS', logistic_return_date: { time_from: 'a', time_to: 'b' } })).toEqual({
      filter: { return_schema: 'FBS', logistic_return_date: { time_from: 'a', time_to: 'b' } },
      limit: 20,
    });
    expect(await body('ozon_list_accruals_by_day', { date: '2026-10-01' })).toEqual({ date: '2026-10-01' });
    expect(await body('ozon_get_analytics', { date_from: '2026-09-15', date_to: '2026-10-14' })).toEqual({
      date_from: '2026-09-15',
      date_to: '2026-10-14',
      metrics: ['revenue', 'ordered_units'],
      dimension: ['day'],
      limit: 20,
    });
    expect(await body('ozon_list_warehouses', {})).toEqual({ limit: 20 });
    expect(await body('ozon_list_reviews', {})).toEqual({ filters: { status: 'ALL' }, sort_dir: 'DESC', limit: 20 });
    expect(await body('ozon_list_questions', {})).toEqual({ filter: { status: 'ALL' }, sort_dir: 'DESC', limit: 20 });
    expect(await body('ozon_get_cancel_reasons', { posting_numbers: ['p'] })).toEqual({ related_posting_numbers: ['p'] });
    expect(await body('ozon_update_stocks', { stocks: [{ product_id: 1, warehouse_id: 2, stock: 3 }] })).toEqual({ stocks: [{ product_id: 1, warehouse_id: 2, stock: 3 }] });
    expect(await body('ozon_cancel_fbs_posting', { posting_number: 'p', cancel_reason_id: 402, cancel_reason_message: 'нет в наличии' })).toEqual({
      posting_number: 'p',
      cancel_reason_id: 402,
      cancel_reason_message: 'нет в наличии',
    });
  });

  it('builds the product card bodies from the documented field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await run(name, params);
      return sent().data;
    };
    expect(await body('ozon_get_product_characteristics', {})).toEqual({ filter: { visibility: 'ALL' }, limit: 20 });
    expect(await body('ozon_get_product_characteristics', { offer_ids: ['A'], sort_by: 'offer_id', sort_dir: 'asc', last_id: 'x' })).toEqual({
      filter: { offer_id: ['A'], visibility: 'ALL' },
      sort_by: 'offer_id',
      sort_dir: 'asc',
      last_id: 'x',
      limit: 20,
    });
    expect(await body('ozon_get_product_description_text', { product_id: 5 })).toEqual({ product_id: 5 });
    expect(await body('ozon_get_product_images', { product_ids: [5, 6] })).toEqual({ product_id: [5, 6] });
    expect(await body('ozon_get_product_content_rating', { skus: [9] })).toEqual({ skus: [9] });
    expect(await body('ozon_get_product_import_task', { task_id: 7 })).toEqual({ task_id: 7 });
    expect(await body('ozon_list_category_characteristics', { description_category_id: 1, type_id: 2, language: 'EN' })).toEqual({ description_category_id: 1, type_id: 2, language: 'EN' });
    expect(await body('ozon_list_characteristic_values', { attribute_id: 85, description_category_id: 1, type_id: 2, last_value_id: 40 })).toEqual({
      attribute_id: 85,
      description_category_id: 1,
      type_id: 2,
      last_value_id: 40,
      limit: 20,
    });
    expect(await body('ozon_search_characteristic_values', { attribute_id: 85, description_category_id: 1, type_id: 2, value: 'Ozon' })).toEqual({
      attribute_id: 85,
      description_category_id: 1,
      type_id: 2,
      value: 'Ozon',
      limit: 20,
    });
    expect(await body('ozon_update_product_characteristics', { items: [{ offer_id: 'A', attributes: [ATTR] }] })).toEqual({ items: [{ offer_id: 'A', attributes: [ATTR] }] });
    const card = { offer_id: 'A', name: 'Кружка', description_category_id: 1, type_id: 2, price: '990', vat: '0.2', images: ['https://example.com/1.jpg'], attributes: [ATTR] };
    expect(await body('ozon_create_or_update_product_cards', { items: [card] })).toEqual({ items: [card] });
    expect(await body('ozon_replace_product_images', { items: [{ offer_id: 'A', images: ['https://example.com/1.jpg'], color_image: 'https://example.com/c.jpg' }] })).toEqual({
      items: [{ offer_id: 'A', images: ['https://example.com/1.jpg'], color_image: 'https://example.com/c.jpg' }],
    });
    expect(await body('ozon_move_products_to_archive', { product_ids: [1, 2] })).toEqual({ product_id: [1, 2] });
  });

  it('shapes characteristics, import tasks, content rating and dictionaries', () => {
    const attrs = shape('ozon_get_product_characteristics', {
      result: [
        {
          id: 1, offer_id: 'A', sku: '9', name: 'Кружка', barcode: '460', barcodes: ['460'], description_category_id: 17028922, type_id: 91565, depth: 100, width: 80, height: 50, dimension_unit: 'mm', weight: 300, weight_unit: 'g',
          primary_image: 'https://cdn/0.jpg', images: [{ default: true, file_name: 'https://cdn/1.jpg', index: 0 }], color_image: '', model_info: { model_id: 3, count: 1 },
          attributes: [{ id: 85, complex_id: 0, values: [{ dictionary_value_id: 971082156, value: 'Brand' }] }], complex_attributes: [], attributes_with_defaults: [], pdf_list: [],
        },
      ],
      total: 1, last_id: 'WzFd',
    }).value as any;
    expect(attrs.items[0]).toMatchObject({ product_id: 1, offer_id: 'A', description_category_id: 17028922, type_id: 91565, images: ['https://cdn/1.jpg'] });
    expect(attrs.items[0].attributes).toEqual([{ id: 85, complex_id: 0, values: [{ dictionary_value_id: 971082156, value: 'Brand' }] }]);
    expect(attrs).toMatchObject({ total: 1, last_id: 'WzFd' });

    const task = shape('ozon_get_product_import_task', {
      result: { items: [{ offer_id: 'A', product_id: 1, status: 'failed', errors: [{ code: 'E', state: 's', level: 'error', description: 'Заполните бренд', field: 'attributes', attribute_id: 85, attribute_name: 'Бренд', optional_description_elements: {}, message: 'brand is required' }] }], total: 1 },
    }).value as any;
    expect(task.items[0]).toEqual({ offer_id: 'A', product_id: 1, status: 'failed', errors: [{ code: 'E', level: 'error', field: 'attributes', attribute_id: 85, attribute_name: 'Бренд', description: 'Заполните бренд', message: 'brand is required' }] });

    const rating = shape('ozon_get_product_content_rating', {
      products: [{ sku: 9, rating: 72.5, groups: [{ key: 'media', name: 'Медиа', rating: 50, weight: 25, improve_at_least: 2, improve_attributes: [{ id: 4180, name: 'Видео' }], conditions: [{ key: 'c', description: 'Добавьте видео', fulfilled: false, cost: 10 }] }] }],
    }).value as any;
    expect(rating.products[0].groups[0]).toMatchObject({ key: 'media', improve_attributes: [{ id: 4180, name: 'Видео' }] });

    const chars = shape('ozon_list_category_characteristics', {
      result: [{ id: 85, name: 'Бренд', description: 'long text', type: 'String', is_required: true, is_collection: false, max_value_count: 1, dictionary_id: 28732849, category_dependent: false, group_id: 0, group_name: '', attribute_complex_id: 0, is_aspect: false, complex_is_collection: false }],
    }).value as any;
    expect(chars.characteristics[0]).toEqual({ id: 85, name: 'Бренд', type: 'String', is_required: true, is_collection: false, max_value_count: 1, dictionary_id: 28732849, category_dependent: false, group_name: '', attribute_complex_id: 0, is_aspect: false });

    expect(shape('ozon_list_characteristic_values', { result: [{ id: 1, value: 'Ozon', info: '', picture: 'https://cdn/p.png' }], has_next: true }).value).toEqual({ values: [{ id: 1, value: 'Ozon', info: '' }], has_next: true });
    expect(shape('ozon_search_characteristic_values', { result: [{ id: 1, value: 'Ozon', info: '', picture: '' }] }).value).toEqual({ values: [{ id: 1, value: 'Ozon', info: '' }] });
    expect(shape('ozon_get_product_description_text', { result: { id: 1, offer_id: 'A', name: 'Кружка', description: 'Описание' } }).value).toEqual({ product_id: 1, offer_id: 'A', name: 'Кружка', description: 'Описание' });
    expect(shape('ozon_create_or_update_product_cards', { result: { task_id: 172549793 } }).value).toEqual({ task_id: 172549793 });
    expect(shape('ozon_update_product_characteristics', { task_id: 5 }).value).toEqual({ task_id: 5 });
    expect(shape('ozon_replace_product_images', { task_id: 6 }).value).toEqual({ task_id: 6 });
  });

  it('every tool has a valid responseMapping that selects', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && tr.select)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${validateTransform(tr)}`).toBe(`${t.name}:null`);
    }
  });

  // Payloads shaped like the official OpenAPI schema (docs.ozon.ru/api/seller), trimmed.
  it('shapes products, stock and prices to the useful fields', () => {
    expect(
      shape('ozon_list_products', {
        result: { items: [{ product_id: 1, offer_id: 'A', archived: false, has_fbo_stocks: true, has_fbs_stocks: false, is_discounted: false, quants: [{ quant_code: 'q', quant_size: 1 }] }], total: 1, total_items: 1, last_id: 'bnVs' },
      }).value,
    ).toEqual({ items: [{ product_id: 1, offer_id: 'A', archived: false, has_fbo_stocks: true, has_fbs_stocks: false, is_discounted: false }], total_items: 1, last_id: 'bnVs' });

    const info = shape('ozon_get_products', {
      items: [
        {
          id: 1, offer_id: 'A', sku: 9, name: 'Кружка', barcodes: ['460'], price: '990.00', old_price: '1290.00', min_price: '900.00', currency_code: 'RUB', vat: '0.2',
          statuses: { status: 'price_sent', status_name: 'Продается', moderate_status: 'approved', status_description: '', is_created: true },
          stocks: { has_stock: true, stocks: [{ present: 3, reserved: 1, sku: 9, source: 'fbs' }] }, visibility_details: { has_price: true, has_stock: true },
          images: ['https://cdn/1.jpg'], commissions: [{ percent: 15 }], price_indexes: { color_index: 'GREEN' }, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
          errors: [{ code: 'E1', level: 'ERROR_LEVEL_WARNING', field: 'name', attribute_id: 4, texts: { short_description: 'Слишком длинное название', description: 'long text' } }],
        },
      ],
    }).value as any;
    expect(info.items[0]).toMatchObject({ product_id: 1, offer_id: 'A', sku: 9, name: 'Кружка', price: '990.00', status_name: 'Продается', has_stock: true });
    expect(info.items[0].errors).toEqual([{ code: 'E1', level: 'ERROR_LEVEL_WARNING', field: 'name', message: 'Слишком длинное название' }]);
    expect(info.items[0].images).toBeUndefined();
    expect(info.items[0].commissions).toBeUndefined();

    const prices = shape('ozon_get_prices', {
      items: [{ offer_id: 'A', product_id: 1, price: { price: 990, old_price: 1290, currency_code: 'RUB' }, price_indexes: { color_index: 'GREEN', ozon_index_data: {} }, commissions: { sales_percent_fbs: 15 }, marketing_actions: { actions: [{ title: 'x' }] }, acquiring: 1.5 }],
      cursor: 'c', total: 1, total_items: 1,
    }).value as any;
    expect(prices).toEqual({ items: [{ offer_id: 'A', product_id: 1, price: 990, old_price: 1290, currency: 'RUB', price_index: 'GREEN', commission_percent_fbs: 15 }], total_items: 1, cursor: 'c' });
  });

  it('shapes postings without buyer contact data', () => {
    const fbs = shape('ozon_list_fbs_postings', {
      postings: [
        {
          posting_number: '1-1-1', order_id: 1, order_number: '1-1', status: 'awaiting_packaging', substatus: 'posting_created', in_process_at: '2026-10-14T10:00:00Z', shipment_date: '2026-10-16T10:00:00Z',
          delivery_method: { id: 5, name: 'Ozon Логистика', warehouse_id: 7, warehouse: 'Мой склад', tpl_provider: 'Ozon' }, tracking_number: '', cancellation: { cancel_reason: '' },
          customer: { name: 'Иван', phone: '+7900', address: { address_tail: 'ул. Ленина' } }, addressee: { name: 'Иван', phone: '+7900' },
          products: [{ sku: 9, offer_id: 'A', name: 'Кружка', quantity: 2, price: { amount: '990', currency: 'RUB' }, imei: [] }],
        },
      ],
      has_next: false, cursor: '',
    }).value as any;
    expect(fbs.postings[0]).toEqual({
      posting_number: '1-1-1', order_number: '1-1', status: 'awaiting_packaging', substatus: 'posting_created', in_process_at: '2026-10-14T10:00:00Z', shipment_date: '2026-10-16T10:00:00Z', warehouse_id: 7,
      products: [{ offer_id: 'A', name: 'Кружка', quantity: 2, price: { amount: '990', currency: 'RUB' } }],
    });
    expect(JSON.stringify(fbs)).not.toMatch(/\+7900|Иван|Ленина/);

    const one = shape('ozon_get_fbs_posting', { result: { posting_number: '1-1-1', status: 'delivering', customer: { phone: '+7900' }, addressee: { phone: '+7900' }, products: [{ sku: 9, name: 'Кружка', quantity: 1, price: '990', currency_code: 'RUB', dimensions: {} }] } }).value as any;
    expect(one).toEqual({ posting_number: '1-1-1', status: 'delivering', products: [{ sku: 9, name: 'Кружка', quantity: 1, price: '990', currency_code: 'RUB' }] });
  });

  it('shapes returns, roles, seller info and questions', () => {
    const r = shape('ozon_list_returns', {
      returns: [{ id: 11, schema: 'FBS', type: 'ClientReturn', posting_number: 'p', return_reason_name: 'Брак', product: { sku: 9, offer_id: 'A', name: 'Кружка', quantity: 1, price: { price: 990, currency_code: 'RUB' } }, visual: { status: { display_name: 'В пути', sys_name: 'MovingToSeller' }, change_moment: 't' }, logistic: { return_date: 'd', barcode: 'b' }, exemplars: [{ id: 1 }] }],
      has_next: true,
    }).value as any;
    expect(r.returns[0]).toEqual({ id: 11, schema: 'FBS', posting_number: 'p', offer_id: 'A', name: 'Кружка', quantity: 1, price: 990, reason: 'Брак', status: 'В пути', return_date: 'd' });
    expect(r.has_next).toBe(true);
    expect(shape('ozon_get_api_key_info', { expires_at: '2026-12-31T00:00:00Z', roles: [{ name: 'Admin', methods: ['/v1/roles', '/v3/product/list'] }] }).value).toEqual({ expires_at: '2026-12-31T00:00:00Z', roles: ['Admin'] });
    const s = shape('ozon_get_seller_info', { company: { name: 'Shop', inn: '77', currency: 'RUB' }, subscription: { is_premium: false, type: 'UNSPECIFIED' }, ratings: [{ rating: 'rating_on_time', name: 'Вовремя', status: 'OK', current_value: { formatted: '98%', status: { danger: false, warning: false } }, past_value: {} }] }).value as any;
    expect(s.ratings).toEqual([{ rating: 'rating_on_time', name: 'Вовремя', status: 'OK', value: '98%', danger: false, warning: false }]);
    const q = shape('ozon_list_questions', { questions: [{ id: 'q', sku: 9, text: 'Подходит?', status: 'NEW', author_name: 'Анна', answers_count: 0 }], has_next: false, last_id: 'q' }).value as any;
    expect(q.questions[0]).toEqual({ id: 'q', sku: 9, text: 'Подходит?', status: 'NEW', answers_count: 0 });
  });

  it('needs offer_ids or skus for the FBS warehouse stocks, and says so', () => {
    const t = tool('ozon_get_fbs_warehouse_stocks');
    expect(t.description).toMatch(/at least one of offer_ids or skus/);
    expect(a.instructions).toMatch(/`ozon_get_fbs_warehouse_stocks` needs `offer_ids` or `skus`/);
    // Our tool schemas carry no top-level anyOf, so the rule lives in the text.
    expect(t.parameters.required).toBeUndefined();
  });

  // A default page of every list tool, built from payloads with the full field
  // set of the OpenAPI schema (the 15 Oct real-key check measured 9 to 46 KB before this).
  it('keeps a default page of every list tool under 10 KB', () => {
    const name80 = 'Кружка керамическая с крышкой и ложкой, 350 мл, белая, для чая и кофе';
    const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    const pages: Record<string, unknown> = {
      ozon_list_fbs_postings: {
        postings: n(20, (i) => ({
          posting_number: `8949138${i}-0072-1`, order_id: 100000000 + i, order_number: `8949138${i}-0072`, status: 'awaiting_packaging', substatus: 'posting_created',
          in_process_at: '2026-10-14T10:00:00Z', shipment_date: '2026-10-16T10:00:00Z', delivering_date: null, tracking_number: '', available_actions: ['ship', 'cancel', 'arbitration', 'delivered'],
          delivery_method: { id: 1, name: 'Ozon Логистика курьеру, Москва', warehouse_id: 22142605386000, warehouse: 'Основной склад', tpl_provider: 'Ozon Логистика', tpl_provider_id: 24 },
          analytics_data: { region: 'Москва', city: 'Москва', delivery_type: 'PVZ', is_premium: false, payment_type_group_name: 'картой онлайн', warehouse_id: 1, warehouse: 'Основной склад', tpl_provider: 'Ozon', delivery_date_begin: '2026-10-17T00:00:00Z', delivery_date_end: '2026-10-18T00:00:00Z', is_legal: false },
          financial_data: { cluster_from: 'Москва', cluster_to: 'Москва', products: [{ commission_amount: 148.5, commission_percent: 15, payout: 841.5, product_id: 1, old_price: 1290, price: 990, total_discount_value: 300, total_discount_percent: 23.26, actions: ['Скидка'], currency_code: 'RUB' }] },
          cancellation: { cancel_reason_id: 0, cancel_reason: '', cancellation_type: '', cancelled_after_ship: false, affect_cancellation_rating: false, cancellation_initiator: '' },
          barcodes: { upper_barcode: '%101%123456789', lower_barcode: '12345678901234' }, requirements: { products_requiring_gtd: [], products_requiring_country: [], products_requiring_mandatory_mark: [], products_requiring_rnpt: [] },
          products: [{ sku: 987654321, offer_id: `SKU-${i}`, name: name80, quantity: 1, price: { amount: '990.0000', currency: 'RUB' }, imei: [], is_marketplace_buyout: false }],
          tariffication: [{ current_tariff_rate: 0, current_tariff_type: '', current_tariff_charge: '0', next_tariff_rate: 0 }],
        })),
        has_next: true, cursor: 'eyJsYXN0X2lkIjoxMjM0NTY3ODl9',
      },
      ozon_get_prices: {
        items: n(20, (i) => ({
          offer_id: `SKU-${i}`, product_id: 100000000 + i, acquiring: 1.5, volume_weight: 0.4,
          price: { price: 990, old_price: 1290, min_price: 900, marketing_seller_price: 950, net_price: 400, retail_price: 0, vat: 0.2, currency_code: 'RUB', auto_action_enabled: true, auto_add_to_ozon_actions_list_enabled: false },
          price_indexes: { color_index: 'GREEN', external_index_data: { minimal_price: '980', minimal_price_currency: 'RUB', price_index_value: 1.01 }, ozon_index_data: { minimal_price: '970', minimal_price_currency: 'RUB', price_index_value: 1.02 }, self_marketplaces_index_data: { minimal_price: '990', minimal_price_currency: 'RUB', price_index_value: 1 } },
          commissions: { fbo_deliv_to_customer_amount: 25, fbo_direct_flow_trans_max_amount: 50, fbo_direct_flow_trans_min_amount: 20, fbo_return_flow_amount: 30, fbs_deliv_to_customer_amount: 25, fbs_direct_flow_trans_max_amount: 70, fbs_direct_flow_trans_min_amount: 40, fbs_first_mile_max_amount: 25, fbs_first_mile_min_amount: 0, fbs_return_flow_amount: 30, sales_percent_fbo: 15, sales_percent_fbp: 15, sales_percent_fbs: 16, sales_percent_rfbs: 16 },
          marketing_actions: { current_period_from: '2026-10-01T00:00:00Z', current_period_to: '2026-10-31T00:00:00Z', ozon_actions_exist: true, actions: [{ date_from: '2026-10-01T00:00:00Z', date_to: '2026-10-31T00:00:00Z', title: 'Распродажа осени', value: 10 }] },
        })),
        cursor: 'eyJsYXN0X2lkIjoxMjM0NTY3ODl9', total: 300, total_items: 300,
      },
      ozon_list_returns: {
        returns: n(20, (i) => ({
          id: 1000 + i, company_id: 1, schema: 'FBS', type: 'ClientReturn', order_id: 1, order_number: '89491381-0072', posting_number: '89491381-0072-1', clearing_id: 1, return_clearing_id: 2, source_id: 3,
          return_reason_name: 'Товар не соответствует описанию', exemplars: [{ id: 1 }], additional_info: { is_opened: true, is_super_econom: false },
          product: { sku: 987654321, offer_id: `SKU-${i}`, name: name80, quantity: 1, price: { price: 990, currency_code: 'RUB' }, price_without_commission: { price: 841.5, currency_code: 'RUB' }, commission_percent: 15, commission: { price: 148.5, currency_code: 'RUB' } },
          visual: { status: { id: 3, display_name: 'Готов к выдаче', sys_name: 'ArrivedAtReturnPlace' }, change_moment: '2026-10-10T10:00:00Z' },
          logistic: { return_date: '2026-10-05T10:00:00Z', final_moment: null, technical_return_moment: null, cancelled_with_compensation_moment: null, barcode: 'ii1234567' },
          place: { id: 1, name: 'ПВЗ Москва, Тверская 1', address: 'Москва, Тверская 1' }, target_place: { id: 2, name: 'Склад продавца', address: 'Москва, Складская 5' },
          storage: { sum: { price: 0, currency_code: 'RUB' }, days: 2, arrived_moment: '2026-10-10T10:00:00Z', tariffication_first_date: '2026-10-15T00:00:00Z', tariffication_start_date: '2026-10-15T00:00:00Z', utilization_forecast_date: '2026-11-10', utilization_sum: { price: 0, currency_code: 'RUB' } },
          compensation_status: { status: { id: 0, display_name: '', sys_name: '' }, change_moment: null },
        })),
        has_next: true,
      },
      ozon_list_warehouses: {
        warehouses: n(20, (i) => ({
          warehouse_id: 22142605386000 + i, name: `Склад продавца №${i}, Москва`, status: 'created', warehouse_type: 'FBS', is_rfbs: false, is_kgt: false, is_express: false, is_comfort: false, is_auto_assembly: false,
          address_info: { address: 'Москва, ул. Складская, д. 5, стр. 2', latitude: 55.7, longitude: 37.6, utc: '+03:00' }, first_mile: { type: 'DROP_OFF', dropoff_point_id: '123', timeslot_id: 1, timeslot_from: '10:00', timeslot_to: '12:00', first_mile_is_changing: false },
          working_days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], timetable: { timetable_from: '2026-01-01T00:00:00Z', timetable_to: '2027-01-01T00:00:00Z', working_hours: n(7, () => ({ time_from: '09:00', time_to: '18:00' })) },
          courier_phones: ['+79000000000'], phone: '+79000000000', courier_comment: 'Вход со двора', postings_limit: -1, min_postings_limit: 0, has_postings_limit: false, sla_cut_in: 60, cut_in_time: 120, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
        })),
        has_next: false, cursor: '',
      },
      ozon_list_promotions: {
        result: n(30, (i) => ({ id: 1000 + i, title: 'Осенняя распродажа: скидки до 50% на товары для дома', action_type: 'DISCOUNT', description: '<p>Длинное описание акции с условиями участия и требованиями к ценам.</p>', date_start: '2026-10-01T00:00:00Z', date_end: '2026-10-31T00:00:00Z', freeze_date: '', potential_products_count: 120, participating_products_count: 30, is_participating: true, is_voucher_action: false, banned_products_count: 0, with_targeting: false, order_amount: 0, discount_type: 'PERCENT', discount_value: 20, auto_add_dates: [] })),
      },
      ozon_list_accrual_types: { accrual_types: n(100, (i) => ({ id: i, name: 'Логистика до покупателя', description: 'Стоимость доставки товара от склада до покупателя, включая обработку и сортировку отправления.' })) },
      ozon_get_api_key_info: { expires_at: '2026-12-31T00:00:00Z', roles: n(12, (i) => ({ name: `Role ${i}`, methods: n(40, (j) => `/v${(j % 5) + 1}/some/method/path/${j}`) })) },
      ozon_get_stocks: { items: n(20, (i) => ({ offer_id: `SKU-${i}`, product_id: i, stocks: [{ type: 'fbo', present: 10, reserved: 1, sku: 1, warehouse_ids: [1, 2, 3], shipment_type: 'SHIPMENT_TYPE_GENERAL' }, { type: 'fbs', present: 3, reserved: 0, sku: 1, warehouse_ids: [4], shipment_type: 'SHIPMENT_TYPE_GENERAL' }] })), cursor: 'c', total_items: 300 },
      ozon_list_products: { result: { items: n(20, (i) => ({ product_id: i, offer_id: `SKU-${i}`, archived: false, has_fbo_stocks: true, has_fbs_stocks: true, is_discounted: false, quants: [] })), total_items: 300, last_id: 'x' } },
    };
    for (const [name, raw] of Object.entries(pages)) {
      const out = shape(name, raw);
      expect(`${name}:${out.error}:${out.truncated}`).toBe(`${name}:undefined:false`);
      const bytes = Buffer.byteLength(JSON.stringify(out.value), 'utf8');
      if (process.env.OZON_PRINT_SIZES === '1') console.log(`${name}: ${bytes} bytes (raw ${Buffer.byteLength(JSON.stringify(raw), 'utf8')})`);
      expect(`${name}:${bytes < 10_000}`).toBe(`${name}:true`);
    }
  });

  it('only points the model at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bozon_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bozon_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Ozon Seller\n')).toBe(true);
    expect(a.instructions).toContain('**Out of scope**');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_OZON_LIVE === '1' ? describe : describe.skip;
const HAVE_CREDS = Boolean(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);
const liveCreds = process.env.RUN_OZON_LIVE === '1' && HAVE_CREDS ? describe : describe.skip;
const liveWrites =
  process.env.RUN_OZON_LIVE === '1' && process.env.RUN_OZON_LIVE_WRITES === '1' && HAVE_CREDS && process.env.OZON_TEST_OFFER_ID ? describe : describe.skip;

live('ozon adapter: live routes with a made-up key', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it.each(TABLE)('%s: the route exists (401 Invalid Api-Key, not 404)', async (name, params) => {
    const saved = creds;
    creds = { clientId: '1234567', apiKey: '00000000-0000-0000-0000-000000000000' };
    try {
      await expect(run(name, params)).rejects.toMatchObject({ response: { status: 401, data: { code: 16 } } });
    } finally {
      creds = saved;
    }
  }, 30_000);
});

liveCreds('ozon adapter: live read tools with a seller key', () => {
  const GATED = new Set(['ozon_list_reviews', 'ozon_list_questions', 'ozon_get_analytics', 'ozon_list_promotions']);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  beforeAll(() => {
    creds = { clientId: process.env.OZON_CLIENT_ID!, apiKey: process.env.OZON_API_KEY! };
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const tryRead = async (name: string, params: Record<string, unknown>) => {
    try {
      const out = await runShaped(name, params);
      console.log(`${name}: ${Buffer.byteLength(JSON.stringify(out), 'utf8')} bytes shaped`);
      return out;
    } catch (e: any) {
      const status = e?.response?.status;
      if (GATED.has(name) && (status === 403 || status === 400)) {
        console.warn(`${name}: ${status} ${JSON.stringify(e.response.data)} (subscription or role)`);
        return null;
      }
      throw new Error(`${name}: ${status} ${JSON.stringify(e?.response?.data ?? e?.message)}`);
    }
  };

  it('reads the key, the seller and the catalogue', async () => {
    const key = await tryRead('ozon_get_api_key_info', {});
    expect(Array.isArray(key.roles)).toBe(true);
    const seller = await tryRead('ozon_get_seller_info', {});
    expect(typeof seller.company.name).toBe('string');
    const list = await tryRead('ozon_list_products', {});
    expect(Array.isArray(list.items)).toBe(true);
    expect(list.items.length).toBeLessThanOrEqual(20);
    if (list.items.length) {
      const details = await tryRead('ozon_get_products', { product_ids: [list.items[0].product_id] });
      expect(details.items[0].product_id).toBe(list.items[0].product_id);
    }
    if (list.items.length) {
      const card = await tryRead('ozon_get_product_characteristics', { product_ids: [list.items[0].product_id] });
      expect(card.items[0].product_id).toBe(list.items[0].product_id);
      const text = await tryRead('ozon_get_product_description_text', { product_id: list.items[0].product_id });
      expect(text.product_id).toBe(list.items[0].product_id);
      const images = await tryRead('ozon_get_product_images', { product_ids: [list.items[0].product_id] });
      expect(Array.isArray(images.items)).toBe(true);
      const chars = await tryRead('ozon_list_category_characteristics', { description_category_id: card.items[0].description_category_id, type_id: card.items[0].type_id });
      expect(Array.isArray(chars.characteristics)).toBe(true);
      const dict = chars.characteristics.find((c: any) => c.dictionary_id > 0);
      if (dict) {
        const vals = await tryRead('ozon_list_characteristic_values', { attribute_id: dict.id, description_category_id: card.items[0].description_category_id, type_id: card.items[0].type_id });
        expect(Array.isArray(vals.values)).toBe(true);
      }
      if (card.items[0].sku) {
        const rating = await tryRead('ozon_get_product_content_rating', { skus: [Number(card.items[0].sku)] });
        expect(Array.isArray(rating.products)).toBe(true);
      }
    }
    if (list.items.length) {
      const stocks = await tryRead('ozon_get_fbs_warehouse_stocks', { offer_ids: [list.items[0].offer_id] });
      expect(Array.isArray(stocks.products ?? [])).toBe(true);
    }
    for (const name of ['ozon_get_stocks', 'ozon_get_prices', 'ozon_list_warehouses', 'ozon_list_accrual_types', 'ozon_list_promotions', 'ozon_list_returns']) {
      const out = await tryRead(name, {});
      if (out) expect(typeof out).toBe('object');
    }
  }, 120_000);

  it('reads postings, returns and finance with minimal arguments', async () => {
    const fbs = await tryRead('ozon_list_fbs_postings', { since: `${day(-30)}T00:00:00Z`, to: `${day(1)}T00:00:00Z` });
    expect(Array.isArray(fbs.postings)).toBe(true);
    if (fbs.postings.length) {
      const one = await tryRead('ozon_get_fbs_posting', { posting_number: fbs.postings[0].posting_number });
      expect(one.posting_number).toBe(fbs.postings[0].posting_number);
      const acc = await tryRead('ozon_get_posting_accruals', { posting_numbers: [fbs.postings[0].posting_number] });
      expect(typeof acc).toBe('object');
    }
    const fbo = await tryRead('ozon_list_fbo_postings', { since: `${day(-30)}T00:00:00Z`, to: `${day(1)}T00:00:00Z` });
    expect(Array.isArray(fbo.postings ?? [])).toBe(true);
    const returns = await tryRead('ozon_list_returns', {});
    expect(Array.isArray(returns.returns ?? [])).toBe(true);
    const balance = await tryRead('ozon_get_finance_balance', { date_from: day(-29), date_to: day(-1) });
    expect(typeof balance).toBe('object');
    const accruals = await tryRead('ozon_list_accruals_by_day', { date: day(-2) });
    expect(typeof accruals).toBe('object');
  }, 120_000);

  it('reads analytics, reviews and questions, or reports the subscription they need', async () => {
    await tryRead('ozon_get_analytics', { date_from: day(-14), date_to: day(-1) });
    await tryRead('ozon_list_reviews', {});
    await tryRead('ozon_list_questions', {});
  }, 120_000);
});

liveWrites('ozon adapter: live write (price written back unchanged)', () => {
  beforeAll(() => {
    creds = { clientId: process.env.OZON_CLIENT_ID!, apiKey: process.env.OZON_API_KEY! };
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('rewrites the current price of OZON_TEST_OFFER_ID', async () => {
    const offer = process.env.OZON_TEST_OFFER_ID!;
    const before = await runShaped('ozon_get_prices', { offer_ids: [offer] });
    const p = before.items[0].price;
    const out = await runShaped('ozon_update_prices', { prices: [{ offer_id: offer, price: String(p.price), old_price: String(p.old_price ?? 0) }] });
    expect(out.result[0]).toMatchObject({ offer_id: offer, updated: true });
  }, 60_000);
});
