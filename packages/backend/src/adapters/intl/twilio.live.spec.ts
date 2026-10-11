import axios from 'axios';
import * as adapter from './twilio.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Twilio adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic with the API key (or Account SID)
 *      and secret, the Account SID in every 2010-04-01 path (with .json), the
 *      Lookup, Verify and Messaging hosts, every tool's method and URL, the
 *      form-encoded message and verification bodies, and which tools are
 *      read-only, send messages or are switched off.
 *
 *   2. Live: reads are skipped unless TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID
 *      and TWILIO_API_KEY_SECRET are set (an API key, or the Account SID and
 *      Auth Token):
 *
 *        TWILIO_ACCOUNT_SID=AC... TWILIO_API_KEY_SID=SK... TWILIO_API_KEY_SECRET=... \
 *          npx jest src/adapters/intl/twilio.live.spec.ts
 *
 *      Reads the account (a Standard key may be refused there), balance,
 *      messages with their media, calls, phone numbers, Messaging and Verify
 *      services, a free basic Lookup and usage records.
 *
 *      Sending is only ever tested with Twilio's test credentials, which send
 *      nothing and cost nothing: TWILIO_LIVE_WRITE=1 with
 *      TWILIO_TEST_ACCOUNT_SID and TWILIO_TEST_AUTH_TOKEN (Console, API keys &
 *      tokens, Test credentials) sends from the magic number +15005550006 and
 *      checks the refusals for the magic recipients. Test credentials can
 *      neither read back nor delete what they create, so there is nothing to
 *      clean up.
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal in this file looks like a real credential.
const ACCOUNT = 'AC' + '0'.repeat(32);
const KEY = 'SK' + '0'.repeat(32);
const ENV = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 'key-secret' };
const API = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`;
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

describe('twilio adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/API key/);
  });

  it('signs every call with HTTP Basic: API key SID (or Account SID) and secret (or Auth Token)', async () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{TWILIO_API_KEY_SID}}', password: '{{TWILIO_API_KEY_SECRET}}' });
    expect(a.connector.baseUrl).toBe('https://api.twilio.com');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_list_messages', {});
    expect(sent().auth).toEqual({ username: KEY, password: 'key-secret' });
    expect(sent().url).toBe(`${API}/Messages.json`);
  });

  it('checks the SIDs and marks the secret secret', () => {
    expect(a.requiredEnvVars).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET']);
    const account = new RegExp(a.envVarMeta.TWILIO_ACCOUNT_SID.pattern!);
    const key = new RegExp(a.envVarMeta.TWILIO_API_KEY_SID.pattern!);
    expect(account.test(ACCOUNT)).toBe(true);
    expect(account.test(KEY)).toBe(false);
    expect(key.test(KEY)).toBe(true);
    expect(key.test(ACCOUNT)).toBe(true);
    expect(key.test('SK123')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'TWILIO_API_KEY_SECRET')!.secret).toBe(true);
  });

  it('probes with one phone number (works with a Standard key) and health-checks a free Lookup', () => {
    expect(a.probe).toEqual({ tool: 'twilio_list_phone_numbers', params: { page_size: 1 } });
    // The health check path is not interpolated, so it must not need the Account SID.
    expect(a.connector.healthcheckPath).toBe('https://lookups.twilio.com/v2/PhoneNumbers/+14155552671');
  });

  it('keeps every 2010-04-01 path on the account and in JSON', () => {
    for (const t of a.tools) {
      const path = t.endpointMapping.path;
      if (path.startsWith('/2010-04-01/')) {
        expect(path.startsWith('/2010-04-01/Accounts/{{TWILIO_ACCOUNT_SID}}')).toBe(true);
        expect(path.endsWith('.json')).toBe(true);
      } else {
        expect(path).toMatch(/^https:\/\/(lookups|verify|messaging)\.twilio\.com\//);
      }
    }
  });

  it('prefixes every tool with twilio_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^twilio_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, sending non-idempotent and destructive, and installs deletion switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    for (const name of ['twilio_send_message', 'twilio_send_verification']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('twilio_check_verification')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('twilio_cancel_scheduled_message')).destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['twilio_delete_message']);
    expect(annotationsOf(tool('twilio_delete_message')).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btwilio_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btwilio_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const SM = 'SM' + '1'.repeat(32);
  const VA = 'VA' + '2'.repeat(32);
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['twilio_get_account', {}, 'GET', `${API}.json`],
    ['twilio_get_balance', {}, 'GET', `${API}/Balance.json`],
    ['twilio_list_messages', {}, 'GET', `${API}/Messages.json`],
    ['twilio_get_message', { message_sid: SM }, 'GET', `${API}/Messages/${SM}.json`],
    ['twilio_send_message', { to: '+4915112345678', from: '+15005550006', body: 'Hi' }, 'POST', `${API}/Messages.json`],
    ['twilio_cancel_scheduled_message', { message_sid: SM }, 'POST', `${API}/Messages/${SM}.json`],
    ['twilio_list_message_media', { message_sid: SM }, 'GET', `${API}/Messages/${SM}/Media.json`],
    ['twilio_delete_message', { message_sid: SM }, 'DELETE', `${API}/Messages/${SM}.json`],
    ['twilio_list_calls', {}, 'GET', `${API}/Calls.json`],
    ['twilio_get_call', { call_sid: 'CA1' }, 'GET', `${API}/Calls/CA1.json`],
    ['twilio_list_phone_numbers', {}, 'GET', `${API}/IncomingPhoneNumbers.json`],
    ['twilio_get_phone_number', { phone_number_sid: 'PN1' }, 'GET', `${API}/IncomingPhoneNumbers/PN1.json`],
    ['twilio_list_messaging_services', {}, 'GET', 'https://messaging.twilio.com/v1/Services'],
    ['twilio_lookup_phone_number', { phone_number: '+4915112345678' }, 'GET', 'https://lookups.twilio.com/v2/PhoneNumbers/%2B4915112345678'],
    ['twilio_list_verify_services', {}, 'GET', 'https://verify.twilio.com/v2/Services'],
    ['twilio_send_verification', { service_sid: VA, to: '+4915112345678', channel: 'sms' }, 'POST', `https://verify.twilio.com/v2/Services/${VA}/Verifications`],
    ['twilio_check_verification', { service_sid: VA, to: '+4915112345678', code: '123456' }, 'POST', `https://verify.twilio.com/v2/Services/${VA}/VerificationCheck`],
    ['twilio_get_verification', { service_sid: VA, verification_sid: 'VE1' }, 'GET', `https://verify.twilio.com/v2/Services/${VA}/Verifications/VE1`],
    ['twilio_list_usage_records', {}, 'GET', `${API}/Usage/Records.json`],
    ['twilio_list_usage_records_by_period', { period: 'ThisMonth' }, 'GET', `${API}/Usage/Records/ThisMonth.json`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
  });

  it('sends a message form-encoded with Twilio\'s parameter names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_send_message', { to: 'whatsapp:+4915112345678', from: 'whatsapp:+14155238886', content_sid: 'HX1', content_variables: '{"1":"Anna"}' });
    expect(tool('twilio_send_message').endpointMapping.bodyEncoding).toBe('form-urlencoded');
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(sent().data))).toEqual({
      To: 'whatsapp:+4915112345678',
      From: 'whatsapp:+14155238886',
      ContentSid: 'HX1',
      ContentVariables: '{"1":"Anna"}',
    });
  });

  it('cancels a scheduled message with Status=canceled only', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_cancel_scheduled_message', { message_sid: SM });
    expect(sent().data).toBe('Status=canceled');
  });

  it('filters lists with Twilio\'s range operators and pages with PageSize 50 by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_list_messages', { to: '+4915112345678', date_sent_after: '2026-10-01', page_token: 'PASM1', page: 1 });
    expect(sent().params).toEqual({ To: '+4915112345678', 'DateSent>': '2026-10-01', PageSize: 50, Page: 1, PageToken: 'PASM1' });
    mockedAxios.mockClear();
    await call('twilio_list_usage_records', { category: 'totalprice', start_date: '-30days' });
    expect(sent().params).toEqual({ Category: 'totalprice', StartDate: '-30days', PageSize: 50 });
  });

  it('sends verification and check bodies form-encoded', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_send_verification', { service_sid: VA, to: '+4915112345678', channel: 'whatsapp', locale: 'de' });
    expect(sent().data).toBe('To=%2B4915112345678&Channel=whatsapp&Locale=de');
    mockedAxios.mockClear();
    await call('twilio_check_verification', { service_sid: VA, verification_sid: 'VE1', code: '123456' });
    expect(sent().data).toBe('VerificationSid=VE1&Code=123456');
  });

  it('asks Lookup for paid packages only when told to', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twilio_lookup_phone_number', { phone_number: '015112345678', country_code: 'DE' });
    expect(sent().params).toEqual({ CountryCode: 'DE' });
  });
});

const LIVE_ENV = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? '',
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID ?? '',
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET ?? '',
};
const hasLive = Object.values(LIVE_ENV).every(Boolean);
const live = hasLive ? describe : describe.skip;

live('twilio adapter: live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, LIVE_ENV, params);
  const statusOf = (e: unknown) => (e as { response?: { status?: number } }).response?.status;

  it('reads the account (a Standard key may be refused) and the balance', async () => {
    try {
      const account = await run('twilio_get_account');
      expect(account.sid).toBe(LIVE_ENV.TWILIO_ACCOUNT_SID);
    } catch (e) {
      // A Standard API key may not read the Accounts resource itself.
      expect(LIVE_ENV.TWILIO_API_KEY_SID.startsWith('SK')).toBe(true);
      expect(statusOf(e)).toBe(403);
    }
    const balance = await run('twilio_get_balance');
    expect(balance.currency).toBeDefined();
  }, 30_000);

  it('reads messages, media, calls and phone numbers', async () => {
    const messages = await run('twilio_list_messages', { page_size: 5 });
    expect(Array.isArray(messages.messages)).toBe(true);
    if (messages.messages.length) {
      const sid = messages.messages[0].sid;
      expect((await run('twilio_get_message', { message_sid: sid })).sid).toBe(sid);
      const media = await run('twilio_list_message_media', { message_sid: sid });
      expect(Array.isArray(media.media_list)).toBe(true);
    }
    const calls = await run('twilio_list_calls', { page_size: 5 });
    expect(Array.isArray(calls.calls)).toBe(true);
    if (calls.calls.length) expect((await run('twilio_get_call', { call_sid: calls.calls[0].sid })).sid).toBe(calls.calls[0].sid);
    const numbers = await run('twilio_list_phone_numbers', { page_size: 5 });
    expect(Array.isArray(numbers.incoming_phone_numbers)).toBe(true);
    if (numbers.incoming_phone_numbers.length) {
      const pn = numbers.incoming_phone_numbers[0];
      expect((await run('twilio_get_phone_number', { phone_number_sid: pn.sid })).phone_number).toBe(pn.phone_number);
    }
  }, 60_000);

  it('reads Messaging and Verify services, a free Lookup and usage', async () => {
    const services = await run('twilio_list_messaging_services', { page_size: 5 });
    expect(Array.isArray(services.services)).toBe(true);
    const verify = await run('twilio_list_verify_services', { page_size: 5 });
    expect(Array.isArray(verify.services)).toBe(true);
    const lookup = await run('twilio_lookup_phone_number', { phone_number: '+14155552671' });
    expect(lookup.valid).toBe(true);
    expect(lookup.country_code).toBe('US');
    const lookupDe = await run('twilio_lookup_phone_number', { phone_number: '030 901820', country_code: 'DE' });
    expect(lookupDe.phone_number.startsWith('+49')).toBe(true);
    const usage = await run('twilio_list_usage_records', { category: 'totalprice', start_date: '-30days' });
    expect(Array.isArray(usage.usage_records)).toBe(true);
    const daily = await run('twilio_list_usage_records_by_period', { period: 'ThisMonth', category: 'totalprice' });
    expect(Array.isArray(daily.usage_records)).toBe(true);
  }, 60_000);
});

const TEST_ENV = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_TEST_ACCOUNT_SID ?? '',
  TWILIO_API_KEY_SID: process.env.TWILIO_TEST_ACCOUNT_SID ?? '',
  TWILIO_API_KEY_SECRET: process.env.TWILIO_TEST_AUTH_TOKEN ?? '',
};
const write = process.env.TWILIO_LIVE_WRITE === '1' && !!TEST_ENV.TWILIO_ACCOUNT_SID && !!TEST_ENV.TWILIO_API_KEY_SECRET;

(write ? describe : describe.skip)('twilio adapter: sending with test credentials (nothing is delivered or billed)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TEST_ENV, params);
  const codeOf = (e: unknown) => (e as { response?: { data?: { code?: number } } }).response?.data?.code;

  it('sends from the magic number and gets the documented refusals', async () => {
    const refusal = async (params: Record<string, unknown>) => {
      try {
        await run('twilio_send_message', params);
        return 'sent';
      } catch (e) {
        return codeOf(e);
      }
    };
    const message = await run('twilio_send_message', { to: '+14108675310', from: '+15005550006', body: 'AnythingMCP live spec' });
    expect(message.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(message.status).toBe('queued');
    expect(await refusal({ to: '+15005550001', from: '+15005550006', body: 'x' })).toBe(21211);
    expect(await refusal({ to: '+15005550004', from: '+15005550006', body: 'x' })).toBe(21610);
    expect(await refusal({ to: '+14108675310', from: '+15005550007', body: 'x' })).toBe(21606);
  }, 60_000);
});
