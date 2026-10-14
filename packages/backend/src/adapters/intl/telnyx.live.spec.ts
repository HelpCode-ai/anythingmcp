import axios from 'axios';
import * as adapter from './telnyx.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Telnyx adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the API key, the balance
 *      healthcheck, and every tool's method, URL, query and body through the
 *      real RestEngine, checked against Telnyx's OpenAPI document
 *      (github.com/team-telnyx/openapi, openapi/spec3.json) and the
 *      generated Node SDK (read 14 Oct 2026). Also which tools only read,
 *      that every paid action asks for confirmation, that buying numbers
 *      ships switched off and that response mappings drop secrets.
 *
 *   2. Live: skipped unless RUN_TELNYX_LIVE=1. Without a key it checks that
 *      Telnyx refuses a wrong key with 401 on the real routes. With
 *      TELNYX_API_KEY it reads balance, numbers, messaging profiles,
 *      applications, verify profiles, recordings, detail records and AI
 *      assistants, shaped by each tool's response mapping as production does.
 *      Nothing that costs money runs unless RUN_TELNYX_LIVE_WRITES=1 and
 *      TELNYX_TEST_FROM, TELNYX_TEST_TO are set too: then one SMS is sent
 *      from the test number to the test recipient (billed).
 *
 *        RUN_TELNYX_LIVE=1 TELNYX_API_KEY=KEY... \
 *          npx jest src/adapters/intl/telnyx.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
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
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://api.telnyx.com/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'KEY' + '0'.repeat(32) + '_' + 'a'.repeat(22);
const ENV: Record<string, string> = { TELNYX_API_KEY: FAKE_KEY };

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
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];

// Each of these costs money or reaches a real person.
const PAID = ['telnyx_dial_call', 'telnyx_order_phone_numbers', 'telnyx_send_message', 'telnyx_send_verification', 'telnyx_speak_text'];
const WRITES = [...PAID, 'telnyx_check_verification_code', 'telnyx_hangup_call'].sort();

describe('telnyx adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the API key as a Bearer token and checks it on /balance', () => {
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('telnyx');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TELNYX_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/balance');
    expect(a.requiredEnvVars).toEqual(['TELNYX_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.TELNYX_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a KEY... API key and refuses one pasted with a prefix', () => {
    const key = new RegExp(a.envVarMeta.TELNYX_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'KEYshort', ` ${FAKE_KEY}`]) expect(key.test(bad)).toBe(false);
  });

  it('explains wrong and restricted keys', () => {
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/10009/);
  });

  it('prefixes every tool with telnyx_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^telnyx_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every paid action, says it costs money, and ships buying numbers switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of PAID) {
      expect(tool(name).description).toMatch(/costs? money|billed/);
      expect(tool(name).description).toMatch(/confirm/);
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(tool('telnyx_hangup_call').description).toMatch(/[Cc]onfirm/);
    expect(annotationsOf(tool('telnyx_hangup_call'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['telnyx_order_phone_numbers']);
    // Lookups are GETs but billed: the description must say so.
    expect(tool('telnyx_lookup_number').description).toMatch(/billed/);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btelnyx_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btelnyx_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('API Keys');
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['telnyx_get_balance', {}, 'GET', '/balance'],
    ['telnyx_list_phone_numbers', {}, 'GET', '/phone_numbers'],
    ['telnyx_get_phone_number', { id: '1293384261075731499' }, 'GET', '/phone_numbers/1293384261075731499'],
    ['telnyx_search_available_numbers', { country_code: 'US' }, 'GET', '/available_phone_numbers'],
    ['telnyx_order_phone_numbers', { phone_numbers: [{ phone_number: '+13125550123' }] }, 'POST', '/number_orders'],
    ['telnyx_get_number_order', { number_order_id: 'o1' }, 'GET', '/number_orders/o1'],
    ['telnyx_send_message', { to: '+4915112345678', from: '+13125550123', text: 'Hi' }, 'POST', '/messages'],
    ['telnyx_get_message', { id: 'm1' }, 'GET', '/messages/m1'],
    ['telnyx_list_messaging_profiles', {}, 'GET', '/messaging_profiles'],
    ['telnyx_list_call_control_applications', {}, 'GET', '/call_control_applications'],
    ['telnyx_dial_call', { connection_id: 'c1', to: '+4930123456', from: '+13125550123' }, 'POST', '/calls'],
    ['telnyx_get_call_status', { call_control_id: 'v3:abc' }, 'GET', '/calls/v3:abc'],
    ['telnyx_speak_text', { call_control_id: 'v3:abc', payload: 'Hello' }, 'POST', '/calls/v3:abc/actions/speak'],
    ['telnyx_hangup_call', { call_control_id: 'v3:abc' }, 'POST', '/calls/v3:abc/actions/hangup'],
    ['telnyx_search_detail_records', { record_type: 'messaging' }, 'GET', '/detail_records'],
    ['telnyx_get_usage_report_options', {}, 'GET', '/usage_reports/options'],
    ['telnyx_get_usage_report', { product: 'messaging', dimensions: 'date', metrics: 'cost' }, 'GET', '/usage_reports'],
    ['telnyx_list_recordings', {}, 'GET', '/recordings'],
    ['telnyx_get_recording', { recording_id: 'r1' }, 'GET', '/recordings/r1'],
    ['telnyx_lookup_number', { phone_number: '+4915112345678' }, 'GET', '/number_lookup/+4915112345678'],
    ['telnyx_list_verify_profiles', {}, 'GET', '/verify_profiles'],
    ['telnyx_send_verification', { phone_number: '+4915112345678', verify_profile_id: 'p1' }, 'POST', '/verifications/sms'],
    ['telnyx_check_verification_code', { phone_number: '+4915112345678', code: '123456', verify_profile_id: 'p1' }, 'POST', '/verifications/by_phone_number/+4915112345678/actions/verify'],
    ['telnyx_get_verification', { verification_id: 'v1' }, 'GET', '/verifications/v1'],
    ['telnyx_list_ai_assistants', {}, 'GET', '/ai/assistants'],
    ['telnyx_get_ai_assistant', { assistant_id: 'assistant-1' }, 'GET', '/ai/assistants/assistant-1'],
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
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('writes filters and pages in the deepObject form the API documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('telnyx_list_phone_numbers', { phone_number: '4930', status: 'active', country_code: 'DE', page_number: 2 });
    expect(sent().params).toEqual({
      'filter[phone_number]': '4930',
      'filter[status]': 'active',
      'filter[country_iso_alpha2]': 'DE',
      'page[number]': 2,
      'page[size]': 20,
    });
    mockedAxios.mockClear();
    await call('telnyx_search_available_numbers', { country_code: 'US', locality: 'Chicago', contains: '555', features: 'sms,voice' });
    expect(sent().params).toEqual({
      'filter[country_code]': 'US',
      'filter[locality]': 'Chicago',
      'filter[phone_number][contains]': '555',
      'filter[features]': 'sms,voice',
      'filter[limit]': 10,
    });
    mockedAxios.mockClear();
    await call('telnyx_search_detail_records', { record_type: 'call-control', sort: '-started_at' });
    expect(sent().params).toEqual({
      'filter[record_type]': 'call-control',
      'filter[date_range]': 'last_7_days',
      sort: '-started_at',
      'page[size]': 20,
    });
    mockedAxios.mockClear();
    await call('telnyx_list_recordings', { created_after: '2026-10-01T00:00:00Z', call_control_id: 'v3:abc' });
    expect(sent().params).toEqual({
      'filter[call_control_id]': 'v3:abc',
      'filter[created_at][gte]': '2026-10-01T00:00:00Z',
      'page[size]': 20,
    });
    mockedAxios.mockClear();
    await call('telnyx_get_usage_report', { product: 'messaging', dimensions: 'date,direction', metrics: 'cost,count', date_range: 'last_7_days' });
    expect(sent().params).toEqual({
      product: 'messaging',
      dimensions: 'date,direction',
      metrics: 'cost,count',
      date_range: 'last_7_days',
      'page[size]': 20,
    });
  });

  it('builds the message, call, speak, verify and order bodies with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('telnyx_send_message', { to: '+4915112345678', from: '+13125550123', text: 'Order shipped', media_urls: ['https://x/y.jpg'] });
    expect(sent().data).toEqual({ to: '+4915112345678', from: '+13125550123', text: 'Order shipped', media_urls: ['https://x/y.jpg'] });
    mockedAxios.mockClear();
    await call('telnyx_dial_call', { connection_id: 'c1', to: '+4930123456', from: '+13125550123', time_limit_secs: 300 });
    expect(sent().data).toEqual({ connection_id: 'c1', to: '+4930123456', from: '+13125550123', time_limit_secs: 300 });
    mockedAxios.mockClear();
    await call('telnyx_speak_text', { call_control_id: 'v3:abc', payload: 'Hallo', voice: 'AWS.Polly.Vicki-Neural' });
    expect(sent().data).toEqual({ payload: 'Hallo', voice: 'AWS.Polly.Vicki-Neural', language: 'en-US' });
    mockedAxios.mockClear();
    await call('telnyx_hangup_call', { call_control_id: 'v3:abc' });
    expect(sent().data ?? {}).toEqual({});
    mockedAxios.mockClear();
    await call('telnyx_send_verification', { channel: 'call', phone_number: '+4915112345678', verify_profile_id: 'p1' });
    expect(sent().url).toBe(`${HOST}/verifications/call`);
    expect(sent().data).toEqual({ phone_number: '+4915112345678', verify_profile_id: 'p1' });
    mockedAxios.mockClear();
    await call('telnyx_check_verification_code', { phone_number: '+4915112345678', code: '123456', verify_profile_id: 'p1' });
    expect(sent().data).toEqual({ code: '123456', verify_profile_id: 'p1' });
    mockedAxios.mockClear();
    await call('telnyx_order_phone_numbers', { phone_numbers: [{ phone_number: '+13125550123' }], connection_id: 'c1' });
    expect(sent().data).toEqual({ phone_numbers: [{ phone_number: '+13125550123' }], connection_id: 'c1' });
  });

  it('keeps the webhook secret of messaging profiles and the number PIN out of the answer', () => {
    const profiles = shape('telnyx_list_messaging_profiles', {
      data: [{ id: 'p1', name: 'Main', enabled: true, v1_secret: 'secret', whitelisted_destinations: ['DE'] }],
      meta: { total_pages: 1, total_results: 1, page_number: 1, page_size: 20 },
    });
    expect(profiles.data).toEqual([{ id: 'p1', name: 'Main', enabled: true, whitelisted_destinations: ['DE'] }]);
    expect(JSON.stringify(profiles)).not.toContain('secret');
    const number = shape('telnyx_get_phone_number', { data: { id: 'n1', phone_number: '+4930123456', external_pin: '1234' } });
    expect(number).toEqual({ data: { id: 'n1', phone_number: '+4930123456' } });
  });

  it('flattens message answers to the delivery state per recipient', () => {
    const out = shape('telnyx_send_message', {
      data: {
        id: 'm1',
        type: 'SMS',
        direction: 'outbound',
        from: { phone_number: '+13125550123', carrier: 'Telnyx' },
        to: [{ phone_number: '+4915112345678', status: 'queued', carrier: 'T-Mobile', line_type: 'Wireless' }],
        text: 'Hi',
        parts: 1,
        cost: { amount: '0.0040', currency: 'USD' },
        tags: [],
        webhook_url: 'https://x',
      },
    });
    expect(out.data).toEqual({
      id: 'm1',
      type: 'SMS',
      direction: 'outbound',
      from: '+13125550123',
      to: [{ phone_number: '+4915112345678', status: 'queued', carrier: 'T-Mobile', line_type: 'Wireless' }],
      text: 'Hi',
      parts: 1,
      cost: { amount: '0.0040', currency: 'USD' },
    });
    expect(shape('telnyx_get_balance', { data: { record_type: 'balance', balance: '10.00', currency: 'USD', pending: '0', credit_limit: '0', available_credit: '10.00' } })).toEqual({
      balance: '10.00',
      pending: '0',
      credit_limit: '0',
      available_credit: '10.00',
      currency: 'USD',
    });
  });
});

const live = process.env.RUN_TELNYX_LIVE === '1' ? describe : describe.skip;
live('telnyx adapter: live', () => {
  const real = !!process.env.TELNYX_API_KEY;
  const env = () => ({ TELNYX_API_KEY: process.env.TELNYX_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['telnyx_get_balance', {}],
    ['telnyx_list_phone_numbers', {}],
    ['telnyx_list_messaging_profiles', {}],
    ['telnyx_list_ai_assistants', {}],
  ])('%s reaches Telnyx and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads balance, numbers, profiles, applications, verify, recordings, records and assistants', async () => {
    const balance = await shaped('telnyx_get_balance', {}, env());
    expect(typeof balance.balance).toBe('string');
    for (const name of [
      'telnyx_list_phone_numbers',
      'telnyx_list_messaging_profiles',
      'telnyx_list_call_control_applications',
      'telnyx_list_verify_profiles',
      'telnyx_list_recordings',
      'telnyx_list_ai_assistants',
    ]) {
      const out = await shaped(name, { page_size: 5 }, env());
      expect(`${name}:${Array.isArray(out.data)}`).toBe(`${name}:true`);
    }
    const records = await shaped('telnyx_search_detail_records', { record_type: 'messaging', page_size: 5 }, env());
    expect(Array.isArray(records.data)).toBe(true);
    const options = await shaped('telnyx_get_usage_report_options', { product: 'messaging' }, env());
    expect(Array.isArray(options.data)).toBe(true);
    const available = await shaped('telnyx_search_available_numbers', { country_code: 'US', limit: 2 }, env());
    expect(Array.isArray(available.data)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_TELNYX_LIVE_WRITES === '1' && !!process.env.TELNYX_TEST_FROM && !!process.env.TELNYX_TEST_TO;
  (writes ? it : it.skip)('sends one SMS to the test recipient and reads it back (billed)', async () => {
    const out = await shaped(
      'telnyx_send_message',
      { from: process.env.TELNYX_TEST_FROM, to: process.env.TELNYX_TEST_TO, text: `AnythingMCP live check ${Date.now()}` },
      env(),
    );
    expect(out.data.id).toBeTruthy();
    const read = await shaped('telnyx_get_message', { id: out.data.id }, env());
    expect(read.data.id).toBe(out.data.id);
  }, 60000);
});
