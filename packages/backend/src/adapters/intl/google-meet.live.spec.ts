import axios from 'axios';
import * as adapter from './google-meet.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Meet adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters (with the three Meet scopes), the two ways ids reach the
 *      path (a space id percent-encoded, a conference resource name such as
 *      conferenceRecords/x/transcripts/y inserted with its slashes), the
 *      request bodies of the writes, which tools install switched off, and
 *      the transforms that turn transcript entries and participants into
 *      compact lists.
 *
 *   2. Live: skipped unless RUN_GOOGLE_MEET_LIVE=1 and GOOGLE_ACCESS_TOKEN
 *      are set (a token with meetings.space.readonly for the reads):
 *
 *        RUN_GOOGLE_MEET_LIVE=1 GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-meet.live.spec.ts
 *
 *      Lists the user's conference records and, when there is one, reads
 *      its participants and transcripts, and the first transcript's entries.
 *      With GOOGLE_LIVE_WRITE=1 as well (and meetings.space.created), a
 *      meeting space is created and read back. Meet has no call to delete a
 *      space: the test leaves an unused Meet link behind.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
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
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
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
const shaped = (name: string, raw: unknown): any => applyResponseTransform(raw, tool(name).responseMapping).value;

const BASE = 'https://meet.googleapis.com/v2';
const CONF = 'conferenceRecords/abc-123';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

const READS = [
  'google_meet_get_conference_record',
  'google_meet_get_participant',
  'google_meet_get_space',
  'google_meet_list_conference_records',
  'google_meet_list_members',
  'google_meet_list_participant_sessions',
  'google_meet_list_participants',
  'google_meet_list_recordings',
  'google_meet_list_smart_notes',
  'google_meet_list_transcripts',
  'google_meet_read_transcript',
];
const WRITES = [
  'google_meet_add_member',
  'google_meet_create_space',
  'google_meet_end_active_conference',
  'google_meet_remove_member',
  'google_meet_update_space',
];

describe('google-meet adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified on a live account on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('signs in with the shared Google OAuth client and the three Meet scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes:
        'https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/meetings.space.settings',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*meetings\.space\.readonly/);
    // The visibility limits the model must know before promising anything.
    expect(a.instructions).toMatch(/only meetings \*\*the signed-in user organised\*\*/);
    expect(a.instructions).toMatch(/30 days after the meeting ends/);
  });

  it('probes with one conference record, the cheapest authenticated read', () => {
    expect(a.probe).toEqual({ tool: 'google_meet_list_conference_records', params: { page_size: 1 } });
    expect(a.connector.healthcheckPath).toBe('/conferenceRecords?pageSize=1');
  });

  it('prefixes every tool with google_meet_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_meet_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the reads read-only and the rest as writes', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READS);
    expect(a.tools.map((t) => t.name).filter((n) => !readOnly.includes(n)).sort()).toEqual(WRITES);
  });

  it('asks the model to confirm every write with the user', () => {
    for (const name of WRITES) expect(`${name}: ${tool(name).description}`).toMatch(/[Cc]onfirm/);
  });

  it('installs ending a call and removing a member switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([
      'google_meet_end_active_conference',
      'google_meet_remove_member',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `google_meet_end_active_conference`[^\n]*`google_meet_remove_member`/);
    expect(annotationsOf(tool('google_meet_remove_member')).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_meet_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_meet_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('percent-encodes space ids but keeps the slashes of resource names', async () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (p.includes('{space_id}')) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.endpointMapping.encodePathParams ?? false}`).toBe(`${t.name}:false`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_meet_get_space', { space_id: 'abc-mnop-xyz' });
    expect(sent().url).toBe(`${BASE}/spaces/abc-mnop-xyz`);
    mockedAxios.mockClear();
    await call('google_meet_get_space', { space_id: 'a/b' });
    expect(sent().url).toBe(`${BASE}/spaces/a%2Fb`);
    mockedAxios.mockClear();
    await call('google_meet_read_transcript', { transcript: `${CONF}/transcripts/t1` });
    expect(sent().url).toBe(`${BASE}/${CONF}/transcripts/t1/entries`);
    // The schema default asks for the largest page.
    expect(sent().params).toEqual({ pageSize: 100 });
    mockedAxios.mockClear();
    await call('google_meet_list_participant_sessions', { participant: `${CONF}/participants/p1`, filter: 'end_time IS NULL' });
    expect(sent().url).toBe(`${BASE}/${CONF}/participants/p1/participantSessions`);
    expect(sent().params).toEqual({ filter: 'end_time IS NULL' });
    mockedAxios.mockClear();
    await call('google_meet_remove_member', { member_name: 'spaces/s1/members/m1' });
    expect(sent().method).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/spaces/s1/members/m1`);
  });

  it('sends the conference record filter as Google expects it', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const filter = 'space.meeting_code = "abc-mnop-xyz" AND start_time >= "2026-10-01T00:00:00Z"';
    await call('google_meet_list_conference_records', { filter, page_size: 5, page_token: 'n1' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${BASE}/conferenceRecords`);
    expect(sent().params).toEqual({ filter, pageSize: 5, pageToken: 'n1' });
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('builds the bodies of the writes', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const config = { accessType: 'TRUSTED', artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } };
    await call('google_meet_create_space', { config });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/spaces`);
    expect(sent().data).toEqual({ config });
    mockedAxios.mockClear();
    // Without arguments the space gets the user's defaults.
    await call('google_meet_create_space', {});
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('google_meet_update_space', {
      space_id: 's1',
      config: { accessType: 'RESTRICTED' },
      update_mask: 'config.accessType',
    });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe(`${BASE}/spaces/s1`);
    expect(sent().params).toEqual({ updateMask: 'config.accessType' });
    expect(sent().data).toEqual({ config: { accessType: 'RESTRICTED' } });
    mockedAxios.mockClear();
    await call('google_meet_end_active_conference', { space_id: 's1' });
    expect(sent().url).toBe(`${BASE}/spaces/s1:endActiveConference`);
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('google_meet_add_member', { space_id: 's1', email: 'ana@example.com', role: 'COHOST' });
    expect(sent().url).toBe(`${BASE}/spaces/s1/members`);
    expect(sent().data).toEqual({ email: 'ana@example.com', role: 'COHOST' });
  });

  it('turns transcript entries into a compact list in spoken order', () => {
    expect(validateTransform(tool('google_meet_read_transcript').responseMapping!.transform)).toBeNull();
    expect(tool('google_meet_read_transcript').responseMapping!.transform!.maxBytes).toBe(200_000);
    const raw = {
      transcriptEntries: [
        {
          name: `${CONF}/transcripts/t1/entries/e1`,
          participant: `${CONF}/participants/p1`,
          text: 'Guten Morgen, fangen wir an.',
          languageCode: 'de-DE',
          startTime: '2026-10-13T08:00:01Z',
          endTime: '2026-10-13T08:00:04Z',
        },
        {
          name: `${CONF}/transcripts/t1/entries/e2`,
          participant: `${CONF}/participants/p2`,
          text: 'Sure 👋',
          languageCode: 'en-US',
          startTime: '2026-10-13T08:00:05Z',
          endTime: '2026-10-13T08:00:06Z',
        },
      ],
      nextPageToken: 'n2',
    };
    expect(shaped('google_meet_read_transcript', raw)).toEqual({
      entries: [
        {
          participant: `${CONF}/participants/p1`,
          startTime: '2026-10-13T08:00:01Z',
          endTime: '2026-10-13T08:00:04Z',
          languageCode: 'de-DE',
          text: 'Guten Morgen, fangen wir an.',
        },
        {
          participant: `${CONF}/participants/p2`,
          startTime: '2026-10-13T08:00:05Z',
          endTime: '2026-10-13T08:00:06Z',
          languageCode: 'en-US',
          text: 'Sure 👋',
        },
      ],
      nextPageToken: 'n2',
    });
    // The last page has no token, and an empty transcript no entries.
    expect(shaped('google_meet_read_transcript', {})).toEqual({ entries: null, nextPageToken: null });
  });

  it('gives every participant one display name, whatever kind of user joined', () => {
    expect(validateTransform(tool('google_meet_list_participants').responseMapping!.transform)).toBeNull();
    const raw = {
      participants: [
        {
          name: `${CONF}/participants/p1`,
          earliestStartTime: '2026-10-13T08:00:00Z',
          latestEndTime: '2026-10-13T08:30:00Z',
          signedinUser: { user: 'users/111', displayName: 'Ana Muster' },
        },
        { name: `${CONF}/participants/p2`, earliestStartTime: '2026-10-13T08:01:00Z', anonymousUser: { displayName: 'Guest' } },
        { name: `${CONF}/participants/p3`, earliestStartTime: '2026-10-13T08:02:00Z', phoneUser: { displayName: '+49 *** ** 12' } },
      ],
      nextPageToken: 'n2',
    };
    expect(shaped('google_meet_list_participants', raw)).toEqual({
      participants: [
        {
          name: `${CONF}/participants/p1`,
          displayName: 'Ana Muster',
          kind: 'signedin',
          user: 'users/111',
          earliestStartTime: '2026-10-13T08:00:00Z',
          latestEndTime: '2026-10-13T08:30:00Z',
        },
        {
          name: `${CONF}/participants/p2`,
          displayName: 'Guest',
          kind: 'anonymous',
          user: null,
          earliestStartTime: '2026-10-13T08:01:00Z',
          latestEndTime: null,
        },
        {
          name: `${CONF}/participants/p3`,
          displayName: '+49 *** ** 12',
          kind: 'phone',
          user: null,
          earliestStartTime: '2026-10-13T08:02:00Z',
          latestEndTime: null,
        },
      ],
      nextPageToken: 'n2',
    });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = process.env.RUN_GOOGLE_MEET_LIVE === '1' && TOKEN ? describe : describe.skip;

live('google-meet adapter: live Meet REST API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const exec = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  it('runs the probe and reads the newest conference record with its participants and transcript', async () => {
    const raw = await exec(a.probe.tool, a.probe.params);
    expect(typeof raw).toBe('object');
    const record = raw.conferenceRecords?.[0];
    if (!record) {
      console.warn('No conference records for this account in the last 30 days: only the probe ran.');
      return;
    }
    expect(record.name).toMatch(/^conferenceRecords\//);
    const got = await exec('google_meet_get_conference_record', { conference_record: record.name });
    expect(got.name).toBe(record.name);
    const participants = shaped('google_meet_list_participants', await exec('google_meet_list_participants', { conference_record: record.name }));
    expect(Array.isArray(participants.participants ?? [])).toBe(true);
    const transcripts = await exec('google_meet_list_transcripts', { conference_record: record.name });
    const transcript = (transcripts.transcripts ?? []).find((t: any) => t.state === 'FILE_GENERATED');
    if (transcript) {
      const page = shaped('google_meet_read_transcript', await exec('google_meet_read_transcript', { transcript: transcript.name }));
      expect(Array.isArray(page.entries)).toBe(true);
      expect(typeof page.entries[0].text).toBe('string');
    }
  }, 60_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a meeting space and reads it back by id and by meeting code',
    async () => {
      const space = await exec('google_meet_create_space', {});
      expect(space.name).toMatch(/^spaces\//);
      expect(space.meetingUri).toMatch(/^https:\/\/meet\.google\.com\//);
      const id = String(space.name).slice('spaces/'.length);
      expect((await exec('google_meet_get_space', { space_id: id })).name).toBe(space.name);
      expect((await exec('google_meet_get_space', { space_id: space.meetingCode })).name).toBe(space.name);
    },
    60_000,
  );
});
