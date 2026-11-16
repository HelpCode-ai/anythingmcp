import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './apaczka.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Apaczka.pl API v2 adapter.
 *
 * Every call is a form-urlencoded POST to https://www.apaczka.pl/api/v2/<route>
 * with app_id, request (the call's JSON as text), expires (Unix seconds, at
 * most 15 minutes ahead) and signature: the lower-case hex HMAC-SHA256 of
 * `app_id:route:request:expires` keyed with the app secret, route being the
 * method path with its path parameters and trailing slash and no leading
 * slash. https://api-docs.apaczka.pl/legacy/hmac-signing
 *
 * Static checks always run: the signature block, every tool's route against
 * the API v2 reference (api-docs.apaczka.pl/reference/v2-legacy), the request
 * JSON each tool sends, which tools install switched off, and requests through
 * the real RestEngine whose form fields and signature are compared with the
 * documented formula. One digest is pinned to a value computed with PHP and
 * the official SDK's formula (see rest.engine.form-signing.spec.ts).
 *
 * Live checks run only with RUN_APACZKA_LIVE=1. Without credentials they
 * confirm the API refuses a wrong signature inside an HTTP 200; with
 * APACZKA_APP_ID and APACZKA_APP_SECRET they read the service structure and
 * one page of orders. Reads only.
 *
 *   RUN_APACZKA_LIVE=1 APACZKA_APP_ID=... APACZKA_APP_SECRET=... \
 *     npx jest src/adapters/pl/apaczka.live.spec.ts
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
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: { signature: Record<string, unknown> };
    headers?: Record<string, string>;
    config?: { errorWhen?: Array<Record<string, unknown>> };
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
  const out = new Set<string>();
  for (const [, p] of entry.endpointMapping.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /^\$\w+$/.test(v)) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(entry.endpointMapping.bodyMapping ?? {});
  return out;
};

const ENV: Record<string, string> = {
  APACZKA_APP_ID: '62f10ea5-a532-4a30-bb5c-9b6bd0e29d31',
  APACZKA_APP_SECRET: 'test-app-secret',
};
const NOW_S = 1752994800;
const EXPIRES = String(NOW_S + 600);

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const form = () => new URLSearchParams(sent().data as string);
/** The signature as the docs define it, over the fields actually sent. */
const documentedSignature = (route: string, request: string) =>
  createHmac('sha256', ENV.APACZKA_APP_SECRET)
    .update(`${ENV.APACZKA_APP_ID}:${route}:${request}:${EXPIRES}`)
    .digest('hex');
const ok = (response: unknown = {}) =>
  mockedAxios.mockResolvedValueOnce({ status: 200, data: { status: 200, message: '', response }, headers: {} });

const SENDER = {
  name: 'Firma Testowa Sp. z o.o.',
  line1: 'ul. Marszalkowska 1',
  postal_code: '05-500',
  city: 'Warszawa',
  country_code: 'PL',
  contact_person: 'Jan Kowalski',
  email: 'sender@example.pl',
  phone: '500000000',
};
const RECEIVER = {
  name: 'Odbiorca',
  line1: 'Legionow Polskich 2',
  postal_code: '01-479',
  city: 'Warszawa',
  country_code: 'PL',
  phone: '321321321',
};
const PARCEL = [{ dimension1: 10, dimension2: 10, dimension3: 10, weight: 1, is_nstd: 0 }];

describe('apaczka adapter: static contract', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
  });
  afterEach(() => now.mockRestore());

  it('signs app_id:route:request:expires in the form body with the app secret', () => {
    expect(a.slug).toBe('apaczka');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('apaczka');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://www.apaczka.pl/api/v2');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      signature: {
        algorithm: 'sha256',
        encoding: 'hex',
        secret: '{{APACZKA_APP_SECRET}}',
        placement: 'form',
        paramName: 'signature',
        bodyParams: { app_id: '{{APACZKA_APP_ID}}' },
        timestampParam: 'expires',
        // Apaczka accepts at most 15 minutes ahead.
        timestampOffsetSeconds: 600,
        template: '${form.app_id}:${apiPathNoSlash}:${form.request}:${timestamp}',
      },
    });
    expect(a.requiredEnvVars).toEqual(['APACZKA_APP_ID', 'APACZKA_APP_SECRET']);
    expect(a.envVarMeta.APACZKA_APP_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.APACZKA_APP_ID.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.APACZKA_APP_ID.pattern!).test(ENV.APACZKA_APP_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.APACZKA_APP_SECRET.pattern!).test(ENV.APACZKA_APP_SECRET)).toBe(true);
    expect(new RegExp(a.envVarMeta.APACZKA_APP_SECRET.pattern!).test('has a space')).toBe(false);
  });

  it('turns a non-200 status inside the HTTP 200 body into a failed call', async () => {
    const rules = a.connector.config!.errorWhen!;
    expect(rules.map((r) => r.status)).toEqual([401, 400]);
    const nonSuccess = new RegExp(String(rules[1].matches), 'i');
    expect(nonSuccess.test('200')).toBe(false);
    for (const status of ['400', '401', '404', '500']) expect(nonSuccess.test(status)).toBe(true);
    // A wrong app_id (seen live) and a wrong secret (documented) count as authentication failures.
    const auth = new RegExp(String(rules[0].messageMatches), 'i');
    for (const message of ['App not found.', 'Invalid signature']) expect(auth.test(message)).toBe(true);
    expect(auth.test('Brak wyceny dla podanych parametrów zamówienia.')).toBe(false);

    mockedAxios.mockResolvedValueOnce({ status: 200, data: { status: 400, message: 'Invalid signature', response: null }, headers: {} });
    await expect(call('apaczka_get_service_structure', {})).rejects.toThrow(/Invalid signature/);
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { status: 400, message: 'Brak wyceny dla podanych parametrów zamówienia.', response: null },
      headers: {},
    });
    await expect(
      call('apaczka_get_order_valuation', { sender: SENDER, receiver: RECEIVER, shipment: PARCEL }),
    ).rejects.toThrow(/Brak wyceny/);
    ok({ services: [] });
    await expect(call('apaczka_get_service_structure', {})).resolves.toBeDefined();
  });

  it('probes the service structure and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'apaczka_get_service_structure', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^apaczka_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('POSTs a form with one request field on the documented routes, all with a trailing slash', () => {
    const routes: Record<string, string> = {
      apaczka_get_service_structure: '/service_structure/',
      apaczka_get_order_valuation: '/order_valuation/',
      apaczka_list_points: '/points/{type}/',
      apaczka_list_orders: '/orders/',
      apaczka_get_order: '/order/{order_id}/',
      apaczka_get_waybill: '/waybill/{order_id}/',
      apaczka_get_dispatch_code: '/dispatch_code/{order_id}/',
      apaczka_get_turn_in: '/turn_in/',
      apaczka_get_pickup_hours: '/pickup_hours/',
      apaczka_track_shipment: '/tracking/{waybill}/',
      apaczka_send_order: '/order_send/',
      apaczka_cancel_order: '/cancel_order/{order_id}/',
      apaczka_order_pickup: '/pickup/{order_id}/',
      apaczka_order_batch_pickup: '/batch_pickup/',
    };
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(routes).sort());
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.endpointMapping.path).toBe(routes[entry.name]);
      expect(entry.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(Object.keys(entry.endpointMapping.bodyMapping!)).toEqual(['request']);
      expect(entry.endpointMapping.bodyMapping!.request).toHaveProperty('__json');
    }
  });

  it('marks the reads read-only and installs buying, cancelling and pickups switched off', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['apaczka_cancel_order', 'apaczka_order_batch_pickup', 'apaczka_order_pickup', 'apaczka_send_order']);
    for (const entry of a.tools) {
      const write = off.includes(entry.name);
      expect(annotationsOf(entry).readOnlyHint === true).toBe(!write);
    }
    // Nothing else reaches a route that buys, cancels or registers.
    const paid = ['/order_send/', '/cancel_order/', '/pickup/', '/batch_pickup/', '/customer_register/'];
    for (const entry of a.tools.filter((t) => t.enabled !== false)) {
      for (const route of paid) expect(entry.endpointMapping.path.startsWith(route)).toBe(false);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).toMatch(/^## Apaczka/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, a.description, ...a.tools.map((t) => t.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
  });

  it('lists orders with the documented form fields and signature', async () => {
    ok({ orders: [] });
    await call('apaczka_list_orders', {});
    const req = sent();
    expect(req.url).toBe('https://www.apaczka.pl/api/v2/orders/');
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    const f = form();
    expect([...f.keys()].sort()).toEqual(['app_id', 'expires', 'request', 'signature']);
    expect(f.get('app_id')).toBe(ENV.APACZKA_APP_ID);
    expect(f.get('request')).toBe('{"page":1,"limit":10}');
    expect(f.get('expires')).toBe(EXPIRES);
    expect(f.get('signature')).toBe(documentedSignature('orders/', '{"page":1,"limit":10}'));
    // Computed with PHP and the SDK's formula (rest.engine.form-signing.spec.ts).
    expect(f.get('signature')).toBe('835cb65245fb67c067d3b84b100e55f29a1f548ea022ca62bfcebfc8a5231a51');
    expect(Number(f.get('expires')) - NOW_S).toBeLessThanOrEqual(900);
  });

  it('puts path parameters into the signed route and sends {} for the empty payloads', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['apaczka_get_service_structure', {}, 'service_structure/'],
      ['apaczka_get_order', { order_id: 467840212 }, 'order/467840212/'],
      ['apaczka_get_waybill', { order_id: 467840212 }, 'waybill/467840212/'],
      ['apaczka_get_dispatch_code', { order_id: 467840212 }, 'dispatch_code/467840212/'],
      ['apaczka_track_shipment', { waybill: '0000000012345' }, 'tracking/0000000012345/'],
      ['apaczka_cancel_order', { order_id: 467840212 }, 'cancel_order/467840212/'],
    ];
    for (const [name, params, route] of cases) {
      ok();
      await call(name, params);
      expect(sent().url).toBe(`https://www.apaczka.pl/api/v2/${route}`);
      expect(form().get('request')).toBe('{}');
      expect(form().get('signature')).toBe(documentedSignature(route, '{}'));
    }
  });

  it('builds the request JSON of points, pickup hours, turn-in and the pickups as documented', async () => {
    ok();
    await call('apaczka_list_points', { type: 'INPOST' });
    expect(sent().url).toBe('https://www.apaczka.pl/api/v2/points/INPOST/');
    expect(form().get('request')).toBe('{"country_code":"PL"}');
    expect(form().get('signature')).toBe(documentedSignature('points/INPOST/', '{"country_code":"PL"}'));

    ok();
    await call('apaczka_get_pickup_hours', { postal_code: '05-500', service_id: 65, remove_index: false });
    expect(JSON.parse(form().get('request')!)).toEqual({ postal_code: '05-500', service_id: 65, remove_index: false });

    ok();
    await call('apaczka_get_turn_in', { order_ids: [467840212, 467840211] });
    expect(form().get('request')).toBe('{"order_ids":[467840212,467840211]}');

    ok();
    await call('apaczka_order_pickup', { order_id: 467840212, date: '2026-07-21', hour_from: '09:00', hour_to: '15:00' });
    expect(sent().url).toBe('https://www.apaczka.pl/api/v2/pickup/467840212/');
    expect(JSON.parse(form().get('request')!)).toEqual({ date: '2026-07-21', hour_from: '09:00', hour_to: '15:00' });

    ok();
    await call('apaczka_order_batch_pickup', { order_ids: [1, 2], date: '2026-07-21', hour_from: '09:00', hour_to: '15:00' });
    expect(JSON.parse(form().get('request')!)).toEqual({ order_ids: [1, 2], date: '2026-07-21', hour_from: '09:00', hour_to: '15:00' });
  });

  it('wraps valuation and order fields in order, with a SELF pickup by default', async () => {
    ok({ price_table: {} });
    await call('apaczka_get_order_valuation', { sender: SENDER, receiver: RECEIVER, shipment: PARCEL, content: 'Elektronika' });
    const valuation = form().get('request')!;
    expect(JSON.parse(valuation)).toEqual({
      order: {
        address: { sender: SENDER, receiver: RECEIVER },
        pickup: { type: 'SELF' },
        shipment: PARCEL,
        content: 'Elektronika',
      },
    });
    expect(form().get('signature')).toBe(documentedSignature('order_valuation/', valuation));

    ok({ order: { id: 1 } });
    await call('apaczka_send_order', {
      service_id: 65,
      sender: SENDER,
      receiver: { ...RECEIVER, foreign_address_id: 'WAW01M' },
      shipment: PARCEL,
      pickup: { type: 'COURIER', date: '2026-07-21', hours_from: '09:00', hours_to: '15:00' },
      cod: { amount: 15000, currency: 'PLN', bankaccount_id: 3 },
      shipment_value: 15000,
      option: { '19': 1 },
      content: 'Elektronika',
      comment: 'Ostroznie',
      push_tracking_url: 'https://example.com/apaczka/tracking',
    });
    expect(sent().url).toBe('https://www.apaczka.pl/api/v2/order_send/');
    expect(JSON.parse(form().get('request')!)).toEqual({
      order: {
        service_id: 65,
        address: { sender: SENDER, receiver: { ...RECEIVER, foreign_address_id: 'WAW01M' } },
        pickup: { type: 'COURIER', date: '2026-07-21', hours_from: '09:00', hours_to: '15:00' },
        shipment: PARCEL,
        content: 'Elektronika',
        comment: 'Ostroznie',
        cod: { amount: 15000, currency: 'PLN', bankaccount_id: 3 },
        shipment_value: 15000,
        option: { '19': 1 },
        push_tracking_url: 'https://example.com/apaczka/tracking',
      },
    });
    expect(form().get('signature')).toBe(documentedSignature('order_send/', form().get('request')!));
  });
});

// Opt-in: RUN_APACZKA_LIVE=1. The refusal check needs no account; the reads
// need APACZKA_APP_ID and APACZKA_APP_SECRET. Nothing is written.
const live = process.env.RUN_APACZKA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const signedForm = (appId: string, secret: string, route: string, request: string) => {
  const expires = String(Math.floor(Date.now() / 1000) + 600);
  const signature = createHmac('sha256', secret).update(`${appId}:${route}:${request}:${expires}`).digest('hex');
  return new URLSearchParams({ app_id: appId, request, expires, signature }).toString();
};
(live ? describe : describe.skip)('apaczka: live', () => {
  const post = (route: string, body: string) =>
    liveFetch.post(`https://www.apaczka.pl/api/v2/${route}`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'AnythingMCP' },
      validateStatus: () => true,
    });

  it('refuses a wrong signature inside an HTTP 200', async () => {
    const response = await post('service_structure/', signedForm('not-an-app', 'not-a-secret', 'service_structure/', '{}'));
    expect(response.status).toBe(200);
    expect(response.data.status).not.toBe(200);
  });

  it('reads the service structure and one page of orders', async () => {
    const id = process.env.APACZKA_APP_ID;
    const secret = process.env.APACZKA_APP_SECRET;
    if (!id || !secret) throw new Error('Set APACZKA_APP_ID and APACZKA_APP_SECRET for the live check');
    const structure = await post('service_structure/', signedForm(id, secret, 'service_structure/', '{}'));
    expect(structure.data.status).toBe(200);
    const orders = await post('orders/', signedForm(id, secret, 'orders/', '{"page":1,"limit":1}'));
    expect(orders.data.status).toBe(200);
  });
});
