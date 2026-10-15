import axios from 'axios';
import { buildClientSchema, getIntrospectionQuery, Kind, OperationDefinitionNode, parse, validate } from 'graphql';
import * as adapter from './fireflies.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Fireflies.ai adapter (GraphQL):
 *
 *   1. Static: always runs. Every operation parses, its variables match the
 *      tool's queryParams one to one, and each request goes through the real
 *      GraphqlEngine with the Bearer key. Operation names, argument names and
 *      variable types were checked on 15 Oct 2026 against Fireflies' API
 *      reference (docs.fireflies.ai) and the GraphQL documents in Fireflies'
 *      own Node SDK and n8n node (github.com/firefliesai). Introspection needs
 *      a key, so the schema itself is only checked in the live layer. Also:
 *      which tools write, that they confirm first, that delete and role
 *      changes ship switched off, and the transcript paging.
 *
 *   2. Live: skipped unless RUN_FIREFLIES_LIVE=1. Without a key it checks that
 *      Fireflies refuses a wrong one with auth_failed (Fireflies sends it with
 *      HTTP 500, and checks the key before running the operation). With
 *      FIREFLIES_API_KEY it validates every operation against the introspected
 *      schema and reads the user, the team, meetings, one meeting and its text,
 *      soundbites, AskFred threads and live meetings. RUN_FIREFLIES_LIVE_WRITES=1
 *      with FIREFLIES_TEST_TRANSCRIPT_ID also asks AskFred one question about
 *      that meeting (this spends AI credits).
 *
 *        RUN_FIREFLIES_LIVE=1 FIREFLIES_API_KEY=... \
 *          npx jest src/adapters/intl/fireflies.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const post = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(Object.create(actual.default), actual.default, { post, __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedPost = (axios as unknown as { post: jest.Mock }).post;
const actualAxios = (axios as unknown as { __actual: typeof axios }).__actual;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
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
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    config: { graphqlBuiltinsOff: string[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const operation = (t: Tool) =>
  parse(t.endpointMapping.path).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)!;
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'GRAPHQL', endpointMapping: t.endpointMapping, annotations: t.annotations });

const URL = 'https://api.fireflies.ai/graphql';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { FIREFLIES_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools for a GraphQL connector.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new GraphqlEngine({} as OAuth2TokenService, {} as LoginTokenService, {} as GraphqlSchemaService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    },
    endpointMapping as any,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));

const WRITES = [
  'fireflies_add_bot_to_live_meeting',
  'fireflies_ask_about_meeting',
  'fireflies_ask_across_meetings',
  'fireflies_ask_follow_up',
  'fireflies_create_bite',
  'fireflies_delete_transcript',
  'fireflies_set_user_role',
  'fireflies_upload_audio',
];
const BUILTINS = ['fireflies_graphql_query', 'fireflies_graphql_mutation', 'fireflies_graphql_subscription', 'fireflies_graphql_schema', 'fireflies_graphql_schema_url'];

describe('fireflies adapter: static spec conformance', () => {
  beforeEach(() => mockedPost.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('posts to the public GraphQL API with the API key as Bearer', () => {
    expect(a.category).toBe('productivity');
    expect(a.icon).toBe('fireflies');
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe(URL);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{FIREFLIES_API_KEY}}' });
    expect(a.probe.tool).toBe('fireflies_get_current_user');
    expect(a.requiredEnvVars).toEqual(['FIREFLIES_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.FIREFLIES_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.FIREFLIES_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'short', 'has a space in it ok']) expect(pattern.test(bad)).toBe(false);
    // A wrong key comes back as HTTP 500 with the code auth_failed.
    for (const key of ['401', '429', '500', 'auth_failed']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['500']).toMatch(/auth_failed/);
  });

  it('prefixes every tool with fireflies_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^fireflies_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every operation parses, matches its method, and maps each variable to a parameter', () => {
    for (const t of a.tools) {
      const op = operation(t);
      expect(`${t.name}:${op.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      expect(`${t.name}:${Object.keys(t.endpointMapping.queryParams ?? {}).sort()}`).toBe(`${t.name}:${declared}`);
      for (const value of Object.values(t.endpointMapping.queryParams ?? {})) {
        expect(Object.keys(t.parameters.properties ?? {})).toContain(value.slice(1));
      }
      for (const required of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(required);
      // A required parameter is a non-null variable and the other way round.
      for (const d of op.variableDefinitions ?? []) {
        const param = t.endpointMapping.queryParams![d.variable.name.value].slice(1);
        expect(`${t.name}.${param}:${d.type.kind === Kind.NON_NULL_TYPE}`).toBe(`${t.name}.${param}:${(t.parameters.required ?? []).includes(param)}`);
      }
    }
  });

  it('uses the argument names and variable types of the official clients', () => {
    const head = (name: string) => tool(name).endpointMapping.path.split('{')[0];
    expect(head('fireflies_list_transcripts')).toContain('$fromDate: DateTime, $toDate: DateTime, $organizers: [String!], $participants: [String!]');
    expect(tool('fireflies_list_transcripts').endpointMapping.path).toContain('user_id: $userId, mine: $mine, channel_id: $channelId');
    expect(head('fireflies_search_transcripts')).toContain('$scope: String');
    expect(head('fireflies_list_bites')).toContain('$transcriptId: ID');
    expect(head('fireflies_get_bite')).toContain('$id: ID!');
    expect(tool('fireflies_create_bite').endpointMapping.path).toContain('createBite(transcript_id: $transcriptId, start_time: $startTime, end_time: $endTime');
    expect(head('fireflies_create_bite')).toContain('$privacies: [BitePrivacy!]');
    expect(head('fireflies_add_bot_to_live_meeting')).toContain('$attendees: [AttendeeInput!]');
    expect(head('fireflies_set_user_role')).toContain('$role: Role!');
    expect(tool('fireflies_get_askfred_thread').endpointMapping.path).toContain('askfred_thread(id: $id)');
  });

  it('writes are exactly the mutations; each confirms, the bot is announced, delete and role ship switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'mutation').map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) {
      if (name === 'fireflies_ask_follow_up') continue; // the first question already asked
      expect(`${name}:${/wait for their yes/.test(tool(name).description)}`).toBe(`${name}:true`);
    }
    expect(tool('fireflies_add_bot_to_live_meeting').description).toMatch(/visible participant/);
    expect(tool('fireflies_add_bot_to_live_meeting').description).toMatch(/being recorded/);
    for (const name of ['fireflies_ask_about_meeting', 'fireflies_ask_across_meetings', 'fireflies_ask_follow_up']) {
      expect(tool(name).description).toMatch(/AI credits/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['fireflies_delete_transcript', 'fireflies_set_user_role']);
    for (const name of WRITES) {
      if (name === 'fireflies_delete_transcript' || name === 'fireflies_set_user_role') continue;
      expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    }
  });

  it('installs the generic mutation and subscription helpers switched off', () => {
    expect(a.connector.config.graphqlBuiltinsOff).toEqual(['mutation', 'subscription']);
    // Once the catalog is regenerated the helpers exist; check how they install.
    const listed = getAdapter('fireflies');
    if (!listed) return;
    const byName = new Map((listed.tools as Array<{ name: string; enabled?: boolean }>).map((t) => [t.name, t]));
    expect(byName.get('fireflies_graphql_mutation')?.enabled).toBe(false);
    expect(byName.get('fireflies_graphql_subscription')?.enabled).toBe(false);
    expect(byName.get('fireflies_graphql_query')?.enabled).not.toBe(false);
  });

  it('only points the model at tools that exist, explains personal data and setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfireflies_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfireflies_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect([...names, ...BUILTINS]).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/personal data/);
    expect(a.instructions).toContain('Integrations, Fireflies API');
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

  const table: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['fireflies_get_current_user', {}, {}],
    ['fireflies_list_users', {}, {}],
    ['fireflies_list_channels', {}, {}],
    [
      'fireflies_list_transcripts',
      { from_date: '2026-10-01T00:00:00.000Z', participants: ['ana@example.com'], mine: true },
      { fromDate: '2026-10-01T00:00:00.000Z', participants: ['ana@example.com'], mine: true, limit: 20 },
    ],
    ['fireflies_search_transcripts', { keyword: 'pricing' }, { keyword: 'pricing', scope: 'all', limit: 20 }],
    ['fireflies_get_transcript', { transcript_id: 't1' }, { id: 't1' }],
    ['fireflies_get_transcript_text', { transcript_id: 't1' }, { id: 't1' }],
    ['fireflies_get_transcript_text_more', { transcript_id: 't1' }, { id: 't1' }],
    ['fireflies_list_bites', { transcript_id: 't1' }, { transcriptId: 't1', limit: 20 }],
    ['fireflies_get_bite', { bite_id: 'b1' }, { id: 'b1' }],
    [
      'fireflies_create_bite',
      { transcript_id: 't1', start_second: 120, end_second: 180, name: 'Decision', privacies: ['team'] },
      { transcriptId: 't1', startTime: 120, endTime: 180, name: 'Decision', privacies: ['team'] },
    ],
    ['fireflies_ask_about_meeting', { transcript_id: 't1', question: 'What was decided?' }, { transcriptId: 't1', question: 'What was decided?' }],
    [
      'fireflies_ask_across_meetings',
      { question: 'Common objections?', start_time: '2026-09-01T00:00:00Z', organizers: ['ana@example.com'] },
      { question: 'Common objections?', startTime: '2026-09-01T00:00:00Z', organizers: ['ana@example.com'] },
    ],
    ['fireflies_ask_follow_up', { thread_id: 'th1', question: 'And who owns it?' }, { threadId: 'th1', question: 'And who owns it?' }],
    ['fireflies_list_askfred_threads', {}, {}],
    ['fireflies_get_askfred_thread', { thread_id: 'th1' }, { id: 'th1' }],
    ['fireflies_list_active_meetings', { email: 'ana@example.com' }, { email: 'ana@example.com' }],
    [
      'fireflies_upload_audio',
      { url: 'https://example.com/call.mp3', title: 'Call', language: 'de' },
      { url: 'https://example.com/call.mp3', title: 'Call', customLanguage: 'de' },
    ],
    [
      'fireflies_add_bot_to_live_meeting',
      { meeting_link: 'https://meet.google.com/abc-defg-hij', duration_minutes: 30, attendees: [{ displayName: 'Ana', email: 'ana@example.com' }] },
      { meetingLink: 'https://meet.google.com/abc-defg-hij', duration: 30, attendees: [{ displayName: 'Ana', email: 'ana@example.com' }] },
    ],
    ['fireflies_delete_transcript', { transcript_id: 't1' }, { id: 't1' }],
    ['fireflies_set_user_role', { user_id: 'u1', role: 'user' }, { userId: 'u1', role: 'user' }],
  ];

  it('lists every tool in the request table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s posts its operation with the Bearer key and the right variables', async (name, params, variables) => {
    mockedPost.mockResolvedValue({ data: { data: {} } });
    await call(name, params);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(URL);
    expect(body.query).toBe(tool(name).endpointMapping.path);
    // undefined variables are dropped when the body is serialized.
    expect(JSON.parse(JSON.stringify(body.variables))).toEqual(variables);
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(body)).not.toContain('{{');
  });

  it('reports a GraphQL error such as object_not_found as a failed call', async () => {
    mockedPost.mockResolvedValue({ data: { errors: [{ code: 'object_not_found', message: 'Transcript not found' }], data: null } });
    await expect(call('fireflies_get_transcript', { transcript_id: 'x' })).rejects.toThrow(/object_not_found/);
  });

  it('shapes meeting lists, one meeting and the AskFred answer', () => {
    const list = shape('fireflies_list_transcripts', {
      transcripts: [
        {
          id: 't1',
          title: 'Weekly sync',
          dateString: '2026-10-14T09:00:00.000Z',
          duration: 31.5,
          organizer_email: 'ana@example.com',
          participants: ['ana@example.com', 'bo@example.com'],
          transcript_url: 'https://app.fireflies.ai/view/t1',
          is_live: false,
          summary: { short_summary: 'Agreed on the launch date.' },
        },
      ],
    });
    expect(list).toEqual({
      meetings: [
        {
          id: 't1',
          title: 'Weekly sync',
          date: '2026-10-14T09:00:00.000Z',
          durationMinutes: 31.5,
          organizer: 'ana@example.com',
          participants: ['ana@example.com', 'bo@example.com'],
          shortSummary: 'Agreed on the launch date.',
          isLive: false,
          url: 'https://app.fireflies.ai/view/t1',
        },
      ],
    });
    const one = shape('fireflies_get_transcript', {
      transcript: { id: 't1', title: 'Weekly sync', meeting_info: { summary_status: 'processed' }, summary: { action_items: '**Ana**\nSend the deck' } },
    });
    expect(one.meeting).toMatchObject({ id: 't1', title: 'Weekly sync', summaryStatus: 'processed' });
    expect(one.notes).toEqual({ action_items: '**Ana**\nSend the deck' });
    const answer = shape('fireflies_ask_about_meeting', {
      createAskFredThread: { message: { id: 'm1', thread_id: 'th1', query: 'q', answer: 'They chose May.', suggested_queries: ['Who?'], status: 'completed' }, cost: 1 },
    });
    expect(answer).toEqual({ threadId: 'th1', answer: 'They chose May.', status: 'completed', suggestedFollowUps: ['Who?'], cost: 1 });
    const followUp = shape('fireflies_ask_follow_up', { continueAskFredThread: { message: { thread_id: 'th1', answer: 'Ana.' } } });
    expect(followUp).toMatchObject({ threadId: 'th1', answer: 'Ana.' });
  });

  it('pages the meeting text in two parts of 700 compact lines', () => {
    const sentences = Array.from({ length: 1500 }, (_, i) => ({ start_time: i * 2, speaker_name: i % 2 ? 'Bo' : 'Ana', text: `line ${i + 1}` }));
    const first = shape('fireflies_get_transcript_text', { transcript: { id: 't1', title: 'Sync', is_live: false, sentences } });
    expect(first).toMatchObject({ id: 't1', title: 'Sync', totalLines: 1500, firstLine: 1 });
    expect(first.lines).toHaveLength(700);
    expect(first.lines[0]).toEqual([0, 'Ana', 'line 1']);
    const more = shape('fireflies_get_transcript_text_more', { transcript: { id: 't1', title: 'Sync', is_live: false, sentences } });
    expect(more).toMatchObject({ totalLines: 1500, firstLine: 701 });
    expect(more.lines).toHaveLength(700);
    expect(more.lines[0]).toEqual([1400, 'Ana', 'line 701']);
    // A meeting still being processed has no sentences yet.
    const empty = shape('fireflies_get_transcript_text', { transcript: { id: 't2', title: 'New', is_live: false, sentences: null } });
    expect(empty).toMatchObject({ id: 't2', totalLines: 0 });
    // A very long meeting is cut to the byte cap instead of flooding the context.
    const long = Array.from({ length: 700 }, () => ({ start_time: 1, speaker_name: 'Ana', text: 'x'.repeat(400) }));
    expect(applyResponseTransform({ transcript: { id: 't3', sentences: long } }, tool('fireflies_get_transcript_text').responseMapping as any).truncated).toBe(true);
  });
});

const live = process.env.RUN_FIREFLIES_LIVE === '1' ? describe : describe.skip;
live('fireflies adapter: live', () => {
  const real = !!process.env.FIREFLIES_API_KEY;
  const env = () => ({ FIREFLIES_API_KEY: process.env.FIREFLIES_API_KEY! });
  beforeAll(() => mockedPost.mockImplementation((url: string, data: unknown, opts: any) => actualAxios.post(url, data, opts)));
  afterAll(() => mockedPost.mockReset());

  it('refuses a wrong key with auth_failed before running the operation', async () => {
    const err = await call('fireflies_get_current_user', {}).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    const body = err.response?.data ?? {};
    expect(JSON.stringify(body)).toContain('auth_failed');
  }, 30000);

  (real ? it : it.skip)('every operation is valid against the introspected schema', async () => {
    const res = await actualAxios.post(
      URL,
      { query: getIntrospectionQuery() },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}` }, timeout: 30000 },
    );
    const schema = buildClientSchema(res.data.data);
    for (const t of a.tools) {
      const errors = validate(schema, parse(t.endpointMapping.path)).map((e) => e.message);
      expect(`${t.name}:${errors.join('; ')}`).toBe(`${t.name}:`);
    }
  }, 60000);

  (real ? it : it.skip)('reads the user, the team, meetings, one meeting and its text, soundbites and AskFred threads', async () => {
    const me = await shaped('fireflies_get_current_user', {}, env());
    expect(typeof me.user.user_id).toBe('string');
    expect(Array.isArray((await shaped('fireflies_list_users', {}, env())).users)).toBe(true);
    expect(Array.isArray((await shaped('fireflies_list_channels', {}, env())).channels)).toBe(true);
    const list = await shaped('fireflies_list_transcripts', { limit: 3 }, env());
    expect(Array.isArray(list.meetings)).toBe(true);
    const first = list.meetings[0];
    if (first) {
      expect((await shaped('fireflies_get_transcript', { transcript_id: first.id }, env())).meeting.id).toBe(first.id);
      const text = await shaped('fireflies_get_transcript_text', { transcript_id: first.id }, env());
      expect(text.id).toBe(first.id);
      expect(typeof text.totalLines).toBe('number');
      expect(Array.isArray((await shaped('fireflies_search_transcripts', { keyword: first.title.split(' ')[0], scope: 'title', limit: 3 }, env())).meetings)).toBe(true);
    }
    expect(Array.isArray((await shaped('fireflies_list_bites', { mine: true, limit: 3 }, env())).bites)).toBe(true);
    expect(Array.isArray((await shaped('fireflies_list_askfred_threads', {}, env())).threads)).toBe(true);
    expect(Array.isArray((await shaped('fireflies_list_active_meetings', {}, env())).meetings)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_FIREFLIES_LIVE_WRITES === '1' && !!process.env.FIREFLIES_TEST_TRANSCRIPT_ID;
  (writes ? it : it.skip)('asks AskFred one question about the test meeting (spends AI credits)', async () => {
    const out = await shaped('fireflies_ask_about_meeting', { transcript_id: process.env.FIREFLIES_TEST_TRANSCRIPT_ID, question: 'What was decided?' }, env());
    expect(typeof out.threadId).toBe('string');
  }, 120000);
});
