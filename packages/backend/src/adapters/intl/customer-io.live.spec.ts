import axios from 'axios';
import * as adapter from './customer-io.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { checkBaseUrlValue } from '../../common/base-url-variable.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Customer.io adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the App API key, the US / EU
 *      address variable, every tool's method, URL, query and body through the
 *      real RestEngine, checked against Customer.io's App API OpenAPI document
 *      (docs.customer.io/files/journeys-app.json, read 14 Oct 2026). Also which
 *      tools only read and that both sends demand confirmation.
 *
 *   2. Live: skipped unless RUN_CUSTOMER_IO_LIVE=1. Without credentials it
 *      checks that both regions refuse a wrong key with 401. With
 *      CUSTOMERIO_API_URL and CUSTOMERIO_APP_API_KEY it reads workspaces,
 *      segments, automations, broadcasts and recent deliveries, shaped by each
 *      tool's response mapping as production does. Nothing is sent unless
 *      RUN_CUSTOMER_IO_LIVE_WRITES=1, CUSTOMERIO_TEST_EMAIL and
 *      CUSTOMERIO_TEST_TRANSACTIONAL_ID are set too: then one transactional
 *      email goes to that test address. Broadcasts are never triggered here.
 *
 *        RUN_CUSTOMER_IO_LIVE=1 CUSTOMERIO_API_URL=https://api.customer.io \
 *          CUSTOMERIO_APP_API_KEY=... npx jest src/adapters/intl/customer-io.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://api.customer.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'f' + '0'.repeat(31);
const ENV: Record<string, string> = { CUSTOMERIO_API_URL: `${HOST}/`, CUSTOMERIO_APP_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['customer_io_send_transactional_email', 'customer_io_trigger_broadcast'];

describe('customer-io adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the App API key as a Bearer token on the regional App API', () => {
    expect(a.category).toBe('marketing-automation');
    expect(a.icon).toBe('customer-io');
    expect(a.connector.baseUrl).toBe('{{CUSTOMERIO_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CUSTOMERIO_APP_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/workspaces');
    expect(a.requiredEnvVars).toEqual(['CUSTOMERIO_API_URL', 'CUSTOMERIO_APP_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.CUSTOMERIO_API_URL).toMatchObject({ kind: 'address', required: true });
    expect(meta.CUSTOMERIO_APP_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    // The Track API needs a different credential and is documented as out of scope.
    expect(a.instructions).toMatch(/Track API .* not part of this connector/);
  });

  it('accepts the US and EU App API hosts and refuses paths and other hosts', () => {
    const url = new RegExp(a.envVarMeta.CUSTOMERIO_API_URL.pattern!);
    for (const ok of [HOST, `${HOST}/`, 'https://api-eu.customer.io', 'api-eu.customer.io']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', `${HOST}/v1`, 'https://track.customer.io', 'https://fly.customer.io', 'http://api.customer.io', 'https://api.customer.io.evil.example']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(checkBaseUrlValue('api-eu.customer.io')).toEqual({ ok: true, value: 'https://api-eu.customer.io' });
  });

  it('probes with the workspace list and explains wrong keys and regions', () => {
    expect(a.probe).toEqual({ tool: 'customer_io_list_workspaces' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/api-eu/);
  });

  it('prefixes every tool with customer_io_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^customer_io_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the POST customer search read-only and makes both sends ask for confirmation', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('customer_io_search_customers'))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of WRITES) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/real/);
      expect(tool(name).description).toMatch(/only after the user/);
    }
    expect(tool('customer_io_trigger_broadcast').description).toContain('"yes, send"');
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcustomer_io_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcustomer_io_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('App API Keys');
    expect(a.instructions).toMatch(/10 requests per second/);
    expect(a.instructions).toMatch(/one every 10 seconds/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every read a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['customer_io_list_workspaces', {}, 'GET', '/v1/workspaces'],
    ['customer_io_find_customers_by_email', { email: 'ada@example.com' }, 'GET', '/v1/customers'],
    ['customer_io_search_customers', { filter: { segment: { id: 4 } } }, 'POST', '/v1/customers'],
    ['customer_io_get_customer_attributes', { customer_id: 'u1' }, 'GET', '/v1/customers/u1/attributes'],
    ['customer_io_get_customer_segments', { customer_id: 'u1' }, 'GET', '/v1/customers/u1/segments'],
    ['customer_io_list_customer_activities', { customer_id: 'u1' }, 'GET', '/v1/customers/u1/activities'],
    ['customer_io_list_customer_messages', { customer_id: 'u1' }, 'GET', '/v1/customers/u1/messages'],
    ['customer_io_list_campaigns', {}, 'GET', '/v1/campaigns'],
    ['customer_io_get_campaign', { campaign_id: 7 }, 'GET', '/v1/campaigns/7'],
    ['customer_io_get_campaign_metrics', { campaign_id: 7, start: 1759276800, end: 1760400000 }, 'GET', '/v1/campaigns/7/metrics'],
    ['customer_io_list_broadcasts', {}, 'GET', '/v1/broadcasts'],
    ['customer_io_get_broadcast', { broadcast_id: 3 }, 'GET', '/v1/broadcasts/3'],
    ['customer_io_get_broadcast_metrics', { broadcast_id: 3 }, 'GET', '/v1/broadcasts/3/metrics'],
    ['customer_io_get_broadcast_trigger', { broadcast_id: 3, trigger_id: 9 }, 'GET', '/v1/campaigns/3/triggers/9'],
    ['customer_io_list_newsletters', {}, 'GET', '/v1/newsletters'],
    ['customer_io_get_newsletter_metrics', { newsletter_id: 5 }, 'GET', '/v1/newsletters/5/metrics'],
    ['customer_io_list_segments', {}, 'GET', '/v1/segments'],
    ['customer_io_get_segment', { segment_id: 4 }, 'GET', '/v1/segments/4'],
    ['customer_io_get_segment_customer_count', { segment_id: 4 }, 'GET', '/v1/segments/4/customer_count'],
    ['customer_io_list_segment_members', { segment_id: 4 }, 'GET', '/v1/segments/4/membership'],
    ['customer_io_list_messages', {}, 'GET', '/v1/messages'],
    ['customer_io_get_message', { message_id: 'dgOq' }, 'GET', '/v1/messages/dgOq'],
    ['customer_io_list_activities', {}, 'GET', '/v1/activities'],
    ['customer_io_list_transactional_messages', {}, 'GET', '/v1/transactional'],
    ['customer_io_send_transactional_email', { to: 'ada@example.com', transactional_message_id: 2 }, 'POST', '/v1/send/email'],
    ['customer_io_trigger_broadcast', { broadcast_id: 3 }, 'POST', '/v1/campaigns/3/triggers'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('encodes emails used as customer ids and passes id_type', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('customer_io_get_customer_attributes', { customer_id: 'ada+news@example.com', id_type: 'email' });
    expect(sent().url).toBe(`${HOST}/v1/customers/ada%2Bnews%40example.com/attributes`);
    expect(sent().params).toEqual({ id_type: 'email' });
  });

  it('searches with the filter in the body and paging in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const filter = { and: [{ segment: { id: 4 } }, { attribute: { field: 'plan', operator: 'eq', value: 'pro' } }] };
    await call('customer_io_search_customers', { filter, limit: 100, start: 'n1' });
    expect(sent().data).toEqual({ filter });
    expect(sent().params).toEqual({ limit: 100, start: 'n1' });
  });

  it('asks for version 2 automation metrics with a daily resolution by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('customer_io_get_campaign_metrics', { campaign_id: 7, start: 1759276800, end: 1760400000, tz: 'Europe/Berlin', type: 'email' });
    expect(sent().params).toEqual({ version: '2', start: 1759276800, end: 1760400000, res: 'daily', tz: 'Europe/Berlin', type: 'email' });
    mockedAxios.mockClear();
    await call('customer_io_list_segment_members', { segment_id: 4 });
    expect(sent().params).toEqual({ limit: 100 });
  });

  it('builds the transactional email and broadcast trigger bodies as documented', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('customer_io_send_transactional_email', {
      transactional_message_id: 2,
      to: 'ada@example.com',
      identifiers: { email: 'ada@example.com' },
      message_data: { code: '123' },
    });
    // The API takes the numeric id as a number and a trigger name as a string.
    expect(sent().data).toEqual({ transactional_message_id: 2, to: 'ada@example.com', identifiers: { email: 'ada@example.com' }, message_data: { code: '123' } });
    mockedAxios.mockClear();
    await call('customer_io_send_transactional_email', { transactional_message_id: 'pwdreset', to: 'ada@example.com', identifiers: { id: 'u1' } });
    expect(sent().data).toEqual({ transactional_message_id: 'pwdreset', to: 'ada@example.com', identifiers: { id: 'u1' } });
    expect(tool('customer_io_send_transactional_email').parameters.properties?.transactional_message_id).toMatchObject({ type: ['integer', 'string'] });
    mockedAxios.mockClear();
    await call('customer_io_trigger_broadcast', { broadcast_id: 3, emails: ['ada@example.com'], data: { promo: 'X' }, email_ignore_missing: true });
    expect(sent().data).toEqual({ emails: ['ada@example.com'], data: { promo: 'X' }, email_ignore_missing: true });
    mockedAxios.mockClear();
    await call('customer_io_trigger_broadcast', { broadcast_id: 3 });
    expect(sent().data).toEqual({});
  });

  it('keeps automation lists compact and pages through segment members', () => {
    const raw = {
      campaigns: [{ id: 1, name: 'Onboarding', type: 'segment', state: 'running', active: true, msg_templates: [{ id: 1, type: 'email' }], filter_object_attributes: { big: true } }],
    };
    const out = applyResponseTransform(raw, tool('customer_io_list_campaigns').responseMapping as any).value as any;
    expect(out).toEqual({ campaigns: [{ id: 1, name: 'Onboarding', type: 'segment', state: 'running', active: true }] });
    const members = { identifiers: [{ id: 'u1', email: 'ada@example.com', cio_id: 'c1' }], ids: ['u1'], next: 'n2' };
    expect(applyResponseTransform(members, tool('customer_io_list_segment_members').responseMapping as any).value).toEqual({
      identifiers: members.identifiers,
      next: 'n2',
    });
  });
});

const live = process.env.RUN_CUSTOMER_IO_LIVE === '1' ? describe : describe.skip;
live('customer-io adapter: live', () => {
  const real = !!(process.env.CUSTOMERIO_API_URL && process.env.CUSTOMERIO_APP_API_KEY);
  const env = () => ({ CUSTOMERIO_API_URL: process.env.CUSTOMERIO_API_URL!, CUSTOMERIO_APP_API_KEY: process.env.CUSTOMERIO_APP_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['https://api.customer.io', 'customer_io_list_workspaces'],
    ['https://api-eu.customer.io', 'customer_io_list_workspaces'],
    ['https://api.customer.io', 'customer_io_list_segments'],
  ])('%s refuses a wrong key with 401 (%s)', async (host, name) => {
    await expect(call(name, {}, { ...ENV, CUSTOMERIO_API_URL: host })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads workspaces, segments, automations, broadcasts and deliveries', async () => {
    const ws = await shaped('customer_io_list_workspaces', {}, env());
    expect(Array.isArray(ws.workspaces)).toBe(true);
    const segments = await shaped('customer_io_list_segments', {}, env());
    expect(Array.isArray(segments.segments)).toBe(true);
    if (segments.segments[0]) {
      const count = await shaped('customer_io_get_segment_customer_count', { segment_id: segments.segments[0].id }, env());
      expect(typeof count.count).toBe('number');
    }
    const campaigns = await shaped('customer_io_list_campaigns', {}, env());
    expect(Array.isArray(campaigns.campaigns)).toBe(true);
    const broadcasts = await shaped('customer_io_list_broadcasts', {}, env());
    expect(Array.isArray(broadcasts.broadcasts)).toBe(true);
    const messages = await shaped('customer_io_list_messages', { limit: 5 }, env());
    expect(Array.isArray(messages.messages)).toBe(true);
  }, 60000);

  const writes =
    real &&
    process.env.RUN_CUSTOMER_IO_LIVE_WRITES === '1' &&
    !!process.env.CUSTOMERIO_TEST_EMAIL &&
    !!process.env.CUSTOMERIO_TEST_TRANSACTIONAL_ID;
  (writes ? it : it.skip)('sends one transactional email to the test address', async () => {
    const out = await shaped(
      'customer_io_send_transactional_email',
      {
        transactional_message_id: process.env.CUSTOMERIO_TEST_TRANSACTIONAL_ID,
        to: process.env.CUSTOMERIO_TEST_EMAIL,
        identifiers: { email: process.env.CUSTOMERIO_TEST_EMAIL },
      },
      env(),
    );
    expect(out.delivery_id).toBeTruthy();
  }, 30000);
});
