import axios from 'axios';
import * as adapter from './dialpad.json';
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
 * Two layers of verification for the Dialpad adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the API key, every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against Dialpad's own OpenAPI 3 file (dialpad_api_spec.json, shipped
 *      with the official python-dialpad client, read 15 Oct 2026): paths,
 *      query names, body field names and the response fields the mappings
 *      keep. Also which tools only read, that calls, texts and share links
 *      ask for confirmation and that transcripts are flagged as personal data.
 *
 *   2. Live: skipped unless RUN_DIALPAD_LIVE=1. Without credentials it checks
 *      that Dialpad refuses a wrong key with 401 on the real routes while a
 *      made-up route answers 404 (Dialpad routes before it checks the key).
 *      With DIALPAD_API_KEY it reads offices, users, call centers and the
 *      latest calls, shaped by each tool's response mapping as production
 *      does, and starts one statistics export (it only reads). Nothing is
 *      written unless RUN_DIALPAD_LIVE_WRITES=1 and DIALPAD_TEST_USER_ID are
 *      set too: then one local test contact is created for that user. No call
 *      is placed and no text is sent by this spec.
 *
 *        RUN_DIALPAD_LIVE=1 DIALPAD_API_KEY=... npx jest src/adapters/intl/dialpad.live.spec.ts
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

const BASE = 'https://dialpad.com/api/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'amcp' + '0'.repeat(40);
const ENV: Record<string, string> = { DIALPAD_API_KEY: FAKE_KEY };

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

const WRITES = ['dialpad_create_contact', 'dialpad_create_recording_share_link', 'dialpad_initiate_call', 'dialpad_send_sms'];

describe('dialpad adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the API key as a Bearer token to dialpad.com/api/v2 and checks the offices', () => {
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('dialpad');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DIALPAD_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/offices');
    expect(a.requiredEnvVars).toEqual(['DIALPAD_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.DIALPAD_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const key = new RegExp(a.envVarMeta.DIALPAD_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    expect(key.test(`Bearer ${FAKE_KEY}`)).toBe(false);
  });

  it('probes with the office list and explains wrong keys, admin rights and limits', () => {
    expect(a.probe).toEqual({ tool: 'dialpad_list_offices' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/company admin/);
  });

  it('prefixes every tool with dialpad_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^dialpad_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the stats export read-only, confirms every write and warns that calls and texts cost money', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('dialpad_start_stats_export'))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/only after the user confirms/);
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of ['dialpad_initiate_call', 'dialpad_send_sms']) {
      expect(tool(name).description).toMatch(/real person|real people/);
      expect(tool(name).description).toMatch(/cost money/);
    }
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('says that calls, recordings and transcripts are personal data', () => {
    expect(a.instructions).toMatch(/\*\*Personal data\.\*\*/);
    for (const name of ['dialpad_list_calls', 'dialpad_get_call', 'dialpad_get_call_transcript', 'dialpad_create_recording_share_link', 'dialpad_list_contacts']) {
      expect(tool(name).description).toMatch(/personal data/i);
    }
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdialpad_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdialpad_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Authentication');
    expect(a.instructions).toContain('calls:list');
    expect(a.instructions).toMatch(/1200 per minute/);
    expect(a.instructions).toMatch(/10 per minute/);
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

  // Every path below is a path of dialpad_api_spec.json with the same method.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['dialpad_get_company', {}, 'GET', '/company'],
    ['dialpad_list_users', {}, 'GET', '/users'],
    ['dialpad_get_user', { user_id: 'me' }, 'GET', '/users/me'],
    ['dialpad_list_offices', {}, 'GET', '/offices'],
    ['dialpad_get_office', { office_id: '123' }, 'GET', '/offices/123'],
    ['dialpad_list_call_centers', {}, 'GET', '/callcenters'],
    ['dialpad_get_call_center', { call_center_id: '77' }, 'GET', '/callcenters/77'],
    ['dialpad_get_call_center_status', { call_center_id: '77' }, 'GET', '/callcenters/77/status'],
    ['dialpad_list_departments', {}, 'GET', '/departments'],
    ['dialpad_get_department', { department_id: '88' }, 'GET', '/departments/88'],
    ['dialpad_list_numbers', {}, 'GET', '/numbers'],
    ['dialpad_list_calls', {}, 'GET', '/call'],
    ['dialpad_get_call', { call_id: '6219523485581312' }, 'GET', '/call/6219523485581312'],
    ['dialpad_get_call_transcript', { call_id: '6219523485581312' }, 'GET', '/transcripts/6219523485581312'],
    ['dialpad_get_call_transcript_url', { call_id: '6219523485581312' }, 'GET', '/transcripts/6219523485581312/url'],
    ['dialpad_initiate_call', { user_id: 5, phone_number: '+14155550123' }, 'POST', '/call'],
    ['dialpad_send_sms', { user_id: 5, to_numbers: ['+14155550123'], text: 'Hi' }, 'POST', '/sms'],
    ['dialpad_list_contacts', {}, 'GET', '/contacts'],
    ['dialpad_get_contact', { contact_id: 'abc' }, 'GET', '/contacts/abc'],
    ['dialpad_create_contact', { first_name: 'Ada', last_name: 'Lovelace' }, 'POST', '/contacts'],
    ['dialpad_start_stats_export', { stat_type: 'calls', export_type: 'stats' }, 'POST', '/stats'],
    ['dialpad_get_stats_export', { request_id: 'r1' }, 'GET', '/stats/r1'],
    ['dialpad_create_recording_share_link', { recording_id: 'rec1', recording_type: 'callrecording' }, 'POST', '/recordingsharelink'],
    ['dialpad_get_recording_share_link', { link_id: 'l1' }, 'GET', '/recordingsharelink/l1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with the Bearer key', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('uses the documented query names: cursor, started_after/before in ms, target filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('dialpad_list_calls', { started_after: 1760486400000, started_before: 1760572800000, target_id: 5, target_type: 'user', cursor: 'c2' });
    expect(sent().params).toEqual({ started_after: 1760486400000, started_before: 1760572800000, target_id: 5, target_type: 'user', cursor: 'c2' });
    mockedAxios.mockClear();
    await call('dialpad_list_users', { email: 'ada@example.com', state: 'active', company_admin: false });
    expect(sent().params).toEqual({ email: 'ada@example.com', state: 'active', company_admin: false });
    mockedAxios.mockClear();
    await call('dialpad_list_call_centers', { office_id: 3, name_search: 'Support' });
    expect(sent().params).toEqual({ office_id: 3, name_search: 'Support' });
    mockedAxios.mockClear();
    await call('dialpad_list_contacts', { owner_id: '5', include_local: true });
    expect(sent().params).toEqual({ owner_id: '5', include_local: true });
  });

  it('builds the documented bodies for calls, texts, contacts, stats and share links', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('dialpad_initiate_call', { user_id: 5, phone_number: '+14155550123', outbound_caller_id: 'blocked', group_id: 9, group_type: 'callcenter' });
    expect(sent().data).toEqual({ user_id: 5, phone_number: '+14155550123', outbound_caller_id: 'blocked', group_id: 9, group_type: 'callcenter' });
    expect(tool('dialpad_initiate_call').parameters.required).toEqual(['user_id', 'phone_number']);
    mockedAxios.mockClear();
    await call('dialpad_send_sms', { user_id: 5, to_numbers: ['+14155550123'], text: 'Hello', from_number: '+14155550100' });
    expect(sent().data).toEqual({ user_id: 5, to_numbers: ['+14155550123'], text: 'Hello', from_number: '+14155550100' });
    mockedAxios.mockClear();
    await call('dialpad_create_contact', { first_name: 'Ada', last_name: 'Lovelace', phones: ['+14155550123'], emails: ['ada@example.com'], company_name: 'Engines' });
    expect(sent().data).toEqual({ first_name: 'Ada', last_name: 'Lovelace', phones: ['+14155550123'], emails: ['ada@example.com'], company_name: 'Engines' });
    mockedAxios.mockClear();
    await call('dialpad_start_stats_export', { stat_type: 'calls', export_type: 'records', days_ago_start: 7, days_ago_end: 0, timezone: 'Europe/Berlin' });
    expect(sent().data).toEqual({ stat_type: 'calls', export_type: 'records', days_ago_start: 7, days_ago_end: 0, timezone: 'Europe/Berlin' });
    mockedAxios.mockClear();
    await call('dialpad_create_recording_share_link', { recording_id: 'rec1', recording_type: 'voicemail', privacy: 'company' });
    expect(sent().data).toEqual({ recording_id: 'rec1', recording_type: 'voicemail', privacy: 'company' });
  });

  it('keeps cursor paging and the useful call fields, recording URLs and transcript text', () => {
    const raw = {
      cursor: 'next1',
      items: [
        {
          call_id: 1, direction: 'inbound', state: 'hangup', date_started: 1760486400000, date_connected: 1760486405000, date_ended: 1760486460000,
          duration: 55000, external_number: '+14155550123', internal_number: '+14155550100',
          contact: { id: 'c1', name: 'Ada', phone: '+14155550123', email: 'ada@example.com', type: 'shared' },
          target: { id: '5', name: 'Bob', phone: '+14155550100', email: 'bob@example.com', type: 'user' },
          recording_details: [{ id: 'rec1', recording_type: 'callrecording', duration: 50000, start_time: 1760486406000, url: 'https://dialpad.com/r/rec1' }],
          routing_breadcrumbs: [{ a: 1 }], transcription_text: 'Hello there', was_recorded: true, labels: ['sales'],
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('dialpad_list_calls').responseMapping as any).value as any;
    expect(out.cursor).toBe('next1');
    expect(out.items[0]).toMatchObject({
      call_id: 1, direction: 'inbound', duration: 55000, transcription_text: 'Hello there', labels: ['sales'],
      contact: { id: 'c1', name: 'Ada', phone: '+14155550123' },
      recording_details: [{ id: 'rec1', recording_type: 'callrecording', duration: 50000, start_time: 1760486406000, url: 'https://dialpad.com/r/rec1' }],
    });
    expect(out.items[0].routing_breadcrumbs).toBeUndefined();
    const transcript = { call_id: 1, lines: [{ type: 'transcript', time: '00:01', name: 'Ada', contact_id: 'c1', content: 'Hi' }, { type: 'moment', time: '00:02', name: 'Ai', content: 'action_item' }] };
    expect(applyResponseTransform(transcript, tool('dialpad_get_call_transcript').responseMapping as any).value).toEqual(transcript);
  });
});

const live = process.env.RUN_DIALPAD_LIVE === '1' ? describe : describe.skip;
live('dialpad adapter: live', () => {
  const real = !!process.env.DIALPAD_API_KEY;
  const env = () => ({ DIALPAD_API_KEY: process.env.DIALPAD_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['dialpad_list_offices', {}],
    ['dialpad_list_calls', {}],
    ['dialpad_get_call_transcript', { call_id: '1' }],
    ['dialpad_send_sms', { user_id: 1, to_numbers: ['+14155550123'], text: 'never sent' }],
  ])('%s reaches Dialpad and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route with the same wrong key (routing comes before the key check)', async () => {
    await expect(run({ method: 'GET', path: '/amcp-no-such-route' }, {})).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads offices, users, call centers and the latest calls, and starts a stats export', async () => {
    const offices = await shaped('dialpad_list_offices', {}, env());
    expect(Array.isArray(offices.items)).toBe(true);
    const users = await shaped('dialpad_list_users', { state: 'active' }, env());
    expect(Array.isArray(users.items)).toBe(true);
    const centers = await shaped('dialpad_list_call_centers', {}, env());
    expect(Array.isArray(centers.items)).toBe(true);
    const calls = await shaped('dialpad_list_calls', { started_after: Date.now() - 7 * 86400000 }, env());
    expect(Array.isArray(calls.items)).toBe(true);
    const stats = await shaped('dialpad_start_stats_export', { stat_type: 'calls', export_type: 'stats', days_ago_start: 1, days_ago_end: 0 }, env());
    expect(stats.request_id).toBeDefined();
    const status = await shaped('dialpad_get_stats_export', { request_id: stats.request_id }, env());
    expect(typeof status.status).toBe('string');
  }, 60000);

  const writes = real && process.env.RUN_DIALPAD_LIVE_WRITES === '1' && !!process.env.DIALPAD_TEST_USER_ID;
  (writes ? it : it.skip)('creates one local test contact for the test user (nothing is sent or dialed)', async () => {
    const created = await shaped(
      'dialpad_create_contact',
      { first_name: 'AnythingMCP', last_name: 'Live check', owner_id: process.env.DIALPAD_TEST_USER_ID, phones: ['+14155550100'] },
      env(),
    );
    expect(created.id).toBeDefined();
    expect(created.first_name).toBe('AnythingMCP');
  }, 30000);
});
