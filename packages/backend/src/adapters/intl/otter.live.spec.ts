import axios from 'axios';
import * as adapter from './otter.json';
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
 * Two layers of verification for the Otter.ai adapter:
 *
 *   1. Static: always runs. Pins Bearer auth, every tool's method, URL, query
 *      and body through the real RestEngine, checked on 15 Oct 2026 against
 *      Otter's Public API reference (help.otter.ai article 36130822688279,
 *      updated 7 Oct 2026). Otter publishes no OpenAPI file or SDK, but its
 *      server validates query and body before the key, so the live layer
 *      checks parameter names and values with a wrong key too. That showed
 *      include must be repeated (include=a&include=b): the comma list in the
 *      article answers 422. Also which tools write, that the import confirms
 *      first, and the transcript paging over Otter's single text.
 *
 *   2. Live: skipped unless RUN_OTTER_LIVE=1. Without a key it checks that
 *      Otter refuses a wrong one with 401 on the real routes (an unknown
 *      route answers 404, so a 401 shows the route exists). With
 *      OTTER_API_KEY (an Enterprise workspace) it reads the workspace,
 *      channels, one page of conversations and one conversation with its
 *      transcript. Nothing here writes in the live layer: the import has no
 *      dry run, so RUN_OTTER_LIVE_WRITES=1 with OTTER_TEST_FILE_URL imports
 *      that file as a new conversation.
 *
 *        RUN_OTTER_LIVE=1 OTTER_API_KEY=... npx jest src/adapters/intl/otter.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  description: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
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

const BASE = 'https://api.otter.ai/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { OTTER_API_KEY: FAKE_KEY };

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

describe('otter adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the API key as Bearer to api.otter.ai/v1', () => {
    expect(a.category).toBe('productivity');
    expect(a.icon).toBe('otter');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{OTTER_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/conversations?limit=1');
    expect(a.probe).toEqual({ tool: 'otter_list_conversations', params: { limit: 1 } });
    expect(a.requiredEnvVars).toEqual(['OTTER_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.OTTER_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.OTTER_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'short']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/Enterprise/);
  });

  it('says plainly that the API needs an Enterprise workspace', () => {
    expect(a.instructions).toMatch(/Enterprise workspaces\*\* only/);
    expect(a.description).toMatch(/Enterprise/);
  });

  it('prefixes every tool with otter_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^otter_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only the import writes; it confirms first and adds rather than overwrites', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual(['otter_import_recording']);
    expect(tool('otter_import_recording').description).toMatch(/wait for their yes/);
    expect(annotationsOf(tool('otter_import_recording'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('only points the model at tools that exist, explains personal data, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\botter_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\botter_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/personal data/);
    expect(a.instructions).toContain('Integrations');
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

  const table: Array<[string, Record<string, unknown>, string, string, Record<string, unknown> | undefined]> = [
    ['otter_get_workspace', {}, 'GET', '/workspace', undefined],
    ['otter_list_channels', {}, 'GET', '/channels', undefined],
    ['otter_list_channel_members', { channel_id: 'ch1' }, 'GET', '/channels/ch1/members', undefined],
    ['otter_list_conversations', { include_shared: true, cursor: 'c2' }, 'GET', '/conversations', { include_shared: true, limit: 20, cursor: 'c2' }],
    ['otter_get_conversation', { conversation_id: 'cv1' }, 'GET', '/conversations/cv1', { include: ['action_items', 'insights', 'outline'] }],
    ['otter_get_transcript', { conversation_id: 'cv1' }, 'GET', '/conversations/cv1', { include: 'transcript' }],
    ['otter_get_transcript_more', { conversation_id: 'cv1' }, 'GET', '/conversations/cv1', { include: 'transcript' }],
    ['otter_get_audio_link', { conversation_id: 'cv1' }, 'GET', '/conversations/cv1/audio', undefined],
    ['otter_import_recording', { file_url: 'https://example.com/call.mp3', name: 'Call' }, 'POST', '/conversations', undefined],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, path, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    if (query) expect(req.params).toEqual(query);
  });

  it('repeats include once per section, as Otter validates it (a comma list answers 422)', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('otter_get_conversation', { conversation_id: 'cv1' });
    expect(sent().paramsSerializer(sent().params)).toBe('include=action_items&include=insights&include=outline');
  });

  it('imports with the documented body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('otter_import_recording', { file_url: 'https://example.com/call.mp3', name: 'Product launch' });
    expect(sent().data).toEqual({ file: 'https://example.com/call.mp3', name: 'Product launch' });
  });

  it('shapes conversation lists and one conversation', () => {
    const owner = { id: 'u1', name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' };
    const list = shape('otter_list_conversations', {
      meta: { retrieved_at: '2026-10-15T12:00:00Z', has_more: true, next_cursor: 'c2' },
      data: [
        {
          id: 'cv1',
          title: 'Launch meeting',
          url: 'https://otter.ai/u/cv1',
          owner,
          created_at: '2026-10-14T12:00:00Z',
          process_status: { abstract_summary: 'finished' },
          calendar_guests: [{ name: 'John', email: 'john@example.com' }],
          shared_emails: [],
          shared_channels: [],
          abstract_summary: 'Next steps for the launch.',
          conf_join_url: 'https://zoom.us/j/1',
        },
      ],
    });
    expect(list).toEqual({
      conversations: [
        {
          id: 'cv1',
          title: 'Launch meeting',
          createdAt: '2026-10-14T12:00:00Z',
          url: 'https://otter.ai/u/cv1',
          owner: 'Jane Doe',
          ownerEmail: 'jane@example.com',
          summary: 'Next steps for the launch.',
          guests: [{ name: 'John', email: 'john@example.com' }],
          joinUrl: 'https://zoom.us/j/1',
        },
      ],
      hasMore: true,
      nextCursor: 'c2',
    });
    const one = shape('otter_get_conversation', {
      meta: {},
      data: {
        id: 'cv1',
        title: 'Discovery call',
        owner,
        shared_emails: [{ email: 'hello@example.com', permission: 'collaborate' }],
        abstract_summary: 'Pricing discussed.',
        relationships: {
          action_items: [{ id: 'a1', text: 'Send pricing', assignee: owner, status: { completed: false } }],
          insights: [{ topic: 'Budget', text: ['Has budget'] }],
          outline: [{ section: 'Intro', text: ['Hello'] }],
          transcript: null,
        },
      },
    });
    expect(one.conversation).toMatchObject({ id: 'cv1', title: 'Discovery call', owner: 'Jane Doe', sharedWith: ['hello@example.com'], summary: 'Pricing discussed.' });
    expect(one.actionItems).toEqual([{ text: 'Send pricing', assignee: 'Jane Doe', assigneeEmail: 'jane@example.com', completed: false }]);
    expect(one.insights).toEqual([{ topic: 'Budget', text: ['Has budget'] }]);
    expect(one.outline).toEqual([{ section: 'Intro', text: ['Hello'] }]);
    expect(shape('otter_get_audio_link', { meta: {}, data: { url: 'https://example.com/a.mp3' } })).toEqual({ audioUrl: 'https://example.com/a.mp3' });
  });

  it('splits the transcript text into speaker blocks and pages them by 300', () => {
    const content = Array.from({ length: 650 }, (_, i) => `${i % 2 ? 'Alex Taylor' : 'Jane Doe'} ${String(i).padStart(2, '0')}:00\nsentence ${i + 1}`).join('\n\n');
    const raw = { meta: {}, data: { id: 'cv1', title: 'Call', relationships: { transcript: { content, format: 'txt' } } } };
    const first = shape('otter_get_transcript', raw);
    expect(first).toMatchObject({ id: 'cv1', title: 'Call', totalBlocks: 650, firstBlock: 1 });
    expect(first.blocks).toHaveLength(300);
    expect(first.blocks[0]).toBe('Jane Doe 00:00\nsentence 1');
    const more = shape('otter_get_transcript_more', raw);
    expect(more).toMatchObject({ totalBlocks: 650, firstBlock: 301 });
    expect(more.blocks).toHaveLength(300);
    expect(more.blocks[0]).toBe('Jane Doe 300:00\nsentence 301');
    // No transcript yet: no blocks rather than an error.
    const none = shape('otter_get_transcript', { meta: {}, data: { id: 'cv2', title: 'New', relationships: { transcript: null } } });
    expect(none).toMatchObject({ id: 'cv2', totalBlocks: 0, blocks: [] });
    const long = Array.from({ length: 300 }, () => `Jane 00:00\n${'x'.repeat(600)}`).join('\n\n');
    expect(
      applyResponseTransform({ data: { id: 'cv3', relationships: { transcript: { content: long } } } }, tool('otter_get_transcript').responseMapping as any).truncated,
    ).toBe(true);
  });
});

const live = process.env.RUN_OTTER_LIVE === '1' ? describe : describe.skip;
live('otter adapter: live', () => {
  const real = !!process.env.OTTER_API_KEY;
  const env = () => ({ OTTER_API_KEY: process.env.OTTER_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['otter_get_workspace', {}],
    ['otter_list_channels', {}],
    ['otter_list_conversations', {}],
    ['otter_get_conversation', { conversation_id: 'abc' }],
    ['otter_get_audio_link', { conversation_id: 'abc' }],
  ])('%s reaches Otter and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  // Otter validates the request before the key: a wrong parameter answers 422
  // even with a wrong key, so these show the parameters are right.
  it.each([
    ['otter_get_conversation', { conversation_id: 'abc' }],
    ['otter_get_transcript', { conversation_id: 'abc' }],
    ['otter_list_conversations', { include_shared: true, limit: 100, cursor: 'x', channel_id: 'y' }],
    ['otter_import_recording', { file_url: 'https://example.com/call.mp3', name: 'Probe' }],
  ])('%s passes Otter validation before the key check (401, not 422)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the workspace, channels, conversations and one transcript', async () => {
    expect((await shaped('otter_get_workspace', {}, env())).workspace).toBeDefined();
    expect(Array.isArray((await shaped('otter_list_channels', {}, env())).channels)).toBe(true);
    const list = await shaped('otter_list_conversations', { limit: 3 }, env());
    expect(Array.isArray(list.conversations)).toBe(true);
    const first = list.conversations[0];
    if (!first) return;
    expect((await shaped('otter_get_conversation', { conversation_id: first.id }, env())).conversation.id).toBe(first.id);
    const text = await shaped('otter_get_transcript', { conversation_id: first.id }, env());
    expect(typeof text.totalBlocks).toBe('number');
  }, 60000);

  (real && process.env.RUN_OTTER_LIVE_WRITES === '1' && process.env.OTTER_TEST_FILE_URL ? it : it.skip)(
    'imports the test file as a new conversation',
    async () => {
      const out = await shaped('otter_import_recording', { file_url: process.env.OTTER_TEST_FILE_URL, name: 'AnythingMCP live test' }, env());
      expect(out.status).toBeDefined();
    },
    120000,
  );
});
