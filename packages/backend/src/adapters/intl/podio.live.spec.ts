import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './podio.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Podio adapter.
 *
 * Static checks always run. They pin app authentication (form-encoded
 * POST https://podio.com/oauth/token, grant_type=app, access_token and
 * expires_in, sent as Authorization: OAuth2) and the three read tools
 * against the published API:
 *   GET  /app/{app_id}                      https://developers.podio.com/doc/applications/get-app-22349
 *   POST /item/app/{app_id}/filter/         https://developers.podio.com/doc/items/filter-items-4496747
 *   GET  /item/{item_id}?mark_as_viewed=    https://developers.podio.com/doc/items/get-item-22360
 *
 * Live checks run only with RUN_PODIO_LIVE=1. Without credentials they
 * confirm the token endpoint still refuses a bad client id (HTTP 400).
 * With PODIO_APP_ID, PODIO_APP_TOKEN, PODIO_CLIENT_ID and
 * PODIO_CLIENT_SECRET they sign in and read the app, one page of items
 * and the first item:
 *
 *   RUN_PODIO_LIVE=1 PODIO_APP_ID=... PODIO_APP_TOKEN=... \
 *     PODIO_CLIENT_ID=... PODIO_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/podio.live.spec.ts
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
  parameters: {
    properties?: Record<string, { description?: string; default?: unknown }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  slug: string;
  name: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
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

const ENV: Record<string, string> = {
  PODIO_APP_ID: '12345678',
  PODIO_APP_TOKEN: 'app-token-value',
  PODIO_CLIENT_ID: 'podio-client',
  PODIO_CLIENT_SECRET: 'client-secret-value',
};
const FAKE_TOKEN = 'podio-access-token';
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;

const fakeBundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 28_800_000 });
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
  ) as Promise<{ body: unknown }>;
};

const sent = () => mockedAxios.mock.calls.at(-1)![0];

describe('podio adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the app grant, form-encoded, and sends OAuth2', () => {
    expect(a.connector.baseUrl).toBe('https://api.podio.com');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual([
      'PODIO_APP_ID',
      'PODIO_APP_TOKEN',
      'PODIO_CLIENT_ID',
      'PODIO_CLIENT_SECRET',
    ]);
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://podio.com/oauth/token');
    expect(auth.loginMethod).toBe('POST');
    expect((auth.loginHeaders as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(auth.loginBody).toEqual({
      grant_type: 'app',
      app_id: '{{PODIO_APP_ID}}',
      app_token: '{{PODIO_APP_TOKEN}}',
      client_id: '{{PODIO_CLIENT_ID}}',
      client_secret: '{{PODIO_CLIENT_SECRET}}',
    });
    expect(auth.username).toBe('{{PODIO_CLIENT_ID}}');
    expect(auth.password).toBe('{{PODIO_CLIENT_SECRET}}');
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('expires_in');
    expect(auth.expiryFormat).toBe('ttl_seconds');
    expect(auth.tokenTTLSeconds).toBe(28800);
    expect(auth.refreshOn401).toBe(true);
    expect(auth.headerTemplate).toBe('OAuth2 ${token}');
    const described = describeAdapterEnvVars(a as never);
    expect(described.map((entry) => entry.name)).toEqual(a.requiredEnvVars);
    expect(described.find((entry) => entry.name === 'PODIO_APP_TOKEN')).toMatchObject({
      kind: 'credential',
      secret: true,
      required: true,
    });
    expect(described.find((entry) => entry.name === 'PODIO_CLIENT_SECRET')?.secret).toBe(true);
  });

  it('accepts an app id and token-shaped secrets, and refuses blanks and URLs', () => {
    const appId = new RegExp(a.envVarMeta.PODIO_APP_ID.pattern!);
    expect(appId.test('12345678')).toBe(true);
    for (const bad of ['', '0123', '12 34', 'https://podio.com']) expect(appId.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.PODIO_APP_TOKEN.pattern!);
    expect(token.test('abcDEF12345678')).toBe(true);
    for (const bad of ['', 'short', 'has space', 'Bearer abcDEF12345678']) expect(token.test(bad)).toBe(false);
    const clientId = new RegExp(a.envVarMeta.PODIO_CLIENT_ID.pattern!);
    expect(clientId.test('podio-client')).toBe(true);
    expect(clientId.test('not a client')).toBe(false);
  });

  it('reads access_token and expires_in from the login response', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as never;
    mockedAxios.mockResolvedValueOnce({
      data: { access_token: FAKE_TOKEN, expires_in: 28800, token_type: 'bearer' },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as never, config).getToken(auth);
    const login = sent();
    expect(login.method).toBe('POST');
    expect(login.url).toBe('https://podio.com/oauth/token');
    expect(login.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(login.data).toEqual({
      grant_type: 'app',
      app_id: '12345678',
      app_token: 'app-token-value',
      client_id: 'podio-client',
      client_secret: 'client-secret-value',
    });
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt - Date.now()).toBeGreaterThan(28_000_000);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(28_800_000);
  });

  it('probes with the app read and explains the Podio error codes, including 420', () => {
    expect(a.probe).toEqual({ tool: 'podio_get_app' });
    expect(tool('podio_get_app').parameters.required ?? []).toEqual([]);
    for (const status of ['400', '401', '403', '404', '420']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('keeps the three read tools on the documented paths', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual([
      'podio_get_app',
      'podio_filter_items',
      'podio_get_item',
    ]);
    expect(tool('podio_get_app').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/app/{{PODIO_APP_ID}}',
    });
    expect(tool('podio_filter_items').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/item/app/{{PODIO_APP_ID}}/filter/',
      bodyMapping: {
        filters: '$filters',
        sort_by: '$sort_by',
        sort_desc: '$sort_desc',
        limit: '$limit',
        offset: '$offset',
      },
    });
    expect(tool('podio_get_item').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/item/{item_id}',
      queryParams: { mark_as_viewed: false },
    });
    expect(tool('podio_get_item').parameters.required).toEqual(['item_id']);
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(annotationsOf(entry).destructiveHint).toBe(false);
    }
  });

  it('prefixes every tool with podio_ and shares no tool name', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^podio_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
  });

  it('names every tool in the instructions and writes no em dash', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('requests the app, a filtered page and one item, and shapes the answers', async () => {
    mockedAxios.mockResolvedValueOnce({ data: {}, headers: {} });
    await call('podio_get_app', {});
    expect(sent().url).toBe('https://api.podio.com/app/12345678');
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().headers.Authorization).toBe(`OAuth2 ${FAKE_TOKEN}`);
    const appBody = {
      app_id: 12345678,
      status: 'active',
      space_id: 9,
      config: { name: 'Leads', item_name: 'Lead', description: 'Inbound' },
      fields: [
        {
          field_id: 11,
          external_id: 'status',
          type: 'category',
          config: {
            label: 'Status',
            required: true,
            settings: { options: [{ id: 1, text: 'Open' }] },
          },
        },
      ],
      rights: ['view'],
    };
    expect(applyResponseTransform(appBody, tool('podio_get_app').responseMapping).value).toEqual({
      app_id: 12345678,
      status: 'active',
      space_id: 9,
      url: null,
      link: null,
      name: 'Leads',
      item_name: 'Lead',
      description: 'Inbound',
      fields: [
        {
          field_id: 11,
          external_id: 'status',
          type: 'category',
          label: 'Status',
          required: true,
          settings: { options: [{ id: 1, text: 'Open' }] },
        },
      ],
    });

    mockedAxios.mockResolvedValueOnce({ data: { total: 1, filtered: 1, items: [] }, headers: {} });
    await call('podio_filter_items', {
      filters: { status: [1], created_on: { from: '-7d' } },
      sort_by: 'created_on',
      sort_desc: true,
    });
    const filter = sent();
    expect(filter.url).toBe('https://api.podio.com/item/app/12345678/filter/');
    expect(String(filter.method).toUpperCase()).toBe('POST');
    expect(filter.headers.Authorization).toBe(`OAuth2 ${FAKE_TOKEN}`);
    expect(filter.data).toEqual({
      filters: { status: [1], created_on: { from: '-7d' } },
      sort_by: 'created_on',
      sort_desc: true,
      limit: 20,
      offset: 0,
    });

    mockedAxios.mockResolvedValueOnce({ data: {}, headers: {} });
    await call('podio_get_item', { item_id: 99 });
    expect(sent().url).toBe('https://api.podio.com/item/99');
    expect(sent().params).toEqual({ mark_as_viewed: false });
    const itemBody = {
      item_id: 99,
      title: 'Acme',
      link: 'https://podio.com/item/99',
      created_on: '2024-01-02 03:04:05',
      created_by: { name: 'Ada' },
      push: { signature: 'drop-me' },
      comments: [{ comment_id: 1 }],
      fields: [
        {
          field_id: 11,
          external_id: 'title',
          type: 'text',
          config: { label: 'Title' },
          values: [{ value: 'Acme' }],
        },
      ],
    };
    expect(applyResponseTransform(itemBody, tool('podio_get_item').responseMapping).value).toEqual({
      item_id: 99,
      app_item_id: null,
      title: 'Acme',
      link: 'https://podio.com/item/99',
      external_id: null,
      created_on: '2024-01-02 03:04:05',
      created_by: 'Ada',
      last_event_on: null,
      tags: null,
      fields: [
        {
          field_id: 11,
          external_id: 'title',
          type: 'text',
          label: 'Title',
          values: [{ value: 'Acme' }],
        },
      ],
    });
  });
});

// Opt-in: RUN_PODIO_LIVE=1. The refusal check needs no account. The read
// needs PODIO_APP_ID, PODIO_APP_TOKEN, PODIO_CLIENT_ID and PODIO_CLIENT_SECRET.
const live = process.env.RUN_PODIO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Podio: live', () => {
  it('refuses a bad client id at the form-encoded token endpoint', async () => {
    const response = await liveFetch.post(
      'https://podio.com/oauth/token',
      new URLSearchParams({
        grant_type: 'app',
        app_id: '1',
        app_token: 'not-a-token',
        client_id: 'not-a-client',
        client_secret: 'not-a-secret',
      }),
      { headers: { Accept: 'application/json' }, validateStatus: () => true },
    );
    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({ error: 'invalid_client' });
  });

  it('signs in and reads the app, one page of items and the first item', async () => {
    const env = process.env;
    const missing = ['PODIO_APP_ID', 'PODIO_APP_TOKEN', 'PODIO_CLIENT_ID', 'PODIO_CLIENT_SECRET'].filter(
      (name) => !env[name],
    );
    if (missing.length) throw new Error(`Set ${missing.join(', ')} for the authenticated live check`);
    const login = await liveFetch.post(
      'https://podio.com/oauth/token',
      new URLSearchParams({
        grant_type: 'app',
        app_id: env.PODIO_APP_ID!,
        app_token: env.PODIO_APP_TOKEN!,
        client_id: env.PODIO_CLIENT_ID!,
        client_secret: env.PODIO_CLIENT_SECRET!,
      }),
      { headers: { Accept: 'application/json' }, validateStatus: () => true },
    );
    expect(login.status).toBe(200);
    const token = (login.data as { access_token?: string }).access_token;
    expect(token).toBeTruthy();
    const headers = { Authorization: `OAuth2 ${token}`, Accept: 'application/json' };

    const app = await liveFetch.get(`https://api.podio.com/app/${env.PODIO_APP_ID}`, {
      headers,
      validateStatus: () => true,
    });
    expect(app.status).toBe(200);
    expect(app.data).toMatchObject({ app_id: Number(env.PODIO_APP_ID) });
    expect(Array.isArray(app.data.fields)).toBe(true);

    const page = await liveFetch.post(
      `https://api.podio.com/item/app/${env.PODIO_APP_ID}/filter/`,
      { limit: 1, offset: 0 },
      { headers, validateStatus: () => true },
    );
    expect(page.status).toBe(200);
    expect(typeof page.data.filtered).toBe('number');
    expect(Array.isArray(page.data.items)).toBe(true);

    const first = page.data.items[0];
    if (!first) return;
    const item = await liveFetch.get(`https://api.podio.com/item/${first.item_id}`, {
      headers,
      params: { mark_as_viewed: false },
      validateStatus: () => true,
    });
    expect(item.status).toBe(200);
    expect(item.data.item_id).toBe(first.item_id);
  });
});
