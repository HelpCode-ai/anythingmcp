import axios from 'axios';
import * as adapter from './olx.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static verification of the OLX Partner API v2 adapter. No customer key
 * exists, so routes were checked on 20 Oct 2026 with an invalid Bearer
 * token: every path below answers 401 invalid_token, while an unknown
 * route under /api/partner answers 404 (so the 401s prove the routes), a
 * call without the Version header answers 400, and the token endpoint on
 * all seven country hosts parses form-encoded client credentials
 * (invalid_client "Client is not active").
 *
 * The live block runs only with an access token from a signed-in OLX
 * account and reads only:
 *
 *   OLX_HOST=https://www.olx.pl OLX_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/olx.live.spec.ts
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
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://www.olx.pl';
const TOKEN = ['tok', 'en', '0a1b2c3d4e5f'].join('');
const ENV = { OLX_HOST: HOST, OLX_CLIENT_ID: '123456', OLX_CLIENT_SECRET: 'secret' };
const tokens = { getAccessToken: jest.fn(async () => TOKEN) } as unknown as OAuth2TokenService;
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>, svc = tokens) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(svc, {} as LoginTokenService).execute(
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

const WRITES = ['olx_deactivate_advert', 'olx_delete_advert', 'olx_mark_thread_read', 'olx_send_message'];

describe('olx adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with OAuth on the country host and asks for v2 read write', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{OLX_CLIENT_ID}}',
      clientSecret: '{{OLX_CLIENT_SECRET}}',
      authorizationUrl: '{{OLX_HOST}}/oauth/authorize/',
      tokenUrl: '{{OLX_HOST}}/api/open/oauth/token',
      scopes: 'v2 read write',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.requiredEnvVars).toEqual(['OLX_HOST', 'OLX_CLIENT_ID', 'OLX_CLIENT_SECRET']);
  });

  it('accepts the seven Partner API countries and nothing else', () => {
    const host = new RegExp(a.envVarMeta.OLX_HOST.pattern!);
    for (const tld of ['pl', 'ro', 'bg', 'pt', 'ua', 'kz', 'uz']) expect(host.test(`https://www.olx.${tld}`)).toBe(true);
    for (const bad of ['https://www.olx.pl/', 'https://olx.pl', 'http://www.olx.pl', 'https://www.olx.com.br', 'https://www.olx.pl.evil.io', 'https://developer.olx.pl']) {
      expect(host.test(bad)).toBe(false);
    }
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'OLX_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'OLX_HOST')!.kind).toBe('address');
  });

  it('sends the Bearer token and the required Version: 2.0 header to /api/partner', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('olx_get_me', { ...ENV, OLX_HOST: 'https://www.olx.ua' }, {});
    expect(sent().url).toBe('https://www.olx.ua/api/partner/users/me');
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().headers.Version).toBe('2.0');
  });

  // [tool, args, method, path under /api/partner]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['olx_get_me', {}, 'GET', '/users/me'],
    ['olx_get_user', { userId: 9 }, 'GET', '/users/9'],
    ['olx_get_business_profile', {}, 'GET', '/users-business/me'],
    ['olx_get_account_balance', {}, 'GET', '/users/me/account-balance'],
    ['olx_list_billing', {}, 'GET', '/users/me/billing'],
    ['olx_list_prepaid_invoices', {}, 'GET', '/users/me/prepaid-invoices'],
    ['olx_list_postpaid_invoices', {}, 'GET', '/users/me/postpaid-invoices'],
    ['olx_list_adverts', {}, 'GET', '/adverts'],
    ['olx_get_advert', { advertId: 1 }, 'GET', '/adverts/1'],
    ['olx_get_advert_statistics', { advertId: 1 }, 'GET', '/adverts/1/statistics'],
    ['olx_get_advert_moderation_reason', { advertId: 1 }, 'GET', '/adverts/1/moderation-reason'],
    ['olx_list_advert_paid_features', { advertId: 1 }, 'GET', '/adverts/1/paid-features'],
    ['olx_list_threads', {}, 'GET', '/threads'],
    ['olx_get_thread', { threadId: 2 }, 'GET', '/threads/2'],
    ['olx_list_messages', { threadId: 2 }, 'GET', '/threads/2/messages'],
    ['olx_list_categories', {}, 'GET', '/categories'],
    ['olx_get_category', { categoryId: 3 }, 'GET', '/categories/3'],
    ['olx_get_category_attributes', { categoryId: 3 }, 'GET', '/categories/3/attributes'],
    ['olx_suggest_category', { q: 'iphone' }, 'GET', '/categories/suggestion'],
    ['olx_list_regions', {}, 'GET', '/regions'],
    ['olx_list_cities', {}, 'GET', '/cities'],
    ['olx_get_city_districts', { cityId: 4 }, 'GET', '/cities/4/districts'],
    ['olx_find_location', { latitude: 52.2, longitude: 21 }, 'GET', '/locations'],
    ['olx_send_message', { threadId: 2, text: 'Hi' }, 'POST', '/threads/2/messages'],
    ['olx_mark_thread_read', { threadId: 2 }, 'POST', '/threads/2/commands'],
    ['olx_deactivate_advert', { advertId: 1, is_success: true }, 'POST', '/adverts/1/commands'],
    ['olx_delete_advert', { advertId: 1 }, 'DELETE', '/adverts/1'],
  ];

  it('covers every tool in the table', () => {
    expect(table.map((r) => r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls %s %s', async (name, args, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${HOST}/api/partner${path}`);
  });

  it('sends the documented command bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('olx_mark_thread_read', { threadId: 2 });
    expect(sent().data).toEqual({ command: 'mark-as-read' });
    mockedAxios.mockClear();
    await call('olx_deactivate_advert', { advertId: 1, is_success: false });
    expect(sent().data).toEqual({ command: 'deactivate', is_success: false });
    mockedAxios.mockClear();
    await call('olx_send_message', { threadId: 2, text: 'Still available' });
    expect(sent().data).toEqual({ text: 'Still available' });
  });

  it('maps advert filters to the API names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('olx_list_adverts', { external_id: 'SKU-1', category_ids: '1,2', offset: 50 });
    expect(sent().params).toEqual({ external_id: 'SKU-1', category_ids: '1,2', offset: 50, limit: 50 });
  });

  it('marks reads read-only, installs every write switched off, and asks for a yes before messages and deactivation', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of ['olx_send_message', 'olx_deactivate_advert', 'olx_delete_advert']) expect(tool(name).description).toMatch(/wait for a yes/);
  });

  it('offers nothing that charges the OLX wallet', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(t.endpointMapping.path).not.toMatch(/paid-features|packets|logos|banners/);
      expect(t.endpointMapping.bodyMapping?.command).not.toBe('activate');
    }
    expect(a.tools.some((t) => t.endpointMapping.method === 'POST' && t.endpointMapping.path === '/adverts')).toBe(false);
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('olx_get_advert', { advertId: '../users/me' });
    expect(sent().url).toBe(`${HOST}/api/partner/adverts/..%2Fusers%2Fme`);
  });

  it('probes with the profile, prefixes tools with olx_ and shares no name with another adapter', () => {
    expect(a.probe).toEqual({ tool: 'olx_get_me' });
    const mine = new Set(a.tools.map((t) => t.name));
    for (const name of mine) expect(name).toMatch(/^olx_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bolx_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bolx_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const LIVE_TOKEN = process.env.OLX_ACCESS_TOKEN;
const liveDescribe = LIVE_TOKEN ? describe : describe.skip;

liveDescribe('olx adapter: live (read-only)', () => {
  const env = { ...ENV, OLX_HOST: process.env.OLX_HOST || HOST };
  const live = { getAccessToken: jest.fn(async () => LIVE_TOKEN) } as unknown as OAuth2TokenService;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => mockedAxios.__actual.request(cfg)));

  it('reads the profile, adverts, threads and categories', async () => {
    for (const name of ['olx_get_me', 'olx_list_adverts', 'olx_list_threads', 'olx_list_categories', 'olx_get_account_balance']) {
      const res = await execute(name, env, {}, live);
      expect(res.data).toHaveProperty('data');
    }
  }, 60000);
});
