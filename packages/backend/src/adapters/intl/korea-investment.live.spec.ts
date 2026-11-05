import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './korea-investment.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Korea Investment & Securities (KIS Developers Open API), market data only.
 *
 * Static checks always run. They pin the token exchange (JSON POST
 * /oauth2/tokenP with grant_type client_credentials, appkey and appsecret;
 * access_token and expires_in back), the headers every call needs
 * (authorization Bearer, appkey, appsecret, custtype P, the per-call tr_id),
 * and the quotation paths, tr_ids and FID_* / EXCD / SYMB query names used by
 * KIS's official samples (github.com/koreainvestment/open-trading-api,
 * examples_llm/domestic_stock and examples_llm/overseas_stock):
 *   GET /uapi/domestic-stock/v1/quotations/inquire-price            FHKST01010100
 *   GET /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice FHKST03010100
 *   GET /uapi/domestic-stock/v1/quotations/inquire-index-price      FHPUP02100000
 *   GET /uapi/overseas-price/v1/quotations/price                    HHDFS00000300
 *   GET /uapi/overseas-price/v1/quotations/dailyprice               HHDFS76240000
 * No tool may reach an order, cancel or account path.
 *
 * Live checks run only with RUN_KOREA_INVESTMENT_LIVE=1. Without keys they
 * confirm the token endpoint refuses a bad App Key. With KIS_APP_KEY and
 * KIS_APP_SECRET (real-trading keys) they request a token and read the
 * Samsung Electronics quote, the KOSPI index and the Apple quote. KIS allows
 * about one token request per minute, so do not rerun it in a loop:
 *
 *   RUN_KOREA_INVESTMENT_LIVE=1 KIS_APP_KEY=... KIS_APP_SECRET=... \
 *     npx jest src/adapters/intl/korea-investment.live.spec.ts
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
  parameters: {
    properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>;
    required?: string[];
  };
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
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
    config: { errorWhen: unknown[] };
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
const statusOf = (body: unknown): number | undefined => {
  try {
    assertNoResponseBodyError(body, a.connector.config.errorWhen as never);
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

const ENV: Record<string, string> = {
  KIS_APP_KEY: 'PSabcdefghij0123456789KLMNOPQRSTuv',
  KIS_APP_SECRET: 'c2VjcmV0LXZhbHVlLWZvci10aGUta2lzLWFkYXB0ZXItc3BlYy0xMjM0NTY3ODkw+/=',
};
const FAKE_TOKEN = 'eyJ0eXAiOiJKV1QifQ.kis-access-token';
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const fakeBundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 86_400_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;

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
const ok = { status: 200, data: { rt_cd: '0', msg_cd: 'MCA00000', msg1: '정상처리 되었습니다.', output: {} }, headers: {} };
const expectKisHeaders = (trId: string) => {
  const headers = sent().headers;
  expect(headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  expect(headers.appkey).toBe(ENV.KIS_APP_KEY);
  expect(headers.appsecret).toBe(ENV.KIS_APP_SECRET);
  expect(headers.custtype).toBe('P');
  expect(headers.tr_id).toBe(trId);
  expect(headers['content-type']).toBe('application/json; charset=utf-8');
};

describe('korea-investment adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /oauth2/tokenP of the real-trading host with the app key and secret', () => {
    expect(a.slug).toBe('korea-investment');
    expect(a.category).toBe('finance');
    expect(a.icon).toBe('korea-investment');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://openapi.koreainvestment.com:9443');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['KIS_APP_KEY', 'KIS_APP_SECRET']);
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://openapi.koreainvestment.com:9443/oauth2/tokenP');
    expect(auth.loginMethod).toBe('POST');
    expect(auth.loginBody).toEqual({ grant_type: 'client_credentials', appkey: '${username}', appsecret: '${password}' });
    expect(auth.username).toBe('{{KIS_APP_KEY}}');
    expect(auth.password).toBe('{{KIS_APP_SECRET}}');
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('expires_in');
    expect(auth.expiryFormat).toBe('ttl_seconds');
    expect(auth.tokenTTLSeconds).toBe(86400);
    expect(auth.extraHeaders).toEqual({ appkey: '{{KIS_APP_KEY}}', appsecret: '{{KIS_APP_SECRET}}' });
    expect(a.connector.headers.custtype).toBe('P');
    const described = describeAdapterEnvVars(a as never);
    expect(described.map((entry) => entry.name)).toEqual(a.requiredEnvVars);
    for (const name of a.requiredEnvVars) {
      expect(described.find((entry) => entry.name === name)).toMatchObject({ kind: 'credential', secret: true });
    }
  });

  it('accepts key-shaped values and refuses blanks, spaces and URLs', () => {
    const key = new RegExp(a.envVarMeta.KIS_APP_KEY.pattern!);
    expect(key.test(ENV.KIS_APP_KEY)).toBe(true);
    for (const bad of ['', 'short', 'PS abc def ghi jkl mno pqr', 'https://apiportal.koreainvestment.com']) {
      expect(key.test(bad)).toBe(false);
    }
    const secret = new RegExp(a.envVarMeta.KIS_APP_SECRET.pattern!);
    expect(secret.test(ENV.KIS_APP_SECRET)).toBe(true);
    for (const bad of ['', 'too-short', `${ENV.KIS_APP_SECRET} x`]) expect(secret.test(bad)).toBe(false);
  });

  it('posts the JSON token request and keeps the token for its lifetime', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as never;
    mockedAxios.mockResolvedValueOnce({
      data: {
        access_token: FAKE_TOKEN,
        access_token_token_expired: '2026-11-06 10:00:00',
        token_type: 'Bearer',
        expires_in: 86400,
      },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as never, config).getToken(auth);
    const login = sent();
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe('https://openapi.koreainvestment.com:9443/oauth2/tokenP');
    expect(login.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(login.data).toEqual({
      grant_type: 'client_credentials',
      appkey: ENV.KIS_APP_KEY,
      appsecret: ENV.KIS_APP_SECRET,
    });
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt - Date.now()).toBeGreaterThan(86_000_000);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it('probes with the Samsung Electronics quote and explains refusals', () => {
    expect(a.probe).toEqual({ tool: 'korea_investment_get_stock_price', params: { stock_code: '005930' } });
    for (const status of ['401', '403']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('turns KIS error envelopes into failed calls and lets rt_cd 0 through', () => {
    expect(statusOf({ rt_cd: '0', msg_cd: 'MCA00000', msg1: 'ok', output: {} })).toBeUndefined();
    expect(statusOf({ rt_cd: '1', msg_cd: 'EGW00123', msg1: '기간이 만료된 token 입니다.' })).toBe(401);
    expect(statusOf({ rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' })).toBe(429);
    expect(statusOf({ rt_cd: '1', msg_cd: 'OPSQ2001', msg1: 'ERROR : INPUT_FIELD_NAME FID_INPUT_ISCD' })).toBe(400);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^korea_investment_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(80);
    }
  });

  it('is market data only: every tool is a read-only GET quotation with its own tr_id', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      expect(m.method).toBe('GET');
      expect(m.path).toMatch(/^\/uapi\/(domestic-stock|overseas-price)\/v1\/quotations\//);
      expect(m.path).not.toMatch(/trading|order|balance|account|psbl|ccld/i);
      expect(String(m.headers?.tr_id)).toMatch(/^[A-Z]{4,5}[0-9A-Z]{5,8}$/);
      expect(entry.enabled).not.toBe(false);
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(annotationsOf(entry).destructiveHint).toBe(false);
    }
    expect(a.tools.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/_(order|orders|cancel|balance|buy|sell)(_|$)/)]),
    );
  });

  it('names every tool in the instructions and states that nothing trades', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toMatch(/read-only market data/i);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('requests a domestic quote with the KIS headers', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('korea_investment_get_stock_price', { stock_code: '005930' });
    expect(sent().url).toBe('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price');
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
    expectKisHeaders('FHKST01010100');
  });

  it('requests a date-range chart with adjusted daily candles by default', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('korea_investment_get_price_chart', { stock_code: '000660', start_date: '20260101', end_date: '20260331' });
    expect(sent().url).toBe(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    );
    expect(sent().params).toEqual({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: '000660',
      FID_INPUT_DATE_1: '20260101',
      FID_INPUT_DATE_2: '20260331',
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    });
    expectKisHeaders('FHKST03010100');
  });

  it('requests the KOSPI index under market U', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('korea_investment_get_index_price', {});
    expect(sent().url).toBe('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-index-price');
    expect(sent().params).toEqual({ FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' });
    expectKisHeaders('FHPUP02100000');
  });

  it('sends the empty AUTH field on overseas quotes and history', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('korea_investment_get_overseas_price', { exchange: 'NAS', symbol: 'AAPL' });
    expect(sent().url).toBe('https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/price');
    expect(sent().params).toEqual({ AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' });
    expectKisHeaders('HHDFS00000300');

    mockedAxios.mockResolvedValueOnce(ok);
    await call('korea_investment_get_overseas_daily_prices', { exchange: 'NYS', symbol: 'KO', base_date: '20261104' });
    expect(sent().url).toBe('https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/dailyprice');
    expect(sent().params).toEqual({ AUTH: '', EXCD: 'NYS', SYMB: 'KO', GUBN: '0', BYMD: '20261104', MODP: '1' });
    expectKisHeaders('HHDFS76240000');
  });
});

// Opt-in: RUN_KOREA_INVESTMENT_LIVE=1. The refusal check needs no account; the
// reads need real-trading KIS_APP_KEY and KIS_APP_SECRET. Reads only.
const live = process.env.RUN_KOREA_INVESTMENT_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const HOST = 'https://openapi.koreainvestment.com:9443';
(live ? describe : describe.skip)('Korea Investment: live', () => {
  it('refuses a made-up App Key at /oauth2/tokenP', async () => {
    const response = await liveFetch.post(
      `${HOST}/oauth2/tokenP`,
      { grant_type: 'client_credentials', appkey: 'PSnotarealkey0000000000000000000000', appsecret: 'not-a-secret' },
      { headers: { 'content-type': 'application/json; charset=utf-8' }, validateStatus: () => true },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.data)).toMatch(/EGW|error/i);
  });

  it('reads the Samsung Electronics quote, the KOSPI index and the Apple quote', async () => {
    const appkey = process.env.KIS_APP_KEY;
    const appsecret = process.env.KIS_APP_SECRET;
    if (!appkey || !appsecret) throw new Error('Set KIS_APP_KEY and KIS_APP_SECRET for the authenticated live check');
    const login = await liveFetch.post(
      `${HOST}/oauth2/tokenP`,
      { grant_type: 'client_credentials', appkey, appsecret },
      { headers: { 'content-type': 'application/json; charset=utf-8' }, validateStatus: () => true },
    );
    expect(login.status).toBe(200);
    const token = (login.data as { access_token?: string }).access_token;
    expect(token).toBeTruthy();
    const headers = (trId: string) => ({
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: trId,
      custtype: 'P',
      'content-type': 'application/json; charset=utf-8',
    });

    const stock = await liveFetch.get(`${HOST}/uapi/domestic-stock/v1/quotations/inquire-price`, {
      headers: headers('FHKST01010100'),
      params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' },
      validateStatus: () => true,
    });
    expect(stock.status).toBe(200);
    expect(stock.data.rt_cd).toBe('0');
    expect(Number(stock.data.output.stck_prpr)).toBeGreaterThan(0);

    const index = await liveFetch.get(`${HOST}/uapi/domestic-stock/v1/quotations/inquire-index-price`, {
      headers: headers('FHPUP02100000'),
      params: { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' },
      validateStatus: () => true,
    });
    expect(index.status).toBe(200);
    expect(index.data.rt_cd).toBe('0');

    const apple = await liveFetch.get(`${HOST}/uapi/overseas-price/v1/quotations/price`, {
      headers: headers('HHDFS00000300'),
      params: { AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' },
      validateStatus: () => true,
    });
    expect(apple.status).toBe(200);
    expect(apple.data.rt_cd).toBe('0');
  });
});
