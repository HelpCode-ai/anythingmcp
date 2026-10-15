import axios from 'axios';
import * as adapter from './aircall.json';
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
 * Two layers of verification for the Aircall adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic auth with the API ID and token,
 *      every tool's method, URL, query and body through the real RestEngine,
 *      checked against the Aircall Public API reference
 *      (developers.aircall.io/api-references, read 15 Oct 2026; Aircall
 *      publishes no OpenAPI file or SDK). Also which tools only read, that
 *      every write asks for confirmation, that the contact delete ships off and
 *      that webhook tokens never reach the model.
 *
 *   2. Live: skipped unless RUN_AIRCALL_LIVE=1. Without credentials it checks
 *      that Aircall refuses a wrong key with 403 on the real routes while a
 *      made-up route answers 404 (the gateway routes before it checks the key).
 *      With AIRCALL_API_ID and AIRCALL_API_TOKEN it reads the company, users,
 *      numbers, tags and recent calls, shaped by each tool's response mapping
 *      as production does. Nothing is written unless RUN_AIRCALL_LIVE_WRITES=1
 *      too: then one test contact is created, renamed and deleted again. No
 *      call is ever placed by this spec.
 *
 *        RUN_AIRCALL_LIVE=1 AIRCALL_API_ID=... AIRCALL_API_TOKEN=... \
 *          npx jest src/adapters/intl/aircall.live.spec.ts
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

const HOST = 'https://api.aircall.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_ID = 'amcp' + '0'.repeat(28);
const FAKE_TOKEN = 'tok' + '0'.repeat(29);
const ENV: Record<string, string> = { AIRCALL_API_ID: FAKE_ID, AIRCALL_API_TOKEN: FAKE_TOKEN };
const BASIC = 'Basic ' + Buffer.from(`${FAKE_ID}:${FAKE_TOKEN}`).toString('base64');

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
// What the model receives: the raw answer shaped by the tool's response mapping.
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'aircall_archive_call',
  'aircall_comment_call',
  'aircall_create_contact',
  'aircall_delete_contact',
  'aircall_dial_number',
  'aircall_start_outbound_call',
  'aircall_tag_call',
  'aircall_update_contact',
];
// Answer 201 or 204 with no body worth shaping.
const NO_BODY = ['aircall_comment_call', 'aircall_tag_call', 'aircall_start_outbound_call', 'aircall_dial_number', 'aircall_delete_contact'];

describe('aircall adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with HTTP Basic auth (API ID as user, API token as password) and pings', () => {
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('aircall');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{AIRCALL_API_ID}}', password: '{{AIRCALL_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/ping');
    expect(a.requiredEnvVars).toEqual(['AIRCALL_API_ID', 'AIRCALL_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.AIRCALL_API_ID).toMatchObject({ kind: 'credential', required: true });
    expect(meta.AIRCALL_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('probes with the ping and explains the 403 Aircall answers to a wrong key', () => {
    expect(a.probe).toEqual({ tool: 'aircall_ping' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/API ID and token/);
  });

  it('prefixes every tool with aircall_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^aircall_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks only the writes as writes, asks for confirmation and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
    expect(tool('aircall_start_outbound_call').description).toMatch(/cost money/);
    expect(tool('aircall_start_outbound_call').description).toMatch(/only after the user confirms/);
    expect(annotationsOf(tool('aircall_start_outbound_call'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('aircall_archive_call'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(annotationsOf(tool('aircall_delete_contact'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['aircall_delete_contact']);
    expect(tool('aircall_delete_contact').description).toMatch(/switched off/);
  });

  it('says that calls, recordings and transcripts are personal data', () => {
    expect(a.instructions).toMatch(/\*\*Personal data\.\*\*/);
    for (const name of ['aircall_list_calls', 'aircall_get_call', 'aircall_get_call_transcription', 'aircall_get_call_summary', 'aircall_list_contacts']) {
      expect(tool(name).description).toMatch(/personal data/i);
    }
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\baircall_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\baircall_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Generate an API key');
    expect(a.instructions).toMatch(/120 requests per minute/);
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
      if (NO_BODY.includes(t.name)) continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['aircall_ping', {}, 'GET', '/v1/ping'],
    ['aircall_get_company', {}, 'GET', '/v1/company'],
    ['aircall_list_users', {}, 'GET', '/v2/users'],
    ['aircall_get_user', { user_id: 'john.doe@example.com' }, 'GET', '/v2/users/john.doe@example.com'],
    ['aircall_list_user_numbers', { user_id: 456 }, 'GET', '/v2/users/456/numbers'],
    ['aircall_get_user_availability', { user_id: 456 }, 'GET', '/v1/users/456/availability'],
    ['aircall_list_user_availabilities', {}, 'GET', '/v1/users/availabilities'],
    ['aircall_list_teams', {}, 'GET', '/v1/teams'],
    ['aircall_get_team', { team_id: 678 }, 'GET', '/v1/teams/678'],
    ['aircall_list_numbers', {}, 'GET', '/v1/numbers'],
    ['aircall_get_number', { number_id: 1234 }, 'GET', '/v1/numbers/1234'],
    ['aircall_list_calls', {}, 'GET', '/v1/calls'],
    ['aircall_search_calls', { direction: 'inbound' }, 'GET', '/v1/calls/search'],
    ['aircall_get_call', { call_id: 812 }, 'GET', '/v1/calls/812'],
    ['aircall_get_call_transcription', { call_id: 812 }, 'GET', '/v1/calls/812/transcription'],
    ['aircall_get_call_summary', { call_id: 812 }, 'GET', '/v1/calls/812/summary'],
    ['aircall_get_call_sentiments', { call_id: 812 }, 'GET', '/v1/calls/812/sentiments'],
    ['aircall_get_call_topics', { call_id: 812 }, 'GET', '/v1/calls/812/topics'],
    ['aircall_get_call_action_items', { call_id: 812 }, 'GET', '/v1/calls/812/action_items'],
    ['aircall_comment_call', { call_id: 812, content: 'Call back' }, 'POST', '/v1/calls/812/comments'],
    ['aircall_tag_call', { call_id: 812, tag_ids: [545] }, 'POST', '/v1/calls/812/tags'],
    ['aircall_archive_call', { call_id: 812 }, 'PUT', '/v1/calls/812/archive'],
    ['aircall_list_contacts', {}, 'GET', '/v1/contacts'],
    ['aircall_search_contacts', { phone_number: '+14155550123' }, 'GET', '/v1/contacts/search'],
    ['aircall_get_contact', { contact_id: 710 }, 'GET', '/v1/contacts/710'],
    ['aircall_create_contact', { phone_numbers: [{ label: 'Work', value: '+14155550123' }] }, 'POST', '/v1/contacts'],
    ['aircall_update_contact', { contact_id: 710, company_name: 'Lerox Inc.' }, 'POST', '/v1/contacts/710'],
    ['aircall_delete_contact', { contact_id: 710 }, 'DELETE', '/v1/contacts/710'],
    ['aircall_list_tags', {}, 'GET', '/v1/tags'],
    ['aircall_start_outbound_call', { user_id: 456, number_id: 123, to: '+18001231234' }, 'POST', '/v1/users/456/calls'],
    ['aircall_dial_number', { user_id: 456, to: '+18001231234' }, 'POST', '/v1/users/456/dial'],
    ['aircall_list_webhooks', {}, 'GET', '/v1/webhooks'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with Basic auth', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    // axios turns `auth` into the Authorization header; either form is Basic.
    const header = req.headers.Authorization ?? (req.auth ? 'Basic ' + Buffer.from(`${req.auth.username}:${req.auth.password}`).toString('base64') : undefined);
    expect(header).toBe(BASIC);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('pages with page and per_page (20 by default) and filters by creation time', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('aircall_list_calls', { from: '1760486400', to: '1760572800', order: 'desc', fetch_contact: true, page: 2 });
    expect(sent().params).toEqual({ from: '1760486400', to: '1760572800', order: 'desc', fetch_contact: true, page: 2, per_page: 20 });
  });

  it('searches calls by direction, user, number and every tag (tags[]=…)', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('aircall_search_calls', { direction: 'outbound', user_id: 456, phone_number: '+14155550123', tag_ids: [545, 546], fetch_short_urls: true });
    expect(sent().params).toEqual({ direction: 'outbound', user_id: 456, phone_number: '+14155550123', 'tags[]': [545, 546], fetch_short_urls: true, per_page: 20 });
    expect(sent().paramsSerializer(sent().params)).toContain('tags%5B%5D=545&tags%5B%5D=546');
  });

  it('builds the documented bodies for notes, tags, contacts and calls', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('aircall_comment_call', { call_id: 812, content: 'Please call back this customer!' });
    expect(sent().data).toEqual({ content: 'Please call back this customer!' });
    mockedAxios.mockClear();
    await call('aircall_tag_call', { call_id: 812, tag_ids: [545] });
    expect(sent().data).toEqual({ tags: [545] });
    mockedAxios.mockClear();
    const phones = [{ label: 'Work', value: '+19001112222' }];
    const emails = [{ label: 'Office', value: 'gary@example.com' }];
    await call('aircall_create_contact', { first_name: 'Gary', last_name: 'Jennings', information: 'external_custom_id:87123', phone_numbers: phones, emails });
    expect(sent().data).toEqual({ first_name: 'Gary', last_name: 'Jennings', information: 'external_custom_id:87123', phone_numbers: phones, emails });
    expect(tool('aircall_create_contact').parameters.required).toEqual(['phone_numbers']);
    mockedAxios.mockClear();
    await call('aircall_update_contact', { contact_id: 710, first_name: 'Vicente UPDATED', company_name: 'Lerox Inc.' });
    expect(sent().data).toEqual({ first_name: 'Vicente UPDATED', company_name: 'Lerox Inc.' });
    mockedAxios.mockClear();
    await call('aircall_start_outbound_call', { user_id: 456, number_id: 123, to: '+18001231234' });
    expect(sent().data).toEqual({ number_id: 123, to: '+18001231234' });
    mockedAxios.mockClear();
    await call('aircall_dial_number', { user_id: 456, to: '+18001231234' });
    expect(sent().data).toEqual({ to: '+18001231234' });
  });

  it('shortens calls to the useful fields and keeps recording links and notes', () => {
    // Shape of the documented List all Calls example.
    const raw = {
      meta: { count: 1, total: 1, current_page: 1, per_page: 20, next_page_link: null, previous_page_link: null },
      calls: [
        {
          id: 812, sid: 'CA1234567890', direct_link: 'https://api.aircall.io/v1/calls/812', direction: 'outbound', status: 'done',
          missed_call_reason: null, started_at: 1584998199, answered_at: 1584998205, ended_at: 1584998210, duration: 11,
          voicemail: null, recording: 'https://example.com/rec.mp3', asset: null, raw_digits: '+1 800-123-4567',
          user: { id: 456, direct_link: 'x', name: 'John Doe', email: 'john.doe@aircall.io', available: true, time_zone: 'America/New_York' },
          contact: null, archived: false, assigned_to: null, transferred_by: null, transferred_to: null, cost: '2.34',
          number: { id: 1234, name: 'French Office', digits: '+33 1 76 11 11 11', messages: { welcome: 'https://example.com/w.mp3' } },
          comments: [{ id: 735, content: 'Please call back this customer!', posted_at: 1587994808, posted_by: { id: 456, name: 'John Doe' } }],
          tags: [{ id: 678, name: 'General Inquiries', color: '#0662B5' }],
          teams: [{ id: 1, name: 'Sales', users: [{ id: 456 }] }],
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('aircall_list_calls').responseMapping as any).value as any;
    expect(out.meta).toEqual(raw.meta);
    expect(out.calls[0]).toMatchObject({
      id: 812, direction: 'outbound', duration: 11, recording: 'https://example.com/rec.mp3',
      user: { id: 456, name: 'John Doe', email: 'john.doe@aircall.io' },
      number: { id: 1234, name: 'French Office', digits: '+33 1 76 11 11 11' },
      comments: [{ id: 735, content: 'Please call back this customer!', posted_at: 1587994808, posted_by: 'John Doe' }],
      tags: [{ id: 678, name: 'General Inquiries' }],
      teams: [{ id: 1, name: 'Sales' }],
    });
    expect(JSON.stringify(out)).not.toContain('messages');
    expect(JSON.stringify(out)).not.toContain('cost');
  });

  it('flattens transcripts, summaries and action items as documented', () => {
    const transcript = {
      transcription: {
        id: 68271, call_id: 5237603, call_created_at: '2024-07-26T13:30:54.000Z', type: 'call',
        content: { language: 'en', utterances: [{ start_time: 12.54, end_time: 13.8, text: 'Okay,', participant_type: 'external', phone_number: '+33679198915' }] },
      },
    };
    expect(applyResponseTransform(transcript, tool('aircall_get_call_transcription').responseMapping as any).value).toEqual({
      call_id: 5237603, call_created_at: '2024-07-26T13:30:54.000Z', language: 'en',
      utterances: [{ start_time: 12.54, end_time: 13.8, participant_type: 'external', phone_number: '+33679198915', text: 'Okay,' }],
    });
    const summary = { summary: { id: 974, call_id: 786, created_at: '2024-08-27T10:54:16.000Z', content: 'Short summary of the call' } };
    expect(applyResponseTransform(summary, tool('aircall_get_call_summary').responseMapping as any).value).toEqual({
      call_id: 786, created_at: '2024-08-27T10:54:16.000Z', content: 'Short summary of the call',
    });
    const topics = { topic: { id: 786, call_id: 123, created_at: '2024-08-27T10:54:16.000Z', content: ['payment', 'billing'] } };
    expect((applyResponseTransform(topics, tool('aircall_get_call_topics').responseMapping as any).value as any).topics).toEqual(['payment', 'billing']);
    const items = { call_id: 123, action_items: [{ ai_generated: true, content: 'Schedule meeting', created_at: '2024-08-27T10:54:16.000Z', id: 2 }] };
    expect(applyResponseTransform(items, tool('aircall_get_call_action_items').responseMapping as any).value).toEqual({
      call_id: 123, action_items: [{ id: 2, content: 'Schedule meeting', ai_generated: true, created_at: '2024-08-27T10:54:16.000Z' }],
    });
  });

  it('never hands a webhook signing token to the model', () => {
    const raw = {
      meta: { count: 1 },
      webhooks: [{ webhook_id: 'c2501111', direct_link: 'x', created_at: '2020-04-01T15:56:18.000Z', url: 'https://example.com/hook', active: true, token: 'abc123def456ghi789', events: ['call.assigned'] }],
    };
    const out = applyResponseTransform(raw, tool('aircall_list_webhooks').responseMapping as any).value as any;
    expect(out.webhooks[0]).toEqual({ webhook_id: 'c2501111', url: 'https://example.com/hook', active: true, events: ['call.assigned'], created_at: '2020-04-01T15:56:18.000Z' });
    expect(JSON.stringify(out)).not.toContain('abc123def456ghi789');
  });
});

const live = process.env.RUN_AIRCALL_LIVE === '1' ? describe : describe.skip;
live('aircall adapter: live', () => {
  const real = !!(process.env.AIRCALL_API_ID && process.env.AIRCALL_API_TOKEN);
  const env = () => ({ AIRCALL_API_ID: process.env.AIRCALL_API_ID!, AIRCALL_API_TOKEN: process.env.AIRCALL_API_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['aircall_ping', {}],
    ['aircall_list_calls', { per_page: 1 }],
    ['aircall_get_call_transcription', { call_id: 1 }],
    ['aircall_create_contact', { phone_numbers: [{ label: 'Work', value: '+14155550123' }] }],
  ])('%s reaches Aircall and is refused with a wrong key (403)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  it('answers 404 on a made-up route with the same wrong key (routing comes before the key check)', async () => {
    await expect(run({ method: 'GET', path: '/v1/amcp-no-such-route' }, {})).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads the company, users, numbers, tags and the latest calls', async () => {
    expect(await shaped('aircall_ping', {}, env())).toEqual({ ping: 'pong' });
    const company = await shaped('aircall_get_company', {}, env());
    expect(typeof company.name).toBe('string');
    const users = await shaped('aircall_list_users', { per_page: 5 }, env());
    expect(Array.isArray(users.users)).toBe(true);
    const numbers = await shaped('aircall_list_numbers', { per_page: 5 }, env());
    expect(Array.isArray(numbers.numbers)).toBe(true);
    const tags = await shaped('aircall_list_tags', {}, env());
    expect(Array.isArray(tags.tags)).toBe(true);
    const calls = await shaped('aircall_list_calls', { order: 'desc', per_page: 3 }, env());
    expect(Array.isArray(calls.calls)).toBe(true);
    if (calls.calls[0]) {
      const one = await shaped('aircall_get_call', { call_id: calls.calls[0].id }, env());
      expect(one.call.id).toBe(calls.calls[0].id);
    }
    const webhooks = await shaped('aircall_list_webhooks', {}, env());
    expect(JSON.stringify(webhooks)).not.toMatch(/"token"/);
  }, 60000);

  const writes = real && process.env.RUN_AIRCALL_LIVE_WRITES === '1';
  (writes ? it : it.skip)('creates, renames and deletes one test contact (no call is placed)', async () => {
    const created = await shaped(
      'aircall_create_contact',
      { first_name: 'AnythingMCP', last_name: 'Live check', phone_numbers: [{ label: 'Work', value: '+14155550100' }] },
      env(),
    );
    expect(created.contact.id).toBeDefined();
    const id = created.contact.id;
    try {
      const updated = await shaped('aircall_update_contact', { contact_id: id, company_name: 'AnythingMCP test' }, env());
      expect(updated.contact.company_name).toBe('AnythingMCP test');
    } finally {
      await call('aircall_delete_contact', { contact_id: id }, env());
    }
  }, 60000);
});
