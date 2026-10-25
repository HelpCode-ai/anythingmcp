import axios from 'axios';
import * as adapter from './plivo.json';
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
 * Two layers of verification for the Plivo adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic auth with the Auth ID and Auth
 *      Token, the account-scoped base URL, every tool's method, URL (always
 *      with the trailing slash Plivo needs), query and body through the real
 *      RestEngine. Checked against Plivo's official SDKs (plivo-python
 *      resources and test fixtures, plivo-node) and the API reference
 *      (plivo.com/docs, read 15 Oct 2026). Also which tools only read, that
 *      sending, calling, verifying and hanging up ask for confirmation and say
 *      what they cost, and that renting a number ships switched off.
 *
 *   2. Live: skipped unless RUN_PLIVO_LIVE=1. Without credentials it checks
 *      that Plivo refuses a wrong Auth ID and token with 401 on the real
 *      routes while a made-up route answers 404 (Plivo routes before it checks
 *      the credentials). With PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN it reads the
 *      account, prices, numbers, messages, calls and recordings, shaped by each
 *      tool's response mapping as production does. Nothing billed happens
 *      unless RUN_PLIVO_LIVE_WRITES=1 is set too: then it looks up
 *      PLIVO_TEST_TO (one billed lookup) and, when PLIVO_TEST_FROM is set,
 *      sends one SMS from PLIVO_TEST_FROM to PLIVO_TEST_TO. No call is placed.
 *
 *        RUN_PLIVO_LIVE=1 PLIVO_AUTH_ID=MA... PLIVO_AUTH_TOKEN=... \
 *          npx jest src/adapters/intl/plivo.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; pattern?: string }>; required?: string[] };
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

// Built at runtime so no literal looks like a real credential.
const FAKE_ID = 'MA' + 'AMCP'.repeat(4) + '00';
const FAKE_TOKEN = 'tok' + '0'.repeat(37);
const ENV: Record<string, string> = { PLIVO_AUTH_ID: FAKE_ID, PLIVO_AUTH_TOKEN: FAKE_TOKEN };
const BASE = `https://api.plivo.com/v1/Account/${FAKE_ID}`;
const BASIC = 'Basic ' + Buffer.from(`${FAKE_ID}:${FAKE_TOKEN}`).toString('base64');
const UUID = '5b40a428-bfc7-4daf-9d06-726c558bf3b8';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const run = (mapping: Tool['endpointMapping'], params: Record<string, unknown>, env = ENV, schema?: Tool['parameters']) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    mapping,
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
    { ...applySchemaDefaults((schema ?? {}) as any, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, env = ENV) =>
  run(tool(name).endpointMapping, params, env, tool(name).parameters);
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const basicOf = (req: any) =>
  req.headers.Authorization ?? (req.auth ? 'Basic ' + Buffer.from(`${req.auth.username}:${req.auth.password}`).toString('base64') : undefined);

const WRITES = ['plivo_buy_number', 'plivo_hangup_call', 'plivo_make_call', 'plivo_send_message', 'plivo_send_verification', 'plivo_validate_verification'];
const BILLED = ['plivo_send_message', 'plivo_make_call', 'plivo_send_verification', 'plivo_buy_number'];

describe('plivo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('uses HTTP Basic auth and the account-scoped base URL, and checks the account itself', () => {
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('plivo');
    expect(a.connector.baseUrl).toBe('https://api.plivo.com/v1/Account/{{PLIVO_AUTH_ID}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{PLIVO_AUTH_ID}}', password: '{{PLIVO_AUTH_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/');
    expect(a.requiredEnvVars).toEqual(['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.PLIVO_AUTH_ID).toMatchObject({ kind: 'credential', required: true });
    expect(meta.PLIVO_AUTH_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    const id = new RegExp(a.envVarMeta.PLIVO_AUTH_ID.pattern!);
    for (const ok of [FAKE_ID, 'MAXXXXXXXXXXXXXXXXXX', 'SAXXXXXXXXXXXXXXXXXX']) expect(id.test(ok)).toBe(true);
    for (const bad of ['', 'maxxxxxxxxxxxxxxxxxx', 'MAXXXX', 'AC00000000000000000000000000000000']) expect(id.test(bad)).toBe(false);
  });

  it('probes with the account and explains wrong credentials and limits', () => {
    expect(a.probe).toEqual({ tool: 'plivo_get_account' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['429']).toMatch(/300 requests per 5 seconds/);
  });

  it('prefixes every tool with plivo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^plivo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every billed or disruptive call, says it costs money and ships the number purchase off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of BILLED) {
      expect(tool(name).description).toMatch(/costs? money/);
      expect(tool(name).description).toMatch(/confirm/);
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(tool('plivo_hangup_call').description).toMatch(/only after the user confirms/);
    expect(annotationsOf(tool('plivo_hangup_call'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('plivo_lookup_number').description).toMatch(/billed/);
    expect(tool('plivo_lookup_number').description).toMatch(/confirms/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['plivo_buy_number', 'plivo_hangup_call']);
    expect(tool('plivo_buy_number').description).toMatch(/switched off/);
  });

  it('never lets a hang-up go out without a full call uuid (Plivo would end every call)', () => {
    const p = tool('plivo_hangup_call').parameters;
    expect(p.required).toEqual(['call_uuid']);
    const re = new RegExp(p.properties!.call_uuid.pattern!);
    expect(re.test(UUID)).toBe(true);
    expect(re.test('')).toBe(false);
    expect(tool('plivo_hangup_call').description).toMatch(/every running call/);
  });

  it('says that message logs, call records, recordings and transcripts are personal data', () => {
    expect(a.instructions).toMatch(/\*\*Personal data\.\*\*/);
    for (const name of ['plivo_get_message', 'plivo_list_messages', 'plivo_list_calls', 'plivo_list_recordings', 'plivo_get_recording', 'plivo_get_transcription']) {
      expect(tool(name).description).toMatch(/personal data/i);
    }
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bplivo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bplivo_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('cx.plivo.com');
    expect(a.instructions).toMatch(/300 API requests per 5 seconds/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool with a body a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      if (t.name === 'plivo_hangup_call') continue; // 204, no body
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  // Paths as the SDKs build them: base URI, auth id, resource, trailing slash.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['plivo_get_account', {}, 'GET', `${BASE}/`],
    ['plivo_get_pricing', { country_iso: 'US' }, 'GET', `${BASE}/Pricing/`],
    ['plivo_send_message', { dst: '+14155550123', text: 'Hi', src: '+14155550100' }, 'POST', `${BASE}/Message/`],
    ['plivo_get_message', { message_uuid: UUID }, 'GET', `${BASE}/Message/${UUID}/`],
    ['plivo_list_messages', {}, 'GET', `${BASE}/Message/`],
    ['plivo_make_call', { to: '14155550123', from: '14155550100', answer_url: 'https://example.com/a.xml' }, 'POST', `${BASE}/Call/`],
    ['plivo_list_calls', {}, 'GET', `${BASE}/Call/`],
    ['plivo_get_call', { call_uuid: UUID }, 'GET', `${BASE}/Call/${UUID}/`],
    ['plivo_list_live_calls', {}, 'GET', `${BASE}/Call/`],
    ['plivo_get_live_call', { call_uuid: UUID }, 'GET', `${BASE}/Call/${UUID}/`],
    ['plivo_hangup_call', { call_uuid: UUID }, 'DELETE', `${BASE}/Call/${UUID}/`],
    ['plivo_list_recordings', {}, 'GET', `${BASE}/Recording/`],
    ['plivo_get_recording', { recording_id: 'c2186400-1c8c-11e4-a664-0026b945b52x' }, 'GET', `${BASE}/Recording/c2186400-1c8c-11e4-a664-0026b945b52x/`],
    ['plivo_get_transcription', { recording_id: 'r1' }, 'GET', `${BASE}/Transcription/r1/`],
    ['plivo_list_numbers', {}, 'GET', `${BASE}/Number/`],
    ['plivo_get_number', { number: '14155550100' }, 'GET', `${BASE}/Number/14155550100/`],
    ['plivo_search_available_numbers', { country_iso: 'DE' }, 'GET', `${BASE}/PhoneNumber/`],
    ['plivo_buy_number', { number: '14154009186' }, 'POST', `${BASE}/PhoneNumber/14154009186/`],
    ['plivo_lookup_number', { phone_number: '+14154305555' }, 'GET', 'https://lookup.plivo.com/v1/Number/+14154305555'],
    ['plivo_send_verification', { recipient: '+14155550123' }, 'POST', `${BASE}/Verify/Session/`],
    ['plivo_validate_verification', { session_uuid: UUID, otp: '123456' }, 'POST', `${BASE}/Verify/Session/${UUID}/`],
    ['plivo_get_verification', { session_uuid: UUID }, 'GET', `${BASE}/Verify/Session/${UUID}/`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the SDK URL with Basic auth', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(basicOf(req)).toBe(BASIC);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('uses the SDK query names: limit/offset (20), __gt/__lt time filters and status=live', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('plivo_list_messages', { message_direction: 'outbound', message_state: 'failed', sent_after: '2026-10-01 00:00:00', sent_before: '2026-10-02 00:00:00', offset: 20 });
    expect(sent().params).toEqual({ message_direction: 'outbound', message_state: 'failed', message_time__gt: '2026-10-01 00:00:00', message_time__lt: '2026-10-02 00:00:00', limit: 20, offset: 20 });
    mockedAxios.mockClear();
    await call('plivo_list_calls', { call_direction: 'inbound', ended_after: '2026-10-01 00:00:00', ended_before: '2026-10-07 00:00:00', min_bill_duration: 30 });
    expect(sent().params).toEqual({ call_direction: 'inbound', end_time__gte: '2026-10-01 00:00:00', end_time__lte: '2026-10-07 00:00:00', bill_duration__gt: 30, limit: 20 });
    mockedAxios.mockClear();
    await call('plivo_list_live_calls', {});
    expect(sent().params).toEqual({ status: 'live', limit: 20 });
    mockedAxios.mockClear();
    await call('plivo_get_live_call', { call_uuid: UUID });
    expect(sent().params).toEqual({ status: 'live' });
    mockedAxios.mockClear();
    await call('plivo_list_recordings', { call_uuid: UUID, added_after: '2026-10-01 00:00:00' });
    expect(sent().params).toEqual({ call_uuid: UUID, add_time__gte: '2026-10-01 00:00:00', limit: 20 });
    mockedAxios.mockClear();
    await call('plivo_search_available_numbers', { country_iso: 'US', type: 'local', pattern: '415', services: 'voice,sms' });
    expect(sent().params).toEqual({ country_iso: 'US', type: 'local', pattern: '415', services: 'voice,sms', limit: 20 });
    mockedAxios.mockClear();
    await call('plivo_get_pricing', { country_iso: 'GB' });
    expect(sent().params).toEqual({ country_iso: 'GB' });
    mockedAxios.mockClear();
    await call('plivo_lookup_number', { phone_number: '+14154305555' });
    expect(sent().params).toEqual({ type: 'carrier' });
  });

  it('builds the SDK bodies for messages, calls, number purchase and Verify', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('plivo_send_message', { src: '14155550100', dst: '14155550123<14155550124', text: 'Hello', type: 'sms', url: 'https://example.com/status' });
    expect(sent().data).toEqual({ src: '14155550100', dst: '14155550123<14155550124', text: 'Hello', type: 'sms', url: 'https://example.com/status' });
    mockedAxios.mockClear();
    await call('plivo_make_call', { from: '14155550100', to: '14155550123', answer_url: 'https://example.com/a.xml', answer_method: 'GET', time_limit: 120 });
    expect(sent().data).toEqual({ from: '14155550100', to: '14155550123', answer_url: 'https://example.com/a.xml', answer_method: 'GET', time_limit: 120 });
    expect(tool('plivo_make_call').parameters.required).toEqual(['to', 'from', 'answer_url']);
    mockedAxios.mockClear();
    await call('plivo_buy_number', { number: '14154009186', app_id: '29986316244302815' });
    expect(sent().data).toEqual({ app_id: '29986316244302815' });
    mockedAxios.mockClear();
    await call('plivo_send_verification', { recipient: '+14155550123', channel: 'voice', locale: 'de', code_length: 6 });
    expect(sent().data).toEqual({ recipient: '+14155550123', channel: 'voice', locale: 'de', code_length: 6 });
    mockedAxios.mockClear();
    await call('plivo_validate_verification', { session_uuid: UUID, otp: '123456' });
    expect(sent().data).toEqual({ otp: '123456' });
  });

  // Response bodies below are the plivo-python test fixtures.
  it('keeps the account balance and drops the rest', () => {
    const raw = {
      account_type: 'standard', address: '', api_id: '95e1df78', auth_id: 'MAXXXXXXXXXXXXXXXXXX', auto_recharge: false,
      billing_mode: 'prepaid', cash_credits: '4.88860', city: '', name: 'Sherlock Holmes', resource_uri: '/v1/Account/MAXXXXXXXXXXXXXXXXXX/', state: '', timezone: 'Asia/Kolkata',
    };
    expect(applyResponseTransform(raw, tool('plivo_get_account').responseMapping as any).value).toEqual({
      auth_id: 'MAXXXXXXXXXXXXXXXXXX', name: 'Sherlock Holmes', account_type: 'standard', billing_mode: 'prepaid', cash_credits: '4.88860',
      auto_recharge: false, timezone: 'Asia/Kolkata', city: '', state: '',
    });
  });

  it('keeps meta and the useful call record fields', () => {
    const raw = {
      api_id: '8299d094', meta: { limit: 20, next: null, offset: 0, previous: null, total_count: 1 },
      objects: [{
        answer_time: '2015-07-26 15:45:02+05:30', api_id: 'x', bill_duration: 924, billed_duration: 960, call_direction: 'outbound', call_duration: 924,
        call_uuid: 'eba53b9e-8fbd-45c1-9444-696d2172fbc8', end_time: '2015-07-26 15:45:14+05:30', from_number: '+14158572518',
        initiation_time: '2015-07-26 15:44:49+05:30', parent_call_uuid: null, resource_uri: '/v1/Account/MA/Call/x/', to_number: '14153268174',
        total_amount: '0.13600', total_rate: '0.00850',
      }],
    };
    const out = applyResponseTransform(raw, tool('plivo_list_calls').responseMapping as any).value as any;
    expect(out.meta).toEqual(raw.meta);
    expect(out.objects[0]).toMatchObject({ call_uuid: 'eba53b9e-8fbd-45c1-9444-696d2172fbc8', billed_duration: 960, total_amount: '0.13600', to_number: '14153268174' });
    expect(out.objects[0].resource_uri).toBeUndefined();
  });

  it('keeps the recording link and the transcription text', () => {
    const rec = {
      add_time: '2014-08-05 16:15:15.852059+05:30', api_id: 'x', call_uuid: 'c2c128e2', conference_name: 'noname', recording_duration_ms: '345100.00000',
      recording_format: 'mp3', recording_id: 'c2186400', recording_type: 'conference', recording_url: 'http://s3.amazonaws.com/recordings_2013/c2186400.mp3', resource_uri: 'x',
    };
    expect(applyResponseTransform(rec, tool('plivo_get_recording').responseMapping as any).value).toMatchObject({ recording_id: 'c2186400', recording_url: rec.recording_url });
    const tr = { api_id: 'f83b30a3', cost: 0.05, rate: 0.05, recording_duration_ms: 22780, recording_start_ms: 1729761222174, status: 'success', transcription: '\nSpeaker 0: Scan just to be safe.' };
    expect(applyResponseTransform(tr, tool('plivo_get_transcription').responseMapping as any).value).toEqual({
      status: 'success', transcription: '\nSpeaker 0: Scan just to be safe.', recording_duration_ms: 22780, recording_start_ms: 1729761222174, cost: 0.05, rate: 0.05,
    });
  });

  it('keeps the lookup carrier and the Verify session status and charges', () => {
    const lookup = {
      api_id: 'a35a2e7a', phone_number: '+14154305555', country: { name: 'United States', iso2: 'US', iso3: 'USA' },
      format: { e164: '+14154305555', national: '(415) 430-5555' }, carrier: { name: 'Cingular Wireless', type: 'mobile', ported: 'yes' }, resource_uri: 'x',
    };
    expect(applyResponseTransform(lookup, tool('plivo_lookup_number').responseMapping as any).value).toEqual({
      phone_number: '+14154305555', country: lookup.country, format: lookup.format, carrier: lookup.carrier,
    });
    const session = {
      api_id: '8faf830c', session_uuid: '5c533d15-1975-4f20-80be-40174142ea37', app_uuid: 'eeb90c7b', recipient: '918681951370', channel: 'sms',
      status: 'expired', count: 1, attempt_details: [{ channel: 'sms', status: 'failed' }], charges: { total_charge: '0' },
      created_at: '2023-07-18T08:46:14.851205Z', updated_at: '2023-07-18T08:46:14.865388Z',
    };
    const out = applyResponseTransform(session, tool('plivo_get_verification').responseMapping as any).value as any;
    expect(out).toMatchObject({ status: 'expired', recipient: '918681951370', charges: { total_charge: '0' } });
    expect(out.api_id).toBeUndefined();
  });
});

const live = process.env.RUN_PLIVO_LIVE === '1' ? describe : describe.skip;
live('plivo adapter: live', () => {
  const real = !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN);
  const env = () => ({ PLIVO_AUTH_ID: process.env.PLIVO_AUTH_ID!, PLIVO_AUTH_TOKEN: process.env.PLIVO_AUTH_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['plivo_get_account', {}],
    ['plivo_list_messages', { limit: 1 }],
    ['plivo_list_calls', { limit: 1 }],
    ['plivo_get_pricing', { country_iso: 'US' }],
    ['plivo_lookup_number', { phone_number: '+14154305555' }],
  ])('%s reaches Plivo and is refused with a wrong Auth ID and token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route with the same wrong credentials (routing comes before the check)', async () => {
    await expect(run({ method: 'GET', path: '/AmcpNoSuchRoute/' }, {})).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads the account, prices, numbers, messages, calls and recordings', async () => {
    const account = await shaped('plivo_get_account', {}, env());
    expect(account.auth_id).toBe(process.env.PLIVO_AUTH_ID);
    const pricing = await shaped('plivo_get_pricing', { country_iso: 'US' }, env());
    expect(pricing.country_iso).toBe('US');
    for (const name of ['plivo_list_numbers', 'plivo_list_messages', 'plivo_list_calls', 'plivo_list_recordings']) {
      const out = await shaped(name, { limit: 5 }, env());
      expect(Array.isArray(out.objects)).toBe(true);
    }
    const liveCalls = await shaped('plivo_list_live_calls', {}, env());
    expect(liveCalls.calls === undefined || Array.isArray(liveCalls.calls)).toBe(true);
    const available = await shaped('plivo_search_available_numbers', { country_iso: 'US', limit: 3 }, env());
    expect(Array.isArray(available.objects)).toBe(true);
  }, 60000);

  const writes = real && process.env.RUN_PLIVO_LIVE_WRITES === '1' && !!process.env.PLIVO_TEST_TO;
  (writes ? it : it.skip)('looks up the test number and, with PLIVO_TEST_FROM, sends it one SMS (billed)', async () => {
    const lookup = await shaped('plivo_lookup_number', { phone_number: process.env.PLIVO_TEST_TO }, env());
    expect(lookup.phone_number).toBeDefined();
    if (process.env.PLIVO_TEST_FROM) {
      const sentMessage = await shaped(
        'plivo_send_message',
        { src: process.env.PLIVO_TEST_FROM, dst: process.env.PLIVO_TEST_TO, text: 'AnythingMCP live check' },
        env(),
      );
      expect(sentMessage.message_uuid).toHaveLength(1);
      const read = await shaped('plivo_get_message', { message_uuid: sentMessage.message_uuid[0] }, env());
      expect(read.message_uuid).toBe(sentMessage.message_uuid[0]);
    }
  }, 60000);
});
