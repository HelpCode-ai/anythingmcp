import axios from 'axios';
import * as adapter from './getcourse.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * GetCourse adapter: the Export API (/pl/api/account, secret key as the `key`
 * query parameter) and the read calls of the Tech API (/pl/api/v1, bearer
 * token made of the developer key, an underscore and the secret key).
 *
 * Static checks always run: the per-account base URL, the key on every
 * export call and never on a Tech API call, the bearer header that is left
 * out while no developer key is set, every tool's method and path against
 * GetCourse's API pages, the bracketed date filters, the error rules for the
 * HTTP 200 refusals, and that every tool is a read. The Import API (Base64
 * JSON in a form field) is not part of the adapter.
 * https://getcourse.ru/help/api and https://getcourse.ru/pl/postback/redoc
 *
 * Live checks run only with RUN_GETCOURSE_LIVE=1. Without an account they
 * confirm both APIs refuse a wrong key; with GETCOURSE_HOST and
 * GETCOURSE_API_KEY they read the group list (one of the 100 Export API
 * requests allowed per 2 hours). Reads only.
 *
 *   RUN_GETCOURSE_LIVE=1 GETCOURSE_HOST=myschool.getcourse.ru GETCOURSE_API_KEY=... \
 *     npx jest src/adapters/intl/getcourse.live.spec.ts
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
    bodyEncoding?: string;
    headers?: Record<string, string>;
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
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
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

const ENV: Record<string, string> = {
  GETCOURSE_HOST: 'myschool.getcourse.ru',
  GETCOURSE_API_KEY: 'schoolSecretKey0123456789abcdefghijklmnop',
  GETCOURSE_DEVELOPER_KEY: 'devKey123',
};
const BASE = 'https://myschool.getcourse.ru/pl/api';
const KEY = { key: ENV.GETCOURSE_API_KEY };
const TECH_HEADER = 'Bearer ${GETCOURSE_DEVELOPER_KEY}_${GETCOURSE_API_KEY}';

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: { success: true }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const formOf = (req: { data?: unknown }) => Object.fromEntries(new URLSearchParams(String(req.data ?? '')));

// name, method, path, required parameters. /account/... is the Export API
// (getcourse.ru/help/api), /v1/... the Tech API (getcourse.ru/pl/postback/redoc).
const CONTRACT: Array<[string, string, string, string[]]> = [
  ['getcourse_list_groups', 'GET', '/account/groups', []],
  ['getcourse_start_users_export', 'GET', '/account/users', []],
  ['getcourse_start_group_users_export', 'GET', '/account/groups/{group_id}/users', ['group_id']],
  ['getcourse_start_deals_export', 'GET', '/account/deals', []],
  ['getcourse_start_payments_export', 'GET', '/account/payments', []],
  ['getcourse_get_export', 'GET', '/account/exports/{export_id}', ['export_id']],
  ['getcourse_list_custom_fields', 'POST', '/account/fields', []],
  ['getcourse_get_user', 'GET', '/v1/user/get-fields', []],
  ['getcourse_get_user_custom_fields', 'GET', '/v1/user/get-custom-fields', []],
  ['getcourse_list_user_deals', 'GET', '/v1/user/get-deals', []],
  ['getcourse_list_user_groups', 'GET', '/v1/user/get-groups', []],
  ['getcourse_list_user_purchases', 'GET', '/v1/user/get-purchases', []],
  ['getcourse_list_user_trainings', 'GET', '/v1/user/get-trainings', []],
  ['getcourse_get_user_balance', 'GET', '/v1/user/get-balance', []],
  ['getcourse_get_deal', 'GET', '/v1/deal/get-fields', ['deal_id']],
  ['getcourse_get_deal_custom_fields', 'GET', '/v1/deal/get-custom-fields', ['deal_id']],
  ['getcourse_list_deal_comments', 'GET', '/v1/deal/get-comments', ['deal_id']],
  ['getcourse_list_offers', 'GET', '/v1/offer/get-offers', []],
  ['getcourse_get_offer', 'GET', '/v1/offer/get-offer-by-id', ['offer_id']],
  ['getcourse_list_trainings', 'GET', '/v1/common/get-trainings', []],
  ['getcourse_list_webinars', 'GET', '/v1/webinar/get-all-webinars', []],
];

describe('getcourse adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('builds the base URL from the account host and declares the keys', () => {
    expect(a.slug).toBe('getcourse');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('getcourse');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{GETCOURSE_HOST}}/pl/api');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['GETCOURSE_HOST', 'GETCOURSE_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['GETCOURSE_DEVELOPER_KEY']);
    expect(a.envVarMeta.GETCOURSE_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.GETCOURSE_DEVELOPER_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.GETCOURSE_HOST.secret).toBeUndefined();
    // No optional variable in a connector-level header: it would go out as a literal placeholder.
    expect(JSON.stringify(a.connector.headers)).not.toContain('GETCOURSE_');

    const host = new RegExp(a.envVarMeta.GETCOURSE_HOST.pattern!);
    for (const good of ['myschool.getcourse.ru', 'school.example.com', 'getcourse.ru']) expect(host.test(good)).toBe(true);
    for (const bad of ['', 'https://myschool.getcourse.ru', 'myschool.getcourse.ru/pl/api', 'myschool']) expect(host.test(bad)).toBe(false);
    for (const name of ['GETCOURSE_API_KEY', 'GETCOURSE_DEVELOPER_KEY']) {
      expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    }
    for (const name of ['GETCOURSE_API_KEY', 'GETCOURSE_DEVELOPER_KEY']) {
      expect(new RegExp(a.envVarMeta[name].pattern!).test('has a space')).toBe(false);
    }
  });

  it('probes the group list and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'getcourse_list_groups', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(CONTRACT.map(([name]) => name));
    for (const [name, method, path, required] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(path);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('puts the secret key on Export API calls only, and the bearer token on Tech API calls only', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      if (m.path.startsWith('/v1/')) {
        expect(m.headers).toEqual({ Authorization: TECH_HEADER });
        expect(JSON.stringify(m.queryParams ?? {})).not.toContain('GETCOURSE_API_KEY');
        expect(entry.description).toMatch(/developer key/);
      } else {
        expect(m.path.startsWith('/account/')).toBe(true);
        expect(m.headers).toBeUndefined();
        const carrier = m.method === 'GET' ? m.queryParams : m.bodyMapping;
        expect(carrier?.key).toBe('{{GETCOURSE_API_KEY}}');
      }
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^getcourse_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('is read-only: every tool is a read, nothing is switched off, and the Import API is absent', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.enabled).toBeUndefined();
      // The import endpoints are /pl/api/users and /pl/api/deals with action=add.
      expect(['/users', '/deals']).not.toContain(entry.endpointMapping.path);
      expect(JSON.stringify(entry.endpointMapping)).not.toMatch(/"action":"(add|update)"|"params"/);
    }
    const posts = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name);
    expect(posts).toEqual(['getcourse_list_custom_fields']);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('turns the refusals GetCourse answers with HTTP 200 into failed calls, but not a pending export', () => {
    const rules = a.connector.config.errorWhen;
    const failure = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, rules);
        return undefined;
      } catch (e) {
        return e as ResponseBodyError;
      }
    };
    const refused = failure({ success: false, info: [], error_message: 'Неавторизованное API-обращение', error: true, error_code: 901 });
    expect(refused?.status).toBe(401);
    expect(refused?.message).toContain('Неавторизованное');
    expect(failure({ success: false, info: [], error_message: 'Слишком много запросов', error: true, error_code: 903 })?.status).toBe(429);
    // Not ready yet: the model reads the message and asks again later.
    expect(failure({ success: false, info: [], error_message: 'Файл еще не создан', error: true, error_code: 909 })).toBeUndefined();
    expect(failure({ success: true, info: { export_id: 123456 }, error_message: '', error: false })).toBeUndefined();
    expect(failure({ success: true, info: { fields: ['id', 'Email'], items: [['1', 'a@example.test']] }, error: false })).toBeUndefined();
  });

  it('starts exports on the account host with the key and bracketed date filters', async () => {
    ok();
    await call('getcourse_start_users_export', { created_from: '2026-10-01', created_to: '2026-10-31', status: 'active', idgrouplist: 'id' });
    let req = sent();
    expect(req.url).toBe(`${BASE}/account/users`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ ...KEY, 'created_at[from]': '2026-10-01', 'created_at[to]': '2026-10-31', status: 'active', idgrouplist: 'id' });
    expect(header(req, 'Authorization')).toBeUndefined();

    ok();
    await call('getcourse_start_deals_export', { payed_from: '2026-11-01', payed_to: '2026-11-19', status: 'payed', user_in_group: 77 });
    req = sent();
    expect(req.url).toBe(`${BASE}/account/deals`);
    expect(req.params).toEqual({ ...KEY, 'payed_at[from]': '2026-11-01', 'payed_at[to]': '2026-11-19', status: 'payed', user_in_group: 77 });

    ok();
    await call('getcourse_start_payments_export', { status_changed_from: '2026-11-01', status: 'accepted' });
    req = sent();
    expect(req.url).toBe(`${BASE}/account/payments`);
    expect(req.params).toEqual({ ...KEY, 'status_changed_at[from]': '2026-11-01', status: 'accepted' });

    ok();
    await call('getcourse_start_group_users_export', { group_id: 77, added_from: '2026-11-01' });
    req = sent();
    expect(req.url).toBe(`${BASE}/account/groups/77/users`);
    expect(req.params).toEqual({ ...KEY, 'added_at[from]': '2026-11-01' });
  });

  it('reads an export, the groups and the additional fields', async () => {
    ok();
    await call('getcourse_get_export', { export_id: 123456 });
    expect(sent().url).toBe(`${BASE}/account/exports/123456`);
    expect(sent().params).toEqual(KEY);

    ok();
    await call('getcourse_list_groups', {});
    expect(sent().url).toBe(`${BASE}/account/groups`);
    expect(sent().params).toEqual(KEY);

    ok();
    await call('getcourse_list_custom_fields', {});
    const req = sent();
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.url).toBe(`${BASE}/account/fields`);
    expect(header(req, 'Content-Type')).toMatch(/application\/x-www-form-urlencoded/);
    expect(formOf(req)).toEqual({ action: 'get', ...KEY });
  });

  it('calls the Tech API with the developer key and the secret key joined by an underscore', async () => {
    ok();
    await call('getcourse_get_user', { email: 'student@example.test' });
    let req = sent();
    expect(req.url).toBe(`${BASE}/v1/user/get-fields`);
    expect(req.params).toEqual({ email: 'student@example.test' });
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.GETCOURSE_DEVELOPER_KEY}_${ENV.GETCOURSE_API_KEY}`);

    ok();
    await call('getcourse_list_user_deals', { user_id: 4242 });
    req = sent();
    expect(req.url).toBe(`${BASE}/v1/user/get-deals`);
    expect(req.params).toEqual({ userId: 4242 });

    ok();
    await call('getcourse_get_deal', { deal_id: 99001 });
    req = sent();
    expect(req.url).toBe(`${BASE}/v1/deal/get-fields`);
    expect(req.params).toEqual({ dealId: 99001 });

    ok();
    await call('getcourse_list_offers', { limit: 50, offset: 100 });
    req = sent();
    expect(req.url).toBe(`${BASE}/v1/offer/get-offers`);
    expect(req.params).toEqual({ limit: 50, offset: 100 });

    ok();
    await call('getcourse_list_webinars', { type: 'LiveWebinar' });
    req = sent();
    expect(req.url).toBe(`${BASE}/v1/webinar/get-all-webinars`);
    expect(req.params).toEqual({ type: 'LiveWebinar' });
  });

  it('sends no Authorization header while no developer key is set', async () => {
    for (const developerKey of [undefined, '']) {
      const env: Record<string, string> = { GETCOURSE_HOST: ENV.GETCOURSE_HOST, GETCOURSE_API_KEY: ENV.GETCOURSE_API_KEY };
      if (developerKey !== undefined) env.GETCOURSE_DEVELOPER_KEY = developerKey;
      ok();
      await call('getcourse_list_trainings', {}, env);
      expect(sent().url).toBe(`${BASE}/v1/common/get-trainings`);
      expect(header(sent(), 'Authorization')).toBeUndefined();
      expect(JSON.stringify(sent().headers)).not.toContain('GETCOURSE_');
    }
  });
});

// Opt-in: RUN_GETCOURSE_LIVE=1. The refusal checks need no account (they ask
// getcourse.ru itself, which is a GetCourse account, with a wrong key); the
// read needs GETCOURSE_HOST and GETCOURSE_API_KEY. Nothing is written.
const live = process.env.RUN_GETCOURSE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('getcourse: live', () => {
  it('refuses a wrong secret key with HTTP 200 and error_code 901', async () => {
    const response = await liveFetch.get('https://getcourse.ru/pl/api/account/groups', {
      params: { key: 'not-a-real-key' },
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ success: false, error: true, error_code: 901 });
  });

  it('refuses a wrong Tech API token with 403', async () => {
    const response = await liveFetch.get('https://getcourse.ru/pl/api/v1/common/get-trainings', {
      headers: { Authorization: 'Bearer wrong_wrong', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(403);
    expect(response.data).toMatchObject({ status: false, code: 403 });
  });

  it('reads the group list of the account', async () => {
    const host = process.env.GETCOURSE_HOST;
    const key = process.env.GETCOURSE_API_KEY;
    if (!host || !key) throw new Error('Set GETCOURSE_HOST and GETCOURSE_API_KEY for the live check');
    const response = await liveFetch.get(`https://${host}/pl/api/account/groups`, {
      params: { key },
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
  });
});
