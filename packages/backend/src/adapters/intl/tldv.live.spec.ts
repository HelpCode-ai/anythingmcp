import axios from 'axios';
import * as adapter from './tldv.json';
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
 * Two layers of verification for the tl;dv adapter:
 *
 *   1. Static: always runs. Pins the x-api-key header, every tool's method,
 *      URL, query and body through the real RestEngine, checked on
 *      15 Oct 2026 against tl;dv's OpenAPI document (embedded in
 *      doc.tldv.io, v1alpha1) and the requests of tl;dv's own MCP server
 *      (github.com/tldv-public). Also which tools write, that the import
 *      confirms first, and the transcript paging.
 *
 *   2. Live: skipped unless RUN_TLDV_LIVE=1. Without a key it checks that
 *      tl;dv refuses a wrong one with 401 on the real routes, and that every
 *      query and body parameter passes tl;dv's validation, which runs before
 *      the key check (a wrong name or value answers 400 even without a key).
 *      With TLDV_API_KEY it lists meetings and reads one meeting, its notes
 *      and its transcript. RUN_TLDV_LIVE_WRITES=1 also runs the import as a
 *      dry run (nothing is created):
 *
 *        RUN_TLDV_LIVE=1 TLDV_API_KEY=... npx jest src/adapters/intl/tldv.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
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

const HOST = 'https://pasta.tldv.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { TLDV_API_KEY: FAKE_KEY };
const MEETING = '0123456789abcdef01234567';

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

describe('tldv adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the personal API key as x-api-key to pasta.tldv.io', () => {
    expect(a.category).toBe('productivity');
    expect(a.icon).toBe('tldv');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{TLDV_API_KEY}}' });
    // /v1alpha1/health answers without a key, so the check lists one meeting instead.
    expect(a.connector.healthcheckPath).toBe('/v1alpha1/meetings?limit=1');
    expect(a.probe).toEqual({ tool: 'tldv_list_meetings', params: { limit: 1 } });
    expect(a.requiredEnvVars).toEqual(['TLDV_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.TLDV_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.TLDV_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'short', 'two words here and there']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/paid/);
  });

  it('prefixes every tool with tldv_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tldv_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only the import writes; it confirms first and adds rather than overwrites', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual(['tldv_import_meeting']);
    expect(tool('tldv_import_meeting').description).toMatch(/wait for their yes/);
    expect(annotationsOf(tool('tldv_import_meeting'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('checks meeting ids the way tl;dv does (24 hexadecimal characters)', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.meeting_id)) {
      const re = new RegExp(t.parameters.properties!.meeting_id.pattern!);
      expect(re.test(MEETING)).toBe(true);
      expect(re.test('abc')).toBe(false);
    }
  });

  it('only points the model at tools that exist, explains personal data and plans, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btldv_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btldv_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/personal data/);
    expect(a.instructions).toMatch(/paid plan/);
    expect(a.instructions).toContain('API keys');
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
    ['tldv_list_meetings', {}, 'GET', '/v1alpha1/meetings'],
    ['tldv_get_meeting', { meeting_id: MEETING }, 'GET', `/v1alpha1/meetings/${MEETING}`],
    ['tldv_get_notes', { meeting_id: MEETING }, 'GET', `/v1alpha1/meetings/${MEETING}/notes`],
    ['tldv_get_transcript', { meeting_id: MEETING }, 'GET', `/v1alpha1/meetings/${MEETING}/transcript`],
    ['tldv_get_transcript_more', { meeting_id: MEETING }, 'GET', `/v1alpha1/meetings/${MEETING}/transcript`],
    ['tldv_import_meeting', { url: 'https://example.com/call.mp3', name: 'Call' }, 'POST', '/v1alpha1/meetings/import'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the x-api-key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['x-api-key']).toBe(FAKE_KEY);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('lists meetings with the documented query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tldv_list_meetings', { query: 'pricing', from: '2026-10-01', to: '2026-10-14', only_participated: true, meeting_type: 'external', page: 2 });
    expect(sent().params).toEqual({ query: 'pricing', from: '2026-10-01', to: '2026-10-14', onlyParticipated: true, meetingType: 'external', page: 2, limit: 20 });
  });

  it('imports with the documented body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tldv_import_meeting', {
      url: 'https://example.com/call.mp3',
      name: 'Call',
      happened_at: '2026-10-01T09:30:00.000Z',
      participants: ['ana@example.com'],
      dry_run: true,
    });
    expect(sent().data).toEqual({ url: 'https://example.com/call.mp3', name: 'Call', happenedAt: '2026-10-01T09:30:00.000Z', participants: ['ana@example.com'], dryRun: true });
  });

  it('shapes meetings and notes', () => {
    const list = shape('tldv_list_meetings', {
      page: 1,
      pages: 3,
      total: 41,
      pageSize: 20,
      results: [
        {
          id: MEETING,
          name: 'Weekly sync',
          happenedAt: '2026-10-14T09:00:00.000Z',
          url: 'https://tldv.io/app/meetings/x',
          duration: 1820,
          organizer: { name: 'Ana', email: 'ana@example.com' },
          invitees: [{ name: 'Bo', email: 'bo@example.com' }],
          template: { id: 't', label: 'Meeting notes' },
          extraProperties: { conferenceId: 'c' },
        },
      ],
    });
    expect(list).toEqual({
      page: 1,
      pages: 3,
      total: 41,
      meetings: [
        {
          id: MEETING,
          name: 'Weekly sync',
          happenedAt: '2026-10-14T09:00:00.000Z',
          durationSeconds: 1820,
          url: 'https://tldv.io/app/meetings/x',
          organizer: { name: 'Ana', email: 'ana@example.com' },
          invitees: [{ name: 'Bo', email: 'bo@example.com' }],
        },
      ],
    });
    const notes = shape('tldv_get_notes', {
      markdownContent: '## Pricing\n- Agreed',
      topics: [{ id: 'tp', order: 0, title: 'Pricing', summary: 'Agreed on tiers' }],
      structuredNotes: [{ segmentId: 's', timestamp: 65, text: 'Agreed', topicId: 'tp' }],
    });
    expect(notes).toEqual({ markdown: '## Pricing\n- Agreed', topics: [{ title: 'Pricing', summary: 'Agreed on tiers' }], notes: [{ second: 65, text: 'Agreed' }] });
  });

  it('pages the transcript in two parts of 700 compact lines', () => {
    const data = Array.from({ length: 1500 }, (_, i) => ({ speaker: i % 2 ? 'Bo' : 'Ana', text: `line ${i + 1}`, startTime: i * 2, endTime: i * 2 + 1 }));
    const first = shape('tldv_get_transcript', { id: 'tr', meetingId: MEETING, data });
    expect(first).toMatchObject({ meetingId: MEETING, totalLines: 1500, firstLine: 1 });
    expect(first.lines).toHaveLength(700);
    expect(first.lines[0]).toEqual([0, 'Ana', 'line 1']);
    const more = shape('tldv_get_transcript_more', { id: 'tr', meetingId: MEETING, data });
    expect(more).toMatchObject({ firstLine: 701 });
    expect(more.lines[0]).toEqual([1400, 'Ana', 'line 701']);
    const long = Array.from({ length: 700 }, () => ({ speaker: 'Ana', text: 'x'.repeat(400), startTime: 1, endTime: 2 }));
    expect(applyResponseTransform({ meetingId: MEETING, data: long }, tool('tldv_get_transcript').responseMapping as any).truncated).toBe(true);
  });
});

const live = process.env.RUN_TLDV_LIVE === '1' ? describe : describe.skip;
live('tldv adapter: live', () => {
  const real = !!process.env.TLDV_API_KEY;
  const env = () => ({ TLDV_API_KEY: process.env.TLDV_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['tldv_list_meetings', {}],
    ['tldv_get_meeting', { meeting_id: MEETING }],
    ['tldv_get_notes', { meeting_id: MEETING }],
    ['tldv_get_transcript', { meeting_id: MEETING }],
    ['tldv_import_meeting', { url: 'https://example.com/call.mp3', name: 'Probe', dry_run: true }],
  ])('%s reaches tl;dv and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  // tl;dv validates queries and bodies before the key: a wrong name or value
  // answers 400 even with a wrong key, so a 401 shows every parameter passed.
  it.each([
    ['tldv_list_meetings', { query: 'sync', from: '2026-10-01', to: '2026-10-14T23:59:59Z', only_participated: true, meeting_type: 'external', page: 2, limit: 100 }],
    [
      'tldv_import_meeting',
      { url: 'https://example.com/call.mp3', name: 'Probe', happened_at: '2026-10-01T09:30:00.000Z', participants: ['ana@example.com'], dry_run: true },
    ],
  ])('%s passes tl;dv validation with every parameter (401, not 400)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('rejects a wrong value before the key, which is what makes the check above meaningful', async () => {
    await expect(call('tldv_list_meetings', { limit: 500 })).rejects.toMatchObject({ response: { status: 400 } });
  }, 30000);

  (real ? it : it.skip)('lists meetings and reads one meeting, its notes and its transcript', async () => {
    const list = await shaped('tldv_list_meetings', { limit: 3 }, env());
    expect(Array.isArray(list.meetings)).toBe(true);
    const first = list.meetings[0];
    if (!first) return;
    expect((await shaped('tldv_get_meeting', { meeting_id: first.id }, env())).id).toBe(first.id);
    try {
      expect(typeof (await shaped('tldv_get_notes', { meeting_id: first.id }, env())).markdown).toBe('string');
      const text = await shaped('tldv_get_transcript', { meeting_id: first.id }, env());
      expect(typeof text.totalLines).toBe('number');
    } catch (e: any) {
      // No notes or transcript yet, or the organizer has no paid plan.
      expect([403, 404]).toContain(e.response?.status);
    }
  }, 60000);

  (real && process.env.RUN_TLDV_LIVE_WRITES === '1' ? it : it.skip)('accepts an import as a dry run', async () => {
    const out = await shaped('tldv_import_meeting', { url: 'https://example.com/call.mp3', name: 'AnythingMCP dry run', dry_run: true }, env());
    expect(typeof out.success).toBe('boolean');
  }, 60000);
});
