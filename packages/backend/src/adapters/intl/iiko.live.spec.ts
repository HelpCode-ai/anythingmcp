import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './iiko.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyEnvDefaults, applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * iiko / Syrve adapter (iikoCloud API, Syrve Cloud API).
 *
 * Static checks always run: the LOGIN_TOKEN exchange (POST /api/1/access_token
 * with the API login in a JSON body, a 1-hour bearer token), the two API hosts
 * and the loyalty path segment that differs between them
 * (/api/1/loyalty/iiko/... on api-ru.iiko.services, /api/1/loyalty/syrve/...
 * on api-eu.syrve.live), every tool's method and path against the published
 * OpenAPI documents (https://api-ru.iiko.services/api-docs/docs and
 * https://api-eu.syrve.live/api-docs/docs), the JSON bodies, the default
 * organization, and which tools install switched off. No tool touches a
 * loyalty wallet or changes the payments of an order.
 *
 * Live checks run only with RUN_IIKO_LIVE=1. Without credentials they confirm
 * that both hosts refuse an unknown API login; with IIKO_API_LOGIN (and
 * IIKO_API_HOST, default the iiko host) they sign in through the real
 * LoginTokenService and read the organizations. Reads only.
 *
 *   RUN_IIKO_LIVE=1 IIKO_API_HOST=https://api-eu.syrve.live IIKO_API_LOGIN=... \
 *     npx jest src/adapters/intl/iiko.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    envDefaults?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
type Meta = { pattern?: string; kind?: string; secret?: boolean; options?: { value: string; label: string }[] };
const a = adapter as unknown as {
  slug: string;
  name: string;
  aliases: string[];
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, Meta>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, any>; headers?: Record<string, string> };
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
  return out;
};

const IIKO = 'https://api-ru.iiko.services';
const SYRVE = 'https://api-eu.syrve.live';
const ORG = '7bc05553-4b68-44e8-b7bc-37be63c6d9e9';
const ORG_2 = '11111111-2222-4333-8444-555555555555';
const TG = 'b090de0b-8550-6e17-70b2-bbba152bcbd3';
const ID = '550e8400-e29b-41d4-a716-446655440000';
// Built at runtime so no literal looks like a real credential.
const FAKE_LOGIN = ['0f1e2d3c', '4b5a', '6978', '8796', 'a5b4c3d2e1f0'].join('-');
const FAKE_TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'x'.repeat(24), 'y'.repeat(12)].join('.');
const ENV: Record<string, string> = {
  IIKO_API_HOST: IIKO,
  IIKO_LOYALTY_API: 'iiko',
  IIKO_API_LOGIN: FAKE_LOGIN,
};
const SYRVE_ENV: Record<string, string> = { ...ENV, IIKO_API_HOST: SYRVE, IIKO_LOYALTY_API: 'syrve' };
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const stubLogin = (token = FAKE_TOKEN) => {
  const bundle = async () => ({ token, expiresAt: Date.now() + 3_600_000 });
  return { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; the default organization, then the schema defaults, applied
// before the call.
const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin()).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, applyEnvDefaults(tool(name).endpointMapping, { ...env, ...params }, env)),
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const body = (req: { data: unknown }) => (typeof req.data === 'string' ? JSON.parse(req.data) : req.data);

// Every tool, its HTTP method and path, from the iikoCloud / Syrve Cloud API reference.
const ROUTES: Record<string, string> = {
  iiko_list_organizations: 'POST /api/1/organizations',
  iiko_list_terminal_groups: 'POST /api/1/terminal_groups',
  iiko_check_terminal_groups_alive: 'POST /api/1/terminal_groups/is_alive',
  iiko_get_nomenclature: 'POST /api/1/nomenclature',
  iiko_list_external_menus: 'POST /api/2/menu',
  iiko_get_external_menu: 'POST /api/2/menu/by_id',
  iiko_get_stop_lists: 'POST /api/1/stop_lists',
  iiko_list_order_types: 'POST /api/1/deliveries/order_types',
  iiko_list_payment_types: 'POST /api/1/payment_types',
  iiko_list_discounts: 'POST /api/1/discounts',
  iiko_list_cancel_causes: 'POST /api/1/cancel_causes',
  iiko_list_deliveries_by_date_and_status: 'POST /api/1/deliveries/by_delivery_date_and_status',
  iiko_list_deliveries_by_phone: 'POST /api/1/deliveries/by_delivery_date_and_phone',
  iiko_list_delivery_history_by_phone: 'POST /api/1/deliveries/history/by_delivery_date_and_phone',
  iiko_search_deliveries: 'POST /api/1/deliveries/by_delivery_date_and_source_key_and_filter',
  iiko_get_deliveries_by_id: 'POST /api/1/deliveries/by_id',
  iiko_get_table_orders_by_id: 'POST /api/1/order/by_id',
  iiko_list_table_orders_by_table: 'POST /api/1/order/by_table',
  iiko_list_reserve_terminal_groups: 'POST /api/1/reserve/available_terminal_groups',
  iiko_list_restaurant_sections: 'POST /api/1/reserve/available_restaurant_sections',
  iiko_list_reserves: 'POST /api/1/reserve/restaurant_sections_workload',
  iiko_get_reserves_by_id: 'POST /api/1/reserve/status_by_id',
  iiko_list_couriers: 'POST /api/1/employees/couriers',
  iiko_get_customer: 'POST /api/1/loyalty/{{IIKO_LOYALTY_API}}/customer/info',
  iiko_list_customer_categories: 'POST /api/1/loyalty/{{IIKO_LOYALTY_API}}/customer_category',
  iiko_list_loyalty_programs: 'POST /api/1/loyalty/{{IIKO_LOYALTY_API}}/program',
  iiko_list_customer_transactions: 'POST /api/1/loyalty/{{IIKO_LOYALTY_API}}/customer/transactions/by_date',
  iiko_create_or_update_customer: 'POST /api/1/loyalty/{{IIKO_LOYALTY_API}}/customer/create_or_update',
  iiko_get_command_status: 'POST /api/1/commands/status',
  iiko_create_delivery: 'POST /api/1/deliveries/create',
  iiko_cancel_delivery: 'POST /api/1/deliveries/cancel',
  iiko_add_to_stop_list: 'POST /api/1/stop_lists/add',
  iiko_remove_from_stop_list: 'POST /api/1/stop_lists/remove',
};
const WRITES = [
  'iiko_create_or_update_customer',
  'iiko_create_delivery',
  'iiko_cancel_delivery',
  'iiko_add_to_stop_list',
  'iiko_remove_from_stop_list',
];
const SWITCHED_OFF = ['iiko_add_to_stop_list', 'iiko_cancel_delivery', 'iiko_create_delivery', 'iiko_remove_from_stop_list'];

describe('iiko adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /api/1/access_token with LOGIN_TOKEN and sends a bearer token', () => {
    expect(a.slug).toBe('iiko');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('iiko');
    expect(a.aliases).toEqual(expect.arrayContaining(['Syrve', 'iikoCloud', 'Syrve Cloud']));
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{IIKO_API_HOST}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: '{{IIKO_API_HOST}}/api/1/access_token',
      loginMethod: 'POST',
      loginHeaders: { 'Content-Type': 'application/json', Accept: 'application/json' },
      loginBody: { apiLogin: '${username}' },
      username: '{{IIKO_API_LOGIN}}',
      password: '{{IIKO_API_LOGIN}}',
      tokenJsonPath: 'token',
      tokenTTLSeconds: 3600,
      proactiveRefreshSeconds: 300,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(a.requiredEnvVars).toEqual(['IIKO_API_HOST', 'IIKO_LOYALTY_API', 'IIKO_API_LOGIN']);
    expect(a.optionalEnvVars).toEqual(['IIKO_ORGANIZATION_ID']);
  });

  it('offers the iiko and Syrve hosts and the matching loyalty path as fixed choices', () => {
    const host = a.envVarMeta.IIKO_API_HOST;
    expect(host.kind).toBe('address');
    expect(host.secret).toBeUndefined();
    expect(host.options!.map((o) => o.value)).toEqual([IIKO, SYRVE]);
    for (const option of host.options!) expect(new RegExp(host.pattern!).test(option.value)).toBe(true);
    expect(new RegExp(host.pattern!).test('https://api-eu.iiko.services')).toBe(false);

    const loyalty = a.envVarMeta.IIKO_LOYALTY_API;
    expect(loyalty.secret).toBeUndefined();
    expect(loyalty.options!.map((o) => o.value)).toEqual(['iiko', 'syrve']);
    for (const option of loyalty.options!) expect(new RegExp(loyalty.pattern!).test(option.value)).toBe(true);

    const login = a.envVarMeta.IIKO_API_LOGIN;
    expect(login).toMatchObject({ kind: 'credential', secret: true });
    expect(login.options).toBeUndefined();
    expect(new RegExp(login.pattern!).test(FAKE_LOGIN)).toBe(true);
    expect(new RegExp(login.pattern!).test('abc12345')).toBe(true);
    for (const bad of ['', 'has space here']) expect(new RegExp(login.pattern!).test(bad)).toBe(false);

    const org = a.envVarMeta.IIKO_ORGANIZATION_ID;
    expect(org.secret).toBeUndefined();
    expect(org.kind).toBe('setting');
    expect(new RegExp(org.pattern!).test(ORG)).toBe(true);
    expect(new RegExp(org.pattern!).test('12345')).toBe(false);
  });

  it('posts the API login as JSON to the chosen host and reads the 1-hour token', async () => {
    for (const env of [ENV, SYRVE_ENV]) {
      const auth = interpolateDeep(a.connector.authConfig, env) as any;
      mockedAxios.mockResolvedValueOnce({ data: { correlationId: ID, token: FAKE_TOKEN }, headers: {} });
      const bundle = await new LoginTokenService({} as PrismaService, config).getToken(auth);
      const login = sent();
      expect(String(login.method).toUpperCase()).toBe('POST');
      expect(login.url).toBe(`${env.IIKO_API_HOST}/api/1/access_token`);
      expect(body(login)).toEqual({ apiLogin: FAKE_LOGIN });
      expect(header(login, 'Content-Type')).toBe('application/json');
      expect(header(login, 'Authorization')).toBeUndefined();
      expect(bundle.token).toBe(FAKE_TOKEN);
      expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
      expect(bundle.expiresAt - Date.now()).toBeGreaterThan(3_000_000);
    }
  });

  it('sends the bearer token and JSON headers on every call', async () => {
    ok();
    await call('iiko_list_organizations', {});
    const req = sent();
    expect(req.url).toBe(`${IIKO}/api/1/organizations`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(header(req, 'Accept')).toBe('application/json');
    expect(header(req, 'Content-Type')).toBe('application/json');
    expect(body(req)).toEqual({ returnAdditionalInfo: true });
  });

  it('probes the organization list and explains 400, 401, 403, 404, 408 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'iiko_list_organizations', params: { return_additional_info: false } });
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', '408', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatchObject({ field: 'IIKO_API_LOGIN' });
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^iiko_[a-z0-9_]+$/);
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

  it('fills a single organization from IIKO_ORGANIZATION_ID and never requires that parameter', () => {
    for (const entry of a.tools) {
      const properties = entry.parameters.properties ?? {};
      if ('organization_id' in properties) {
        expect(entry.endpointMapping.envDefaults).toEqual({ organization_id: 'IIKO_ORGANIZATION_ID' });
        expect(entry.parameters.required ?? []).not.toContain('organization_id');
      } else {
        expect(entry.endpointMapping.envDefaults).toBeUndefined();
      }
      if ('organization_ids' in properties && entry.name !== 'iiko_list_organizations') {
        expect(entry.parameters.required).toContain('organization_ids');
      }
    }
  });

  it('marks the POST reads read-only, installs order and stop-list changes switched off, and touches no wallet or payment', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      const write = WRITES.includes(entry.name);
      expect(annotationsOf(entry).readOnlyHint).toBe(!write);
      if (write) expect(entry.annotations).toBeUndefined();
      else expect(entry.annotations).toEqual({ readOnlyHint: true });
      expect(entry.endpointMapping.path).not.toContain('wallet');
      expect(entry.endpointMapping.path).not.toContain('payments');
      expect(entry.endpointMapping.path).not.toContain('/delete');
      expect(entry.endpointMapping.path).not.toContain('send_sms');
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const name of SWITCHED_OFF) expect(tool(name).description).toContain('Installed switched off');
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    for (const fact of ['IIKO_API_LOGIN', 'IIKO_API_HOST', 'IIKO_LOYALTY_API', 'IIKO_ORGANIZATION_ID', 'api-ru.iiko.services', 'api-eu.syrve.live', '/api/1/access_token']) {
      expect(a.instructions).toContain(fact);
    }
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads terminal groups, menus and stop lists with the documented bodies', async () => {
    ok();
    await call('iiko_list_terminal_groups', { organization_ids: [ORG, ORG_2] });
    expect(sent().url).toBe(`${IIKO}/api/1/terminal_groups`);
    expect(body(sent())).toEqual({ organizationIds: [ORG, ORG_2] });

    ok();
    await call('iiko_check_terminal_groups_alive', { organization_ids: [ORG], terminal_group_ids: [TG] });
    expect(sent().url).toBe(`${IIKO}/api/1/terminal_groups/is_alive`);
    expect(body(sent())).toEqual({ organizationIds: [ORG], terminalGroupIds: [TG] });

    ok();
    await call('iiko_get_nomenclature', { organization_id: ORG, start_revision: 0 });
    expect(sent().url).toBe(`${IIKO}/api/1/nomenclature`);
    expect(body(sent())).toEqual({ organizationId: ORG, startRevision: 0 });
    expect(header(sent(), 'Timeout')).toBe('45');

    ok();
    await call('iiko_list_external_menus', {});
    expect(sent().url).toBe(`${IIKO}/api/2/menu`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(body(sent())).toEqual({});

    ok();
    await call('iiko_get_external_menu', { external_menu_id: '12345', organization_ids: [ORG], version: 2 });
    expect(sent().url).toBe(`${IIKO}/api/2/menu/by_id`);
    expect(body(sent())).toEqual({ externalMenuId: '12345', organizationIds: [ORG], version: 2 });

    ok();
    await call('iiko_get_stop_lists', { organization_ids: [ORG], terminal_group_ids: [TG], return_size: true });
    expect(sent().url).toBe(`${IIKO}/api/1/stop_lists`);
    expect(body(sent())).toEqual({ organizationIds: [ORG], terminalGroupsIds: [TG], returnSize: true });
  });

  it('reads delivery orders, table orders and reserves with the documented bodies', async () => {
    ok();
    await call('iiko_list_deliveries_by_date_and_status', {
      organization_ids: [ORG],
      delivery_date_from: '2026-11-19 00:00:00.000',
      delivery_date_to: '2026-11-19 23:59:59.999',
      statuses: ['OnWay', 'Delivered'],
    });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/by_delivery_date_and_status`);
    expect(body(sent())).toEqual({
      organizationIds: [ORG],
      deliveryDateFrom: '2026-11-19 00:00:00.000',
      deliveryDateTo: '2026-11-19 23:59:59.999',
      statuses: ['OnWay', 'Delivered'],
    });

    ok();
    await call('iiko_list_deliveries_by_phone', { organization_ids: [ORG], phone: '+971501234567' });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/by_delivery_date_and_phone`);
    expect(body(sent())).toEqual({ organizationIds: [ORG], phone: '+971501234567' });

    ok();
    await call('iiko_list_delivery_history_by_phone', { organization_ids: [ORG], phone: '+971501234567' });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/history/by_delivery_date_and_phone`);
    expect(body(sent())).toEqual({ organizationIds: [ORG], phone: '+971501234567', rowsCount: 50 });

    ok();
    await call('iiko_search_deliveries', { organization_ids: [ORG], search_text: 'Anna', has_problem: false });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/by_delivery_date_and_source_key_and_filter`);
    expect(body(sent())).toEqual({
      organizationIds: [ORG],
      searchText: 'Anna',
      hasProblem: false,
      sortProperty: 'CompleteBefore',
      sortDirection: 'Descending',
      rowsCount: 50,
    });

    ok();
    await call('iiko_get_deliveries_by_id', { organization_id: ORG, order_ids: [ID] });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/by_id`);
    expect(body(sent())).toEqual({ organizationId: ORG, orderIds: [ID] });

    ok();
    await call('iiko_list_table_orders_by_table', { organization_ids: [ORG], table_ids: [ID], statuses: ['New', 'Bill'] });
    expect(sent().url).toBe(`${IIKO}/api/1/order/by_table`);
    expect(body(sent())).toEqual({ organizationIds: [ORG], tableIds: [ID], statuses: ['New', 'Bill'] });

    ok();
    await call('iiko_list_restaurant_sections', { terminal_group_ids: [TG] });
    expect(sent().url).toBe(`${IIKO}/api/1/reserve/available_restaurant_sections`);
    expect(body(sent())).toEqual({ terminalGroupIds: [TG] });

    ok();
    await call('iiko_list_reserves', { restaurant_section_ids: [ID], date_from: '2026-11-19 00:00:00.000' });
    expect(sent().url).toBe(`${IIKO}/api/1/reserve/restaurant_sections_workload`);
    expect(body(sent())).toEqual({ restaurantSectionIds: [ID], dateFrom: '2026-11-19 00:00:00.000' });

    ok();
    await call('iiko_get_reserves_by_id', { organization_id: ORG, reserve_ids: [ID] });
    expect(sent().url).toBe(`${IIKO}/api/1/reserve/status_by_id`);
    expect(body(sent())).toEqual({ organizationId: ORG, reserveIds: [ID] });
  });

  it('uses the default organization when a call names none, and the given one otherwise', async () => {
    const env = { ...ENV, IIKO_ORGANIZATION_ID: ORG };
    ok();
    await call('iiko_get_command_status', { correlation_id: ID }, env);
    expect(sent().url).toBe(`${IIKO}/api/1/commands/status`);
    expect(body(sent())).toEqual({ organizationId: ORG, correlationId: ID });

    ok();
    await call('iiko_get_command_status', { organization_id: ORG_2, correlation_id: ID }, env);
    expect(body(sent())).toEqual({ organizationId: ORG_2, correlationId: ID });

    ok();
    await call('iiko_get_command_status', { correlation_id: ID });
    expect(body(sent())).toEqual({ correlationId: ID });
  });

  it('calls the loyalty API under /loyalty/iiko on iiko and under /loyalty/syrve on Syrve', async () => {
    ok();
    await call('iiko_get_customer', { organization_id: ORG, phone: '+971501234567' });
    expect(sent().url).toBe(`${IIKO}/api/1/loyalty/iiko/customer/info`);
    expect(body(sent())).toEqual({ organizationId: ORG, type: 'phone', phone: '+971501234567' });

    ok();
    await call('iiko_get_customer', { organization_id: ORG, type: 'email', email: 'anna@example.org' }, SYRVE_ENV);
    expect(sent().url).toBe(`${SYRVE}/api/1/loyalty/syrve/customer/info`);
    expect(body(sent())).toEqual({ organizationId: ORG, type: 'email', email: 'anna@example.org' });

    ok();
    await call('iiko_list_loyalty_programs', { organization_id: ORG, without_marketing_campaigns: true }, SYRVE_ENV);
    expect(sent().url).toBe(`${SYRVE}/api/1/loyalty/syrve/program`);
    expect(body(sent())).toEqual({ organizationId: ORG, withoutMarketingCampaigns: true });

    ok();
    await call('iiko_list_customer_categories', { organization_id: ORG });
    expect(sent().url).toBe(`${IIKO}/api/1/loyalty/iiko/customer_category`);

    ok();
    await call('iiko_list_customer_transactions', {
      organization_id: ORG,
      customer_id: ID,
      date_from: '2026-11-01 00:00:00.000',
      date_to: '2026-11-19 23:59:59.999',
    });
    expect(sent().url).toBe(`${IIKO}/api/1/loyalty/iiko/customer/transactions/by_date`);
    expect(body(sent())).toEqual({
      organizationId: ORG,
      customerId: ID,
      dateFrom: '2026-11-01 00:00:00.000',
      dateTo: '2026-11-19 23:59:59.999',
      pageNumber: 0,
      pageSize: 100,
    });

    ok();
    await call('iiko_create_or_update_customer', { organization_id: ORG, phone: '+971501234567', name: 'Anna', surname: 'Keller', consent_status: 1 }, SYRVE_ENV);
    expect(sent().url).toBe(`${SYRVE}/api/1/loyalty/syrve/customer/create_or_update`);
    expect(body(sent())).toEqual({ organizationId: ORG, phone: '+971501234567', name: 'Anna', surName: 'Keller', consentStatus: 1 });
  });

  it('builds the delivery and stop-list commands as iiko documents them', async () => {
    const order = { phone: '+971501234567', orderServiceType: 'DeliveryByClient', items: [{ type: 'Product', productId: ID, amount: 1 }] };
    ok();
    await call('iiko_create_delivery', { organization_id: ORG, terminal_group_id: TG, order });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/create`);
    expect(body(sent())).toEqual({ organizationId: ORG, terminalGroupId: TG, order });

    ok();
    await call('iiko_cancel_delivery', { organization_id: ORG, order_id: ID, cancel_cause_id: ORG_2, cancel_comment: 'Guest called' });
    expect(sent().url).toBe(`${IIKO}/api/1/deliveries/cancel`);
    expect(body(sent())).toEqual({ organizationId: ORG, orderId: ID, cancelCauseId: ORG_2, cancelComment: 'Guest called' });

    ok();
    await call('iiko_add_to_stop_list', { organization_id: ORG, terminal_group_id: TG, items: [{ productId: ID, balance: 0 }] });
    expect(sent().url).toBe(`${IIKO}/api/1/stop_lists/add`);
    expect(body(sent())).toEqual({ organizationId: ORG, terminalGroupId: TG, items: [{ productId: ID, balance: 0 }] });

    ok();
    await call('iiko_remove_from_stop_list', { organization_id: ORG, terminal_group_id: TG, items: [{ productId: ID }] });
    expect(sent().url).toBe(`${IIKO}/api/1/stop_lists/remove`);
    expect(body(sent())).toEqual({ organizationId: ORG, terminalGroupId: TG, items: [{ productId: ID }] });
  });

  it('keeps the date and id patterns as the API documents them', () => {
    const dateFrom = tool('iiko_list_deliveries_by_date_and_status').parameters.properties!.delivery_date_from;
    expect(new RegExp(dateFrom.pattern!).test('2026-11-19 00:00:00.000')).toBe(true);
    expect(new RegExp(dateFrom.pattern!).test('2026-11-19T00:00:00Z')).toBe(false);
    const orderId = tool('iiko_cancel_delivery').parameters.properties!.order_id;
    expect(new RegExp(orderId.pattern!).test(ID)).toBe(true);
    expect(new RegExp(orderId.pattern!).test(ID.toUpperCase())).toBe(true);
    expect(new RegExp(orderId.pattern!).test('12345')).toBe(false);
  });
});

// Opt-in: RUN_IIKO_LIVE=1. The refusal check needs no account; the read needs
// IIKO_API_LOGIN (and IIKO_API_HOST for Syrve). Nothing is written.
const live = process.env.RUN_IIKO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('iiko: live', () => {
  it('refuses an unknown API login on both hosts', async () => {
    for (const host of [IIKO, SYRVE]) {
      const response = await liveFetch.post(
        `${host}/api/1/access_token`,
        { apiLogin: 'not-an-api-login' },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, validateStatus: () => true },
      );
      expect(`${host} ${response.status}`).toBe(`${host} 401`);
      expect(String(response.data?.errorDescription ?? '')).toMatch(/not authorized/i);
    }
  });

  it('signs in through LoginTokenService and reads the organizations', async () => {
    const apiLogin = process.env.IIKO_API_LOGIN;
    if (!apiLogin) throw new Error('Set IIKO_API_LOGIN (and IIKO_API_HOST for Syrve) for the live check');
    const host = process.env.IIKO_API_HOST || IIKO;
    mockedAxios.mockImplementation((cfg: unknown) => (liveFetch as unknown as (c: unknown) => Promise<unknown>)(cfg));
    const env = { IIKO_API_HOST: host, IIKO_LOYALTY_API: host === SYRVE ? 'syrve' : 'iiko', IIKO_API_LOGIN: apiLogin };
    const login = new LoginTokenService(
      { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
      config,
    );
    const bundle = await login.getToken(interpolateDeep(a.connector.authConfig, env) as never);
    expect(bundle.token.length).toBeGreaterThan(20);
    const response = await liveFetch.post(
      `${host}/api/1/organizations`,
      { returnAdditionalInfo: false },
      { headers: { Authorization: `Bearer ${bundle.token}`, 'Content-Type': 'application/json' }, validateStatus: () => true },
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data.organizations)).toBe(true);
    mockedAxios.mockReset();
  });
});
