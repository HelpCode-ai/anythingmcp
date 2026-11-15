import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './shiprocket.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Shiprocket adapter (apiv2.shiprocket.in/v1/external).
 *
 * Static checks always run: the sign-in (POST /auth/login with the API user's
 * email and password, token in the answer, sent as a bearer), every tool's
 * method and path against Shiprocket's API documentation (apidocs.shiprocket.in,
 * Postman collection read Nov 2026), the query and body names, and that
 * creating orders, assigning AWBs (charges the wallet), pickups,
 * cancellations and NDR actions install switched off.
 *
 * Live checks run only with RUN_SHIPROCKET_LIVE=1. Without credentials they
 * confirm a wrong sign-in is refused; with SHIPROCKET_EMAIL and
 * SHIPROCKET_PASSWORD they read the wallet balance. Reads only. Not run for
 * the first version: no Shiprocket account was available.
 *
 *   RUN_SHIPROCKET_LIVE=1 SHIPROCKET_EMAIL=... SHIPROCKET_PASSWORD=... \
 *     npx jest src/adapters/in/shiprocket.live.spec.ts
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

type Param = { type?: string; description?: string; pattern?: string; enum?: unknown[]; default?: unknown; items?: Param };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Param>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
    envDefaults?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string; help?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations } as never);
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

// Method and path of every tool, from the vendor's documentation (see above).
const ROUTES: Record<string, [string, string]> = {
  shiprocket_list_orders: ['GET', '/orders'],
  shiprocket_get_order: ['GET', '/orders/show/{order_id}'],
  shiprocket_list_shipments: ['GET', '/shipments'],
  shiprocket_get_shipment: ['GET', '/shipments/{shipment_id}'],
  shiprocket_check_serviceability: ['GET', '/courier/serviceability/'],
  shiprocket_list_couriers: ['GET', '/courier/courierListWithCounts'],
  shiprocket_track_awb: ['GET', '/courier/track/awb/{awb}'],
  shiprocket_track_awbs: ['POST', '/courier/track/awbs'],
  shiprocket_track_shipment: ['GET', '/courier/track/shipment/{shipment_id}'],
  shiprocket_track_order: ['GET', '/courier/track'],
  shiprocket_list_pickup_locations: ['GET', '/settings/company/pickup'],
  shiprocket_list_ndr: ['GET', '/ndr/all'],
  shiprocket_get_ndr: ['GET', '/ndr/{awb}'],
  shiprocket_get_wallet_balance: ['GET', '/account/details/wallet-balance'],
  shiprocket_get_statement: ['GET', '/account/details/statement'],
  shiprocket_list_channels: ['GET', '/channels'],
  shiprocket_list_products: ['GET', '/products'],
  shiprocket_get_inventory: ['GET', '/inventory'],
  shiprocket_get_postcode_details: ['GET', '/open/postcode/details'],
  shiprocket_generate_label: ['POST', '/courier/generate/label'],
  shiprocket_generate_invoice: ['POST', '/orders/print/invoice'],
  shiprocket_create_order: ['POST', '/orders/create/adhoc'],
  shiprocket_assign_awb: ['POST', '/courier/assign/awb'],
  shiprocket_request_pickup: ['POST', '/courier/generate/pickup'],
  shiprocket_cancel_orders: ['POST', '/orders/cancel'],
  shiprocket_cancel_shipments: ['POST', '/orders/cancel/shipment/awbs'],
  shiprocket_ndr_action: ['POST', '/ndr/{awb}/action'],
};
// Tools that change spend, buy, cancel or delete: installed switched off.
const OFF = [
  'shiprocket_assign_awb',
  'shiprocket_cancel_orders',
  'shiprocket_cancel_shipments',
  'shiprocket_create_order',
  'shiprocket_ndr_action',
  'shiprocket_request_pickup',
];
// POST tools that only read (searches, reports, price estimates).
const READ_POSTS = ['shiprocket_track_awbs'];

// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  SHIPROCKET_EMAIL: 'api-user@shop.example.org',
  SHIPROCKET_PASSWORD: ['Pw', 'q'.repeat(12), '7'].join(''),
};

const FAKE_TOKEN = ['tok', 'x'.repeat(28)].join('');
const stubLogin = () => {
  const bundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 });
  return { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
};
// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin()).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, ENV),
      headers: cfg.headers,
      config: a.connector.config,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) =>
  mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('shiprocket adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the catalog envelope', () => {
    expect(a.slug).toBe('shiprocket');
    expect(a.region).toBe('in');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('shiprocket');
    expect(a.docsUrl).toBe('https://apidocs.shiprocket.in/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://apiv2.shiprocket.in/v1/external');
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('describes every variable and accepts well-formed values', () => {
    const vars = [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])];
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...vars].sort());
    for (const name of vars) {
      const meta = a.envVarMeta[name];
      expect(meta.help).toBeTruthy();
      expect(meta.link).toMatch(/^https:\/\//);
      if (meta.pattern) {
        expect(new RegExp(meta.pattern).test(ENV[name])).toBe(true);
        expect(new RegExp(meta.pattern).test('')).toBe(false);
      }
    }
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, ...ROUTES[entry.name]]);
    }
  });

  it('installs the spending, buying, cancelling and deleting tools switched off', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...OFF].sort());
    for (const name of OFF) expect(tool(name).endpointMapping.method).not.toBe('GET');
  });

  it('marks reads read-only and nothing else', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || READ_POSTS.includes(entry.name);
      expect([entry.name, annotationsOf(entry).readOnlyHint === true]).toEqual([entry.name, read]);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^shiprocket_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      expect(entry.description.length).toBeGreaterThan(40);
      for (const prop of Object.values(entry.parameters.properties ?? {})) {
        expect(prop.description).toBeTruthy();
        if (prop.pattern) expect(prop.pattern).not.toMatch(/\\[1-9]/);
      }
    }
  });

  it('keeps the texts free of MDX characters and names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const texts = [a.description, a.instructions, a.prerequisites, ...Object.values(a.verifyHints)];
    for (const entry of a.tools) {
      texts.push(entry.description);
      for (const prop of Object.values(entry.parameters.properties ?? {})) texts.push(prop.description ?? '');
    }
    for (const text of texts) expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
  });

  it('probes with a cheap read and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'shiprocket_get_wallet_balance', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('signs in with the API user and sends the token as a bearer', async () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://apiv2.shiprocket.in/v1/external/auth/login',
      loginMethod: 'POST',
      tokenJsonPath: 'token',
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
      refreshOn401: true,
    });
    expect(Number(a.connector.authConfig?.tokenTTLSeconds)).toBeLessThanOrEqual(10 * 24 * 3600);
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    mockedAxios.mockResolvedValueOnce({ status: 200, data: { id: 1, email: ENV.SHIPROCKET_EMAIL, token: 'sr-token-1' }, headers: {} });
    const auth = interpolateDeep(a.connector.authConfig ?? {}, ENV) as never;
    const bundle = await new LoginTokenService({} as PrismaService, config).getToken(auth);
    const login = sent();
    expect(login.url).toBe('https://apiv2.shiprocket.in/v1/external/auth/login');
    expect(login.data).toEqual({ email: ENV.SHIPROCKET_EMAIL, password: ENV.SHIPROCKET_PASSWORD });
    expect(bundle.token).toBe('sr-token-1');

    ok({ data: { balance_amount: '120.00' } });
    await call('shiprocket_get_wallet_balance', {});
    expect(sent().url).toBe('https://apiv2.shiprocket.in/v1/external/account/details/wallet-balance');
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('lists orders and checks serviceability with the documented query names', async () => {
    ok({ data: [] });
    await call('shiprocket_list_orders', { from: '2026-11-01', to: '2026-11-15', filter_by: 'status', filter: 'NEW' });
    expect(sent().url).toBe('https://apiv2.shiprocket.in/v1/external/orders');
    expect(sent().params).toEqual({ page: 1, per_page: 20, from: '2026-11-01', to: '2026-11-15', filter_by: 'status', filter: 'NEW' });

    ok({ data: {} });
    await call('shiprocket_check_serviceability', { pickup_postcode: '110030', delivery_postcode: '122002', weight: 0.5, cod: 0 });
    expect(sent().url).toBe('https://apiv2.shiprocket.in/v1/external/courier/serviceability/');
    expect(sent().params).toEqual({ pickup_postcode: '110030', delivery_postcode: '122002', weight: 0.5, cod: 0 });
  });

  it('tracks by AWB and by a list of AWBs', async () => {
    ok({ tracking_data: {} });
    await call('shiprocket_track_awb', { awb: '788830567028' });
    expect(sent().url).toBe('https://apiv2.shiprocket.in/v1/external/courier/track/awb/788830567028');

    ok({});
    await call('shiprocket_track_awbs', { awbs: ['788830567028', '141123221084922'] });
    expect(sent().data).toEqual({ awbs: ['788830567028', '141123221084922'] });
  });

  it('sends shipment ids as lists to the label, AWB and pickup calls', async () => {
    ok({});
    await call('shiprocket_generate_label', { shipment_ids: [16104408] });
    expect(sent().url).toBe('https://apiv2.shiprocket.in/v1/external/courier/generate/label');
    expect(sent().data).toEqual({ shipment_id: [16104408] });

    ok({});
    await call('shiprocket_assign_awb', { shipment_id: 16016920, courier_id: 10 });
    expect(sent().data).toEqual({ shipment_id: 16016920, courier_id: 10 });

    ok({});
    await call('shiprocket_request_pickup', { shipment_id: 16090109 });
    expect(sent().data).toEqual({ shipment_id: [16090109] });
  });
});

// Opt-in: RUN_SHIPROCKET_LIVE=1. The refusal check needs no account; the
// read needs SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD. Nothing is written.
const live = process.env.RUN_SHIPROCKET_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('shiprocket: live', () => {
  const signIn = (email: string, password: string) =>
    liveFetch.post('https://apiv2.shiprocket.in/v1/external/auth/login', { email, password }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      validateStatus: () => true,
    });

  it('refuses a wrong sign-in', async () => {
    const response = await signIn('not-a-user@example.org', 'not-a-password');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('reads the wallet balance', async () => {
    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;
    if (!email || !password) throw new Error('Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD for the live check');
    const login = await signIn(email, password);
    expect(login.status).toBe(200);
    const response = await liveFetch.get('https://apiv2.shiprocket.in/v1/external/account/details/wallet-balance', {
      headers: { Authorization: `Bearer ${login.data.token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });
});
