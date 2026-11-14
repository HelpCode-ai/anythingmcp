import axios from 'axios';
import * as adapter from './rozetka.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Rozetka Marketplace seller API adapter.
 *
 * Static checks always run: the cabinet login (POST /sites with the Base64
 * password, bearer token afterwards), the success:false error rules, every
 * tool's method and path against Rozetka's apidoc
 * (https://api-seller.rozetka.com.ua/apidoc/api_data.json), required
 * parameters, which tools install switched off, and that nothing touches
 * balances, invoices, payments, fiscal receipts or deletions. The write
 * bodies are pinned in rozetka.write-tools.spec.ts.
 *
 * Live checks run only with RUN_ROZETKA_LIVE=1. Without credentials they
 * confirm the refusal shapes (HTTP 200, success:false); with
 * ROZETKA_USERNAME and ROZETKA_PASSWORD_BASE64 they sign in and read
 * statuses, counts and one page of orders, goods, reviews and chats.
 * Nothing is written.
 *
 *   RUN_ROZETKA_LIVE=1 ROZETKA_USERNAME=... ROZETKA_PASSWORD_BASE64=... \
 *     npx jest src/adapters/intl/rozetka.live.spec.ts
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
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    config: { errorWhen: unknown };
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
  return out;
};

const BASE = 'https://api-seller.rozetka.com.ua';
const call = (name: string, params: Record<string, unknown> = {}) => {
  const logins = { getToken: jest.fn().mockResolvedValue({ token: 'test-token' }) } as unknown as LoginTokenService;
  return new RestEngine({} as OAuth2TokenService, logins).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: a.connector.authConfig,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    tool(name).endpointMapping as never,
    applySchemaDefaults(tool(name).parameters as never, params),
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = { success: true, content: {} }) => mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Method and path of every tool, checked against api_data.json.
const ROUTES: Record<string, string> = {
  rozetka_list_orders: 'GET /orders/search',
  rozetka_get_order: 'GET /orders/{id}',
  rozetka_list_order_statuses: 'GET /order-statuses/search',
  rozetka_list_goods: 'GET /goods/all',
  rozetka_get_goods: 'GET /goods/details',
  rozetka_update_order: 'PUT /orders/{id}',
  rozetka_get_order_counts: 'GET /orders/counts-new',
  rozetka_get_order_payment_status: 'GET /orders/status-payment/{id}',
  rozetka_update_goods_price_stock: 'PUT /items/mass-update',
  rozetka_get_goods_counts: 'GET /goods/counts',
  rozetka_create_goods: 'POST /items-create/create',
  rozetka_list_goods_categories: 'GET /items-create/categories',
  rozetka_list_category_attributes: 'GET /items-create/attributes',
  rozetka_list_attribute_values: 'GET /items-create/values',
  rozetka_list_producers: 'GET /items-create/producers',
  rozetka_list_store_reviews: 'GET /market-reviews/search',
  rozetka_reply_store_review: 'POST /market-review-replies/reply',
  rozetka_list_goods_comments: 'GET /item-comments/search',
  rozetka_reply_goods_comment: 'POST /item-comments/create-comment',
  rozetka_get_message_counts: 'GET /messages/counts',
  rozetka_list_chats: 'GET /messages/search',
  rozetka_get_chat: 'GET /messages/{id}',
  rozetka_get_order_chat: 'GET /messages/{id}/order-chat',
  rozetka_send_message: 'POST /messages/create',
  rozetka_list_refund_requests: 'GET /order-refund/search',
  rozetka_get_refund_request: 'GET /order-refund/detail/{id}',
  rozetka_list_refund_statuses: 'GET /order-refund/search-data',
  rozetka_save_refund_ttn: 'POST /order-refund/save-ttn',
  rozetka_update_refund_status: 'PUT /order-refund/update-status',
};

// Required parameters, as the apidoc marks them (body fields of the writes).
const REQUIRED: Record<string, string[]> = {
  rozetka_get_order: ['id'],
  rozetka_update_order: ['id', 'status'],
  rozetka_get_order_payment_status: ['id'],
  rozetka_update_goods_price_stock: ['items'],
  rozetka_create_goods: ['name', 'name_ua', 'category_id', 'price', 'stock_quantity', 'pictures'],
  rozetka_list_category_attributes: ['category_id'],
  rozetka_list_attribute_values: ['category_id', 'attribute_id'],
  rozetka_reply_store_review: ['market_review_id', 'order_id', 'comment'],
  rozetka_reply_goods_comment: ['parent_id', 'item_id', 'text'],
  rozetka_list_chats: ['msgType'],
  rozetka_get_chat: ['id'],
  rozetka_get_order_chat: ['id'],
  rozetka_send_message: ['chat_id', 'receiver_id', 'body'],
  rozetka_get_refund_request: ['id'],
  rozetka_save_refund_ttn: ['id', 'ttn'],
  rozetka_update_refund_status: ['id', 'status_code'],
};

describe('Rozetka adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the cabinet login and the Base64 password, then sends a bearer token', () => {
    expect(a.slug).toBe('rozetka');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('rozetka');
    expect(a.requiredEnvVars).toEqual(['ROZETKA_USERNAME', 'ROZETKA_PASSWORD_BASE64']);
    expect(a.envVarMeta.ROZETKA_PASSWORD_BASE64).toMatchObject({ kind: 'credential', secret: true });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: 'https://api-seller.rozetka.com.ua/sites',
      loginMethod: 'POST',
      loginBody: { username: '${username}', password: '${password}' },
      username: '{{ROZETKA_USERNAME}}',
      password: '{{ROZETKA_PASSWORD_BASE64}}',
      tokenJsonPath: 'content.access_token',
      tokenTTLSeconds: 14400,
      proactiveRefreshSeconds: 600,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
  });

  it('logs in again well inside the 24-hour idle expiry', () => {
    // Rozetka reports an expired token with HTTP 200, so refreshOn401 never fires;
    // a short local lifetime is what keeps the session valid.
    const ttl = a.connector.authConfig.tokenTTLSeconds as number;
    const early = a.connector.authConfig.proactiveRefreshSeconds as number;
    expect(ttl).toBeLessThan(24 * 3600);
    expect(early).toBeLessThan(ttl);
  });

  it('accepts only a Base64 value for the password', () => {
    const pattern = new RegExp(a.envVarMeta.ROZETKA_PASSWORD_BASE64.pattern as string);
    expect(pattern.test(Buffer.from('my password').toString('base64'))).toBe(true);
    expect(pattern.test('my password!')).toBe(false);
  });

  it('offers every tool on the documented method and path, probing the status list', () => {
    const routes = Object.fromEntries(
      a.tools.map((entry) => [entry.name, `${entry.endpointMapping.method} ${entry.endpointMapping.path}`]),
    );
    expect(routes).toEqual(ROUTES);
    expect(a.probe.tool).toBe('rozetka_list_order_statuses');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
  });

  it('requires the parameters the apidoc requires', () => {
    for (const entry of a.tools) {
      expect([entry.name, [...(entry.parameters.required ?? [])].sort()]).toEqual([entry.name, [...(REQUIRED[entry.name] ?? [])].sort()]);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^rozetka_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set(a.requiredEnvVars);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [key, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, key, (prop.description ?? '').length > 3]).toEqual([entry.name, key, true]);
      }
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only, installs the refund status change switched off, and moves no money', () => {
    for (const entry of a.tools) expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET']);
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off).toEqual(['rozetka_update_refund_status']);
    for (const entry of a.tools) {
      const p = entry.endpointMapping.path;
      expect(p).not.toMatch(/balance|invoice|payments|prro|ttn-|ukrposhta|meest|delete|remove|return-money|credit/i);
    }
    expect(a.description).not.toMatch(/read-only/i);
  });

  it('names every tool in the instructions, with setup and a place to start', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## Rozetka Marketplace')).toBe(true);
    expect(a.instructions).toContain('**Setup**');
    expect(a.instructions).toContain('**Where to start**');
    expect(a.instructions).toContain('ROZETKA_PASSWORD_BASE64');
    expect(a.instructions).not.toMatch(/—/);
  });

  it('turns success:false at HTTP 200 into a failed call, auth errors as 401', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const refusal = (message: string, code: number) => ({
      success: false,
      errors: { message, code, description: 'refused', details: null },
    });
    for (const [message, code, status] of [
      ['incorrect_access_token', 1020, 401],
      ['access_denied', 1010, 403],
      ['check_correctness_of_data', 1005, 400],
      ['server_error', 0, 400],
    ] as const) {
      ok(refusal(message, code));
      await expect(call('rozetka_get_order_counts')).rejects.toMatchObject({ status, message: expect.stringContaining(message) });
    }
    ok({ success: true, content: { all: 3 } });
    await expect(call('rozetka_get_order_counts')).resolves.toMatchObject({ success: true });
  });

  it('lists orders with the bearer token and only the filters given', async () => {
    ok();
    await call('rozetka_list_orders', { types: 4 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders/search`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(req.params).toEqual({ types: 4, page: 1 });
  });

  it('reads counts, payment status, reviews, comments, chats and returns on the documented paths', async () => {
    ok();
    await call('rozetka_get_order_payment_status', { id: 181667632 });
    expect(sent().url).toBe(`${BASE}/orders/status-payment/181667632`);

    ok();
    await call('rozetka_list_store_reviews', { reply_search: 0, vote: 'dislike' });
    expect(sent().url).toBe(`${BASE}/market-reviews/search`);
    expect(sent().params).toEqual({ reply_search: 0, vote: 'dislike', page: 1 });

    ok();
    await call('rozetka_list_goods_comments', { isAnswered: 0, type: 'question' });
    expect(sent().url).toBe(`${BASE}/item-comments/search`);
    expect(sent().params).toEqual({ isAnswered: 0, type: 'question', page: 1 });

    ok();
    await call('rozetka_list_chats', {});
    expect(sent().url).toBe(`${BASE}/messages/search`);
    expect(sent().params).toEqual({
      msgType: 'orders',
      expand: 'user_fio,order_data,item,unread_messages_count',
      sort: '-read_market',
      page: 1,
    });

    ok();
    await call('rozetka_get_chat', { id: 205506 });
    expect(sent().url).toBe(`${BASE}/messages/205506`);
    expect(sent().params).toEqual({ expand: 'messages,item,order_data,user_fio' });

    ok();
    await call('rozetka_get_order_chat', { id: 1516934 });
    expect(sent().url).toBe(`${BASE}/messages/1516934/order-chat`);

    ok();
    await call('rozetka_list_category_attributes', { category_id: 80001 });
    expect(sent().url).toBe(`${BASE}/items-create/attributes`);
    expect(sent().params).toEqual({ category_id: 80001, page: 1, pageSize: 50 });

    ok();
    await call('rozetka_get_refund_request', { id: 'AM1234567' });
    expect(sent().url).toBe(`${BASE}/order-refund/detail/AM1234567`);
    expect(header(sent(), 'Content-Language')).toBe('uk');
  });
});

// Opt-in: RUN_ROZETKA_LIVE=1. Without credentials it checks the refusal shapes (HTTP 200,
// success:false); with ROZETKA_USERNAME and ROZETKA_PASSWORD_BASE64 it signs in and reads.
// Nothing is written.
const live = process.env.RUN_ROZETKA_LIVE === '1';
(live ? describe : describe.skip)('Rozetka: live login and read-only smoke test', () => {
  it('refuses a wrong login with HTTP 200 and incorrect_username_password', async () => {
    const response = await fetch(BASE + '/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'amcp-nonexistent-test', password: Buffer.from('wrong').toString('base64') }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.errors.message).toBe('incorrect_username_password');
  }, 30000);

  it('refuses a wrong token with HTTP 200 and incorrect_access_token', async () => {
    const response = await fetch(BASE + '/order-statuses/search', { headers: { Authorization: 'Bearer invalid' } });
    expect(response.status).toBe(200);
    expect((await response.json()).errors.message).toBe('incorrect_access_token');
  }, 30000);

  const user = process.env.ROZETKA_USERNAME;
  const password = process.env.ROZETKA_PASSWORD_BASE64;
  (user && password ? it : it.skip)('signs in and reads statuses, counts and one page of each list', async () => {
    const login = await fetch(BASE + '/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
    });
    const token = (await login.json()).content.access_token as string;
    const reads = [
      '/order-statuses/search',
      '/orders/counts-new',
      '/orders/search?types=1',
      '/goods/all?pageSize=5',
      '/goods/counts',
      '/market-reviews/search',
      '/item-comments/search',
      '/messages/counts',
      '/messages/search?msgType=orders&expand=user_fio',
      '/items-create/categories?title=%D1%84%D0%BE%D1%82%D0%BE',
    ];
    for (const path of reads) {
      const response = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
      const body = await response.json();
      expect([path, body.success]).toEqual([path, true]);
    }
    const refunds = await fetch(BASE + '/order-refund/search-data', {
      headers: { Authorization: 'Bearer ' + token, 'Content-Language': 'uk' },
    });
    expect((await refunds.json()).success).toBe(true);
  }, 60000);
});
