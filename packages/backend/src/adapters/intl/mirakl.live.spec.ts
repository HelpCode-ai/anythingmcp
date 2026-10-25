import axios from 'axios';
import FormData from 'form-data';
import * as adapter from './mirakl.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { fetchOutbound } from '../../common/outbound-fetch.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Mirakl Seller API adapter:
 *
 *   1. Static: always runs. Pins the raw shop key in the Authorization
 *      header, the operator host from MIRAKL_URL with /api added, the
 *      optional shop_id on every call, every tool's method and URL (each
 *      checked against Mirakl's published seller OpenAPI, operation codes
 *      in the table), the JSON and multipart bodies, and which tools write.
 *
 *   2. Live: skipped unless MIRAKL_URL and MIRAKL_API_KEY are set. Reads
 *      only: the shop, orders, offers, imports, threads, returns, reasons,
 *      carriers and the other reference lists, invoices and transactions.
 *
 *        MIRAKL_URL=https://<operator>.mirakl.net MIRAKL_API_KEY=... \
 *          npx jest src/adapters/intl/mirakl.live.spec.ts
 *
 *      MIRAKL_SHOP_ID selects one shop when the key has several. Nothing
 *      here writes to a marketplace: accepting, shipping and offer updates
 *      act on real customer orders and live listings.
 */

jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(),
}));
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
const mockedFetchOutbound = fetchOutbound as jest.MockedFunction<typeof fetchOutbound>;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
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
const KEY = ['1b2c3d4e', '5f60', '7182', '93a4', 'b5c6d7e8f901'].join('-');
const HOST = 'https://adeo-marketplace.mirakl.net';
const ENV = { MIRAKL_URL: HOST, MIRAKL_API_KEY: KEY };
const BASE = `${HOST}/api`;
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
// The multipart body as text, to read the parts back.
const formText = (form: FormData) => form.getBuffer().toString('utf8');
const formPart = (form: FormData, name: string) => {
  const m = new RegExp(`name="${name}"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(formText(form));
  return m ? m[1] : undefined;
};

const WRITES = [
  'mirakl_accept_order',
  'mirakl_accept_return',
  'mirakl_create_order_thread',
  'mirakl_import_offers',
  'mirakl_import_products',
  'mirakl_receive_return',
  'mirakl_reply_thread',
  'mirakl_resolve_incident',
  'mirakl_ship_order',
  'mirakl_update_offers',
  'mirakl_update_tracking',
];

describe('mirakl adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedFetchOutbound.mockReset();
  });

  it('is listed (verified against the official seller OpenAPI and customer traffic on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('says that one install covers one marketplace', () => {
    expect(a.name).toBe('Mirakl Seller API');
    expect(a.instructions).toMatch(/one install covers one marketplace/i);
    expect(a.instructions).toMatch(/install the connector once per marketplace/i);
    expect(a.prerequisites).toMatch(/One install per marketplace/);
  });

  it('sends the raw shop key in the Authorization header, never Bearer and never in the URL', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{MIRAKL_API_KEY}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mirakl_get_account', {});
    expect(sent().headers.Authorization).toBe(KEY);
    expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY);
    expect(sent().url).not.toContain(KEY);
  });

  it('builds the base URL from the operator host and adds /api', async () => {
    expect(a.connector.baseUrl).toBe('{{MIRAKL_URL}}/api');
    const host = new RegExp(a.envVarMeta.MIRAKL_URL.pattern!);
    for (const ok of [HOST, 'https://conforama-prod.mirakl.net', 'https://marketplace.eprice.it']) expect(host.test(ok)).toBe(true);
    for (const bad of [`${HOST}/`, `${HOST}/api`, 'http://adeo-marketplace.mirakl.net', 'adeo-marketplace.mirakl.net', 'https://localhost']) {
      expect(host.test(bad)).toBe(false);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('mirakl_list_orders', { ...ENV, MIRAKL_URL: 'https://marketplace.eprice.it' }, {});
    expect(sent().url).toBe('https://marketplace.eprice.it/api/orders');
  });

  it('checks the key and shop id and keeps the key secret', () => {
    expect(a.requiredEnvVars).toEqual(['MIRAKL_URL', 'MIRAKL_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['MIRAKL_SHOP_ID']);
    const key = new RegExp(a.envVarMeta.MIRAKL_API_KEY.pattern!);
    expect(key.test(KEY)).toBe(true);
    expect(key.test(`Bearer ${KEY}`)).toBe(false);
    expect(key.test(`"${KEY}"`)).toBe(false);
    expect(new RegExp(a.envVarMeta.MIRAKL_SHOP_ID.pattern!).test('2001')).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'MIRAKL_API_KEY')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'MIRAKL_URL')!.kind).toBe('address');
  });

  it('sends shop_id on every call when MIRAKL_SHOP_ID is set, and leaves it out otherwise', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    for (const t of a.tools) expect(`${t.name}:${JSON.stringify(t.endpointMapping.queryParams?.shop_id)}`).toBe(`${t.name}:"\${MIRAKL_SHOP_ID}"`);
    await execute('mirakl_list_offers', { ...ENV, MIRAKL_SHOP_ID: '2001' }, {});
    expect(sent().params.shop_id).toBe('2001');
    mockedAxios.mockClear();
    await call('mirakl_list_offers', {});
    expect(sent().params).not.toHaveProperty('shop_id');
    mockedAxios.mockClear();
    // The install form saves an optional field left empty as "".
    await execute('mirakl_list_offers', { ...ENV, MIRAKL_SHOP_ID: '' }, {});
    expect(sent().params).not.toHaveProperty('shop_id');
  });

  it('probes with the shop account', () => {
    expect(a.probe).toEqual({ tool: 'mirakl_get_account' });
  });

  it('prefixes every tool with mirakl_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^mirakl_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks for confirmation on every write and installs only the bulk offer import switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/get a yes from the user first/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['mirakl_import_offers']);
    for (const name of WRITES.filter((n) => n !== 'mirakl_import_products')) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:true`);
    }
    expect(annotationsOf(tool('mirakl_import_products')).destructiveHint).toBe(false);
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mirakl_ship_order', { order_id: '../offers' });
    expect(sent().url).toBe(`${BASE}/orders/..%2Foffers/ship`);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmirakl_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmirakl_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, path, Mirakl operation code]
  const table: Array<[string, Record<string, unknown>, string, string, string]> = [
    ['mirakl_get_account', {}, 'GET', '/account', 'A01'],
    ['mirakl_list_orders', {}, 'GET', '/orders', 'OR11'],
    ['mirakl_list_offers', {}, 'GET', '/offers', 'OF21'],
    ['mirakl_get_offer', { offer_id: 2001 }, 'GET', '/offers/2001', 'OF22'],
    ['mirakl_list_offer_conditions', {}, 'GET', '/offers/states', 'OF61'],
    ['mirakl_list_offer_imports', {}, 'GET', '/offers/imports', 'OF04'],
    ['mirakl_get_offer_import', { import_id: 77 }, 'GET', '/offers/imports/77', 'OF02'],
    ['mirakl_list_product_imports', {}, 'GET', '/products/imports', 'P51'],
    ['mirakl_get_product_import', { import_id: 78 }, 'GET', '/products/imports/78', 'P42'],
    ['mirakl_get_products', { product_references: 'EAN|3276000000000' }, 'GET', '/products', 'P31'],
    ['mirakl_list_product_offers', { product_references: 'EAN|3276000000000' }, 'GET', '/products/offers', 'P11'],
    ['mirakl_list_threads', {}, 'GET', '/inbox/threads', 'M11'],
    ['mirakl_get_thread', { thread_id: 't-1' }, 'GET', '/inbox/threads/t-1', 'M10'],
    ['mirakl_list_returns', {}, 'GET', '/returns', 'RT11'],
    ['mirakl_list_reasons', {}, 'GET', '/reasons', 'RE01'],
    ['mirakl_list_carriers', {}, 'GET', '/shipping/carriers', 'SH21'],
    ['mirakl_list_invoices', {}, 'GET', '/invoices', 'IV01'],
    ['mirakl_list_transactions', {}, 'GET', '/sellerpayment/transactions_logs', 'TL02'],
    ['mirakl_list_document_requests', {}, 'GET', '/document-request/requests', 'DR11'],
    ['mirakl_list_order_documents', { order_ids: '1234567-A' }, 'GET', '/orders/documents', 'OR72'],
    ['mirakl_list_channels', {}, 'GET', '/channels', 'CH11'],
    ['mirakl_list_shipping_zones', {}, 'GET', '/shipping/zones', 'SH11'],
    ['mirakl_list_shipping_methods', {}, 'GET', '/shipping/types', 'SH12'],
    ['mirakl_list_logistic_classes', {}, 'GET', '/shipping/logistic_classes', 'SH31'],
    ['mirakl_accept_order', { order_id: '1234567-A', order_lines: [{ id: '1234567-A-1', accepted: true }] }, 'PUT', '/orders/1234567-A/accept', 'OR21'],
    ['mirakl_update_tracking', { order_id: '1234567-A', carrier_code: 'UPS', tracking_number: '1Z999' }, 'PUT', '/orders/1234567-A/tracking', 'OR23'],
    ['mirakl_ship_order', { order_id: '1234567-A' }, 'PUT', '/orders/1234567-A/ship', 'OR24'],
    ['mirakl_update_offers', { offers: [{ shop_sku: 'S1', state_code: '11', price: 10 }] }, 'POST', '/offers', 'OF24'],
    ['mirakl_reply_thread', { thread_id: 't-1', body: 'Hello', to: [{ type: 'CUSTOMER' }] }, 'POST', '/inbox/threads/t-1/message', 'M12'],
    ['mirakl_create_order_thread', { order_id: '1234567-A', body: 'Hello', to: ['CUSTOMER'], topic_value: 'Delivery' }, 'POST', '/orders/1234567-A/threads', 'OR43'],
    ['mirakl_resolve_incident', { order_id: '1234567-A', order_line_id: '1234567-A-1', reason_code: '13' }, 'PUT', '/orders/1234567-A/lines/1234567-A-1/resolve_incident', 'OR64'],
    ['mirakl_accept_return', { return_id: 'r-1', accepted: true }, 'PUT', '/returns/accept', 'RT21'],
    ['mirakl_receive_return', { return_id: 'r-1' }, 'PUT', '/returns/receive', 'RT25'],
    ['mirakl_import_products', { file_url: 'https://files.example.com/products.csv' }, 'POST', '/products/imports', 'P41'],
    ['mirakl_import_offers', { file_url: 'https://files.example.com/offers.csv' }, 'POST', '/offers/imports', 'OF01'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s (%s)', async (name, params, method, path, code) => {
    mockedAxios.mockResolvedValue({ data: {} });
    mockedFetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/csv' },
      body: Buffer.from('"sku";"price"\n'),
      finalUrl: String(params.file_url ?? ''),
    } as any);
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
    expect(tool(name).description).toContain(`(${code})`);
  });

  it('pages orders 20 at a time and passes the filters through', async () => {
    mockedAxios.mockResolvedValue({ data: { orders: [], total_count: 0 } });
    await call('mirakl_list_orders', { order_state_codes: 'WAITING_ACCEPTANCE,SHIPPING', start_update_date: '2026-10-01T00:00:00Z', has_incident: false, order: 'desc' });
    expect(sent().params).toEqual({
      order_state_codes: 'WAITING_ACCEPTANCE,SHIPPING',
      start_update_date: '2026-10-01T00:00:00Z',
      has_incident: false,
      order: 'desc',
      max: 20,
    });
  });

  it('accepts order lines with the body OR21 expects', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const lines = [{ id: '1234567-A-1', accepted: true }, { id: '1234567-A-2', accepted: true }];
    await call('mirakl_accept_order', { order_id: '1234567-A', order_lines: lines });
    expect(sent().data).toEqual({ order_lines: lines });
  });

  it('sends only the tracking fields given', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('mirakl_update_tracking', { order_id: '1234567-A', carrier_code: 'UPS', tracking_number: '1Z999' });
    expect(sent().data).toEqual({ carrier_code: 'UPS', tracking_number: '1Z999' });
  });

  it('confirms the shipment with an empty body, which Mirakl needs as Content-Length 0', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('mirakl_ship_order', { order_id: '1234567-A' });
    expect(sent().data).toBeUndefined();
  });

  it('sends whole offers to OF24 and never offers deletion', async () => {
    mockedAxios.mockResolvedValue({ data: { import_id: 1 } });
    const offer = { shop_sku: 'S1', product_id: '3276000000000', product_id_type: 'EAN', state_code: '11', price: 19.9, quantity: 4, leadtime_to_ship: 2 };
    await call('mirakl_update_offers', { offers: [offer] });
    expect(sent().data).toEqual({ offers: [offer] });
    expect(tool('mirakl_update_offers').parameters.properties!.offers.items.properties.update_delete.enum).toEqual(['update']);
    expect(tool('mirakl_update_offers').description).toMatch(/a missing quantity becomes 0/);
    expect(a.instructions).toMatch(/replaces the whole offer/);
  });

  it('replies to a thread with message_input as a JSON multipart field', async () => {
    mockedAxios.mockResolvedValue({ data: { message_id: 'm', thread_id: 't-1' } });
    await call('mirakl_reply_thread', { thread_id: 't-1', body: 'Votre colis part demain.', to: [{ type: 'CUSTOMER' }] });
    expect(sent().data).toBeInstanceOf(FormData);
    expect(JSON.parse(formPart(sent().data, 'message_input')!)).toEqual({ body: 'Votre colis part demain.', to: [{ type: 'CUSTOMER' }] });
    expect(String(sent().headers['content-type'] ?? sent().headers['Content-Type'])).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('opens a thread on an order with thread_input and a free-text topic by default', async () => {
    mockedAxios.mockResolvedValue({ data: { message_id: 'm', thread_id: 't-2' } });
    await call('mirakl_create_order_thread', { order_id: '1234567-A', body: 'Hello', to: ['CUSTOMER', 'OPERATOR'], topic_value: 'Delivery' });
    expect(JSON.parse(formPart(sent().data, 'thread_input')!)).toEqual({
      body: 'Hello',
      to: ['CUSTOMER', 'OPERATOR'],
      topic: { type: 'FREE_TEXT', value: 'Delivery' },
    });
  });

  it('closes an incident on one order line with the reason code in the body', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('mirakl_resolve_incident', { order_id: '1234567-A', order_line_id: '1234567-A-1', reason_code: '13' });
    expect(sent().data).toEqual({ reason_code: '13' });
  });

  it('decides and receives one return at a time with the body RT21 and RT25 expect', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('mirakl_accept_return', { return_id: 'r-1', accepted: true });
    expect(sent().data).toEqual({ returns: [{ id: 'r-1', accepted: true }] });
    mockedAxios.mockClear();
    await call('mirakl_accept_return', { return_id: 'r-2', accepted: false, rejection_reason_code: 'RETURN_REJECTION_WINDOW_CLOSED' });
    expect(sent().data).toEqual({ returns: [{ id: 'r-2', accepted: false, rejection_reason_code: 'RETURN_REJECTION_WINDOW_CLOSED' }] });
    mockedAxios.mockClear();
    await call('mirakl_receive_return', { return_id: 'r-1' });
    expect(sent().data).toEqual({ returns: [{ id: 'r-1' }] });
  });

  it('offers no tool that refunds, cancels an order or moves money', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/refund|cancel|payout|promotions/);
  });

  it('is found by the names of the marketplaces that run on Mirakl', () => {
    const aliases = (adapter as unknown as { aliases: string[] }).aliases;
    for (const name of ['Leroy Merlin', 'ADEO', 'Conforama', 'BUT', 'home24', 'Maisons du Monde', 'Vente-unique', 'ePrice']) expect(aliases).toContain(name);
    for (const url of ['adeo-marketplace.mirakl.net', 'but-prod.mirakl.net', 'conforama-prod.mirakl.net', 'home24.mirakl.net', 'maisonsdumonde-prod.mirakl.net', 'venteunique-prod.mirakl.net']) {
      expect(a.instructions).toContain(`https://${url}`);
    }
  });

  it('uploads import files fetched from the given URL as the file part', async () => {
    mockedAxios.mockResolvedValue({ data: { import_id: 5 } });
    mockedFetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/csv' },
      body: Buffer.from('"sku";"price"\n"S1";"10"\n'),
      finalUrl: 'https://files.example.com/offers.csv',
    } as any);
    await call('mirakl_import_offers', { file_url: 'https://files.example.com/offers.csv' });
    expect(mockedFetchOutbound).toHaveBeenCalledWith('https://files.example.com/offers.csv', expect.any(Object));
    const text = formText(sent().data);
    expect(text).toMatch(/name="file"; filename="offers.csv"/);
    expect(text).toContain('"S1";"10"');
    expect(formPart(sent().data, 'import_mode')).toBe('NORMAL');
    expect((tool('mirakl_import_offers').parameters.properties!.import_mode as { enum: string[] }).enum).toEqual(['NORMAL', 'REPLACE']);
  });

  it('documents setup, the order workflow, pagination and rate limits', () => {
    expect(a.instructions).toContain('My user settings');
    expect(a.instructions).toContain('without `Bearer`');
    expect(a.instructions).toContain('WAITING_ACCEPTANCE');
    expect(a.instructions).toContain('next_page_token');
    expect(a.instructions).toContain('Retry-After');
    expect(a.verifyHints['401']).toContain('MIRAKL_API_KEY');
    expect(a.verifyHints['404']).toContain('MIRAKL_URL');
  });
});

const LIVE_URL = process.env.MIRAKL_URL;
const LIVE_KEY = process.env.MIRAKL_API_KEY;
const live = LIVE_URL && LIVE_KEY ? describe : describe.skip;

live('mirakl adapter: live shop API (reads only)', () => {
  const env: Record<string, string> = { MIRAKL_URL: LIVE_URL as string, MIRAKL_API_KEY: LIVE_KEY as string };
  if (process.env.MIRAKL_SHOP_ID) env.MIRAKL_SHOP_ID = process.env.MIRAKL_SHOP_ID;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('reads the shop, orders and offers', async () => {
    const account = await run('mirakl_get_account');
    expect(account.shop_id).toBeDefined();
    const orders = await run('mirakl_list_orders', { max: 2, order: 'desc' });
    expect(Array.isArray(orders.orders)).toBe(true);
    const offers = await run('mirakl_list_offers', { max: 2 });
    expect(Array.isArray(offers.offers)).toBe(true);
    if (offers.offers[0]) expect((await run('mirakl_get_offer', { offer_id: offers.offers[0].offer_id })).offer_id).toBe(offers.offers[0].offer_id);
    expect(Array.isArray((await run('mirakl_list_offer_conditions')).offer_states)).toBe(true);
  }, 120_000);

  it('reads imports, threads, returns, reasons and carriers', async () => {
    expect(Array.isArray((await run('mirakl_list_offer_imports', { limit: 2 })).data)).toBe(true);
    await run('mirakl_list_product_imports', { max: 2, order: 'desc' });
    const threads = await run('mirakl_list_threads', { limit: 2 });
    expect(Array.isArray(threads.data)).toBe(true);
    if (threads.data[0]) expect((await run('mirakl_get_thread', { thread_id: threads.data[0].id })).id).toBe(threads.data[0].id);
    expect(Array.isArray((await run('mirakl_list_returns', { limit: 2 })).data)).toBe(true);
    expect(Array.isArray((await run('mirakl_list_reasons')).reasons)).toBe(true);
    expect(Array.isArray((await run('mirakl_list_carriers')).carriers)).toBe(true);
    expect(Array.isArray((await run('mirakl_list_channels')).channels)).toBe(true);
    expect(Array.isArray((await run('mirakl_list_logistic_classes')).logistic_classes)).toBe(true);
  }, 120_000);

  it('reads invoices and transactions', async () => {
    await run('mirakl_list_invoices', { max: 2 });
    expect(Array.isArray((await run('mirakl_list_transactions', { limit: 5 })).data)).toBe(true);
  }, 120_000);
});
