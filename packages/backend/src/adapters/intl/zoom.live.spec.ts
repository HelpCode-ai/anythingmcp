import axios from 'axios';
import * as adapter from './zoom.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Zoom adapter:
 *
 *   1. Static: always runs. Pins the OAuth authorization code flow against
 *      zoom.us with HTTP Basic at the token endpoint and no scope parameter
 *      (the scopes ticked on the Zoom app apply), the env var patterns, every
 *      tool's method and URL through the real RestEngine, the request bodies
 *      of every write, the double encoding of meeting UUIDs that start with
 *      "/" or contain "//", the start_url filter, and the read-only,
 *      destructive and switched-off sets.
 *
 *   2. Live: skipped unless a token is available. Either
 *        ZOOM_ACCESS_TOKEN  an OAuth access token of a General app (user
 *                           managed) or of a Server-to-Server OAuth app; the
 *                           API calls are the same,
 *      or all three of
 *        ZOOM_ACCOUNT_ID, ZOOM_S2S_CLIENT_ID, ZOOM_S2S_CLIENT_SECRET
 *      of a Server-to-Server OAuth app, in which case beforeAll fetches a
 *      token with the account_credentials grant. ZOOM_USER_ID (default "me")
 *      picks the user whose meetings, recordings and webinars are read.
 *
 *        ZOOM_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/zoom.live.spec.ts
 *
 *      Runs every read tool. Calls the plan, add-on or admin scopes do not
 *      allow (registrants, participants, recordings, webinars, reports, the
 *      user list) may be refused with 400, 403 or 404; that is accepted, a
 *      crash or a 401 is not.
 *
 *      ZOOM_LIVE_WRITE=1 also schedules a meeting a week ahead (topic
 *      "AnythingMCP live spec (safe to delete)", no registration, no
 *      alternative hosts, no invitees, email notifications off), reads and
 *      updates it, and when the plan allows registration turns it on with
 *      registration emails off, registers an example.com address, approves
 *      it, and finally deletes the meeting with both reminder flags false so
 *      nobody gets a cancellation email.
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
  probe: { tool: string };
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

const BASE = 'https://api.zoom.us/v2';
// Stand-ins only: the engine runs with a bearer token here, never with these.
const ENV = { ZOOM_CLIENT_ID: 'client-id-test', ZOOM_CLIENT_SECRET: 'x'.repeat(32) };
const MEETING = '85746065432';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = ['zoom_delete_meeting'];
const DESTRUCTIVE = ['zoom_delete_meeting', 'zoom_update_meeting', 'zoom_update_meeting_registrant_status'];
const NOTIFYING = [
  'zoom_create_meeting',
  'zoom_update_meeting',
  'zoom_delete_meeting',
  'zoom_add_meeting_registrant',
  'zoom_update_meeting_registrant_status',
];

describe('zoom adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 11 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with the authorization code flow at zoom.us, HTTP Basic at the token endpoint and the app scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{ZOOM_CLIENT_ID}}',
      clientSecret: '{{ZOOM_CLIENT_SECRET}}',
      authorizationUrl: 'https://zoom.us/oauth/authorize',
      tokenUrl: 'https://zoom.us/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/users/me');
    expect(a.category).toBe('scheduling');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('<your AnythingMCP URL>/api/mcp-oauth/callback');
  });

  it('asks for the client id and a secret client secret, with patterns', () => {
    expect(a.requiredEnvVars).toEqual(['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']);
    const id = new RegExp(a.envVarMeta.ZOOM_CLIENT_ID.pattern!);
    for (const ok of ['aB3dE5fG7hI9jK1lM3nO', 'Zx_9k-Ab12Cd34Ef56']) expect(id.test(ok)).toBe(true);
    for (const bad of ['', 'short', 'has space inside it', 'aB3dE5fG7hI9jK1lM3nO\n']) expect(id.test(bad)).toBe(false);
    const secret = new RegExp(a.envVarMeta.ZOOM_CLIENT_SECRET.pattern!);
    expect(secret.test('Ab'.repeat(16))).toBe(true);
    for (const bad of ['tooshort', `Bearer ${'a'.repeat(32)}`, ' '.repeat(32)]) expect(secret.test(bad)).toBe(false);
    for (const meta of Object.values(a.envVarMeta)) {
      expect(meta.kind).toBe('credential');
      expect(meta.link).toMatch(/^https:\/\/marketplace\.zoom\.us\//);
    }
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'ZOOM_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'ZOOM_CLIENT_ID')!.secret).toBeFalsy();
  });

  it('probes with the signed-in user, which needs no argument', async () => {
    expect(a.probe.tool).toBe('zoom_get_current_user');
    expect(tool('zoom_get_current_user').parameters.required).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoom_get_current_user', {});
    expect(sent().url).toBe(`${BASE}/users/me`);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('prefixes every tool with zoom_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^zoom_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, the overwriting writes destructive, and installs delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'zoom_get_current_user',
      'zoom_get_meeting',
      'zoom_get_meeting_participants_report',
      'zoom_get_meeting_recordings',
      'zoom_get_meeting_report',
      'zoom_get_past_meeting',
      'zoom_get_user',
      'zoom_get_user_meetings_report',
      'zoom_get_webinar',
      'zoom_list_meeting_registrants',
      'zoom_list_meetings',
      'zoom_list_past_meeting_instances',
      'zoom_list_past_meeting_participants',
      'zoom_list_recordings',
      'zoom_list_users',
      'zoom_list_webinars',
    ]);
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    const destructive = a.tools.filter((t) => !annotationsOf(t).readOnlyHint && annotationsOf(t).destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual(DESTRUCTIVE);
    for (const name of ['zoom_update_meeting', 'zoom_update_meeting_registrant_status']) {
      expect(tool(name).annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    }
    expect(annotationsOf(tool('zoom_create_meeting')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('zoom_add_meeting_registrant')).destructiveHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const name of NOTIFYING) expect(tool(name).description).toMatch(/confirm/i);
  });

  it('URL-encodes every path argument and defaults user-scoped tools to "me"', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.path.startsWith('/users/{user_id}/') || x.endpointMapping.path.startsWith('/report/users/'))) {
      expect(`${t.name}:${t.parameters.properties!.user_id.default}`).toBe(`${t.name}:me`);
    }
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(t.endpointMapping.bodyMapping).toBeUndefined();
    }
  });

  it('documents paging with next_page_token and page_size on every list that has it', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.next_page_token)) {
      expect(t.endpointMapping.queryParams).toMatchObject({ page_size: '$page_size', next_page_token: '$next_page_token' });
      expect(t.description).toContain('next_page_token');
    }
    for (const name of ['zoom_list_meetings', 'zoom_list_recordings', 'zoom_list_meeting_registrants', 'zoom_list_users']) {
      expect(tool(name).description).toMatch(/empty/);
    }
  });

  it('only points the model at tools that exist, documents setup and scopes, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bzoom_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzoom_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Zoom\n')).toBe(true);
    expect(a.instructions).toContain('https://marketplace.zoom.us/');
    expect(a.instructions).toContain('General app');
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toContain('Out of scope');
    for (const scope of [
      'user:read:user',
      'meeting:read:list_meetings',
      'meeting:read:meeting',
      'meeting:write:meeting',
      'meeting:update:meeting',
      'meeting:delete:meeting',
      'meeting:read:list_registrants',
      'meeting:write:registrant',
      'meeting:update:registrant_status',
      'meeting:read:past_meeting',
      'meeting:read:list_past_instances',
      'meeting:read:list_past_participants',
      'cloud_recording:read:list_user_recordings',
      'cloud_recording:read:list_recording_files',
      'webinar:read:list_webinars',
      'webinar:read:webinar',
      'user:read:list_users:admin',
      'report:read:user:admin',
      'report:read:meeting:admin',
      'report:read:list_meeting_participants:admin',
    ]) {
      expect(a.instructions).toContain(`\`${scope}\``);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const UUID = 'aDYlohsHRtCd4ii1uC2+hA==';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['zoom_get_current_user', {}, 'GET', `${BASE}/users/me`],
    ['zoom_list_users', {}, 'GET', `${BASE}/users`],
    ['zoom_get_user', { user_id: 'ana@example.com' }, 'GET', `${BASE}/users/ana%40example.com`],
    ['zoom_list_meetings', {}, 'GET', `${BASE}/users/me/meetings`],
    ['zoom_get_meeting', { meeting_id: MEETING }, 'GET', `${BASE}/meetings/${MEETING}`],
    ['zoom_create_meeting', { topic: 'Weekly' }, 'POST', `${BASE}/users/me/meetings`],
    ['zoom_update_meeting', { meeting_id: MEETING, topic: 'Weekly' }, 'PATCH', `${BASE}/meetings/${MEETING}`],
    ['zoom_delete_meeting', { meeting_id: MEETING }, 'DELETE', `${BASE}/meetings/${MEETING}`],
    ['zoom_list_meeting_registrants', { meeting_id: MEETING }, 'GET', `${BASE}/meetings/${MEETING}/registrants`],
    ['zoom_add_meeting_registrant', { meeting_id: MEETING, email: 'ana@example.com', first_name: 'Ana' }, 'POST', `${BASE}/meetings/${MEETING}/registrants`],
    ['zoom_update_meeting_registrant_status', { meeting_id: MEETING, action: 'approve', registrants: [{ id: 'r1' }] }, 'PUT', `${BASE}/meetings/${MEETING}/registrants/status`],
    ['zoom_get_past_meeting', { meeting_id: UUID }, 'GET', `${BASE}/past_meetings/aDYlohsHRtCd4ii1uC2%2BhA%3D%3D`],
    ['zoom_list_past_meeting_participants', { meeting_id: MEETING }, 'GET', `${BASE}/past_meetings/${MEETING}/participants`],
    ['zoom_list_past_meeting_instances', { meeting_id: MEETING }, 'GET', `${BASE}/past_meetings/${MEETING}/instances`],
    ['zoom_list_recordings', {}, 'GET', `${BASE}/users/me/recordings`],
    ['zoom_get_meeting_recordings', { meeting_id: MEETING }, 'GET', `${BASE}/meetings/${MEETING}/recordings`],
    ['zoom_list_webinars', {}, 'GET', `${BASE}/users/me/webinars`],
    ['zoom_get_webinar', { webinar_id: '91234567890' }, 'GET', `${BASE}/webinars/91234567890`],
    ['zoom_get_user_meetings_report', { from: '2026-09-01', to: '2026-09-30' }, 'GET', `${BASE}/report/users/me/meetings`],
    ['zoom_get_meeting_report', { meeting_id: MEETING }, 'GET', `${BASE}/report/meetings/${MEETING}`],
    ['zoom_get_meeting_participants_report', { meeting_id: MEETING }, 'GET', `${BASE}/report/meetings/${MEETING}/participants`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('double-encodes a UUID that starts with "/" when it is passed encoded once, as the instructions say', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const raw = '/ajXp112QmuoKj4854875==';
    await call('zoom_get_past_meeting', { meeting_id: encodeURIComponent(raw) });
    expect(sent().url).toBe(`${BASE}/past_meetings/%252FajXp112QmuoKj4854875%253D%253D`);
    expect(decodeURIComponent(decodeURIComponent(sent().url.split('/').pop()))).toBe(raw);
    expect(a.instructions).toContain('%2FajXp112QmuoKj4854875%3D%3D');
  });

  it('creates a meeting with only the given fields and the settings object as is', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const settings = { waiting_room: true, approval_type: 2, alternative_hosts_email_notification: false };
    await call('zoom_create_meeting', { topic: 'Weekly', type: 2, start_time: '2026-10-20T15:00:00Z', duration: 30, timezone: 'Europe/Berlin', settings });
    expect(sent().data).toEqual({ topic: 'Weekly', type: 2, start_time: '2026-10-20T15:00:00Z', duration: 30, timezone: 'Europe/Berlin', settings });
    expect(sent().params).toBeUndefined();
  });

  it('updates a meeting with PATCH, the occurrence as a query parameter and only the changed fields', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('zoom_update_meeting', { meeting_id: MEETING, occurrence_id: '1760972400000', duration: 45, agenda: 'New agenda' });
    expect(sent().params).toEqual({ occurrence_id: '1760972400000' });
    expect(sent().data).toEqual({ duration: 45, agenda: 'New agenda' });
  });

  it('deletes without a body and without cancellation emails unless asked', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('zoom_delete_meeting', { meeting_id: MEETING });
    expect(sent().data).toBeUndefined();
    expect(sent().params).toEqual({ schedule_for_reminder: false, cancel_meeting_reminder: false });
    mockedAxios.mockClear();
    await call('zoom_delete_meeting', { meeting_id: MEETING, occurrence_id: 'o1', cancel_meeting_reminder: true });
    expect(sent().params).toEqual({ occurrence_id: 'o1', schedule_for_reminder: false, cancel_meeting_reminder: true });
  });

  it('adds a registrant with the documented fields and approves or denies with action and registrants', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const custom = [{ title: 'Company size', value: '10-50' }];
    await call('zoom_add_meeting_registrant', { meeting_id: MEETING, email: 'ana@example.com', first_name: 'Ana', last_name: 'Diaz', custom_questions: custom, language: 'de-DE', occurrence_ids: 'o1,o2' });
    expect(sent().data).toEqual({ email: 'ana@example.com', first_name: 'Ana', last_name: 'Diaz', custom_questions: custom, language: 'de-DE' });
    expect(sent().params).toEqual({ occurrence_ids: 'o1,o2' });
    mockedAxios.mockClear();
    const registrants = [{ id: '9tboDiHUQAeOnbmudzWa5g', email: 'ana@example.com' }];
    await call('zoom_update_meeting_registrant_status', { meeting_id: MEETING, action: 'deny', registrants });
    expect(sent().data).toEqual({ action: 'deny', registrants });
  });

  it('sends list filters and paging as query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoom_list_meetings', { type: 'upcoming', page_size: 50, next_page_token: 'tok' });
    expect(sent().params).toEqual({ type: 'upcoming', page_size: 50, next_page_token: 'tok' });
    mockedAxios.mockClear();
    await call('zoom_list_recordings', { from: '2026-09-11', to: '2026-10-10' });
    expect(sent().params).toEqual({ from: '2026-09-11', to: '2026-10-10' });
    mockedAxios.mockClear();
    await call('zoom_list_users', {});
    expect(sent().params).toEqual({ page_size: 30 });
  });

  it('keeps the host start_url out of meeting answers', () => {
    const answer = { id: 85746065432, topic: 'Weekly', join_url: 'https://zoom.us/j/85746065432', start_url: 'https://zoom.us/s/85746065432?zak=secret' };
    for (const name of ['zoom_get_meeting', 'zoom_create_meeting']) {
      const shaped = applyResponseTransform(answer, tool(name).responseMapping).value as Record<string, unknown>;
      expect(shaped.start_url).toBeUndefined();
      expect(shaped.join_url).toBe(answer.join_url);
    }
  });
});

const TOKEN = process.env.ZOOM_ACCESS_TOKEN;
const S2S =
  !TOKEN && process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_S2S_CLIENT_ID && process.env.ZOOM_S2S_CLIENT_SECRET
    ? { account: process.env.ZOOM_ACCOUNT_ID, id: process.env.ZOOM_S2S_CLIENT_ID, secret: process.env.ZOOM_S2S_CLIENT_SECRET }
    : undefined;
const live = TOKEN || S2S ? describe : describe.skip;

type Refused = { refused: number; code?: number; message?: string };
const isRefused = (x: unknown): x is Refused => typeof x === 'object' && x !== null && 'refused' in x;

live('zoom adapter: live REST API v2', () => {
  const write = process.env.ZOOM_LIVE_WRITE === '1';
  const user = process.env.ZOOM_USER_ID || 'me';
  // The engine refuses a request while any {{VAR}} the connector uses is
  // unfilled. The live run signs in with a bearer token, so stand-ins do.
  const env: Record<string, string> = { ZOOM_CLIENT_ID: 'live-stand-in', ZOOM_CLIENT_SECRET: 'live-stand-in' };
  let token = TOKEN || '';

  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    if (!token && S2S) {
      const basic = Buffer.from(`${S2S.id}:${S2S.secret}`).toString('base64');
      const res = await mockedAxios.__actual.post('https://zoom.us/oauth/token', null, {
        params: { grant_type: 'account_credentials', account_id: S2S.account },
        headers: { Authorization: `Basic ${basic}` },
        timeout: 15_000,
      });
      token = res.data.access_token;
    }
    expect(token).toBeTruthy();
  }, 30_000);

  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, token, params);
  // A call the plan, an add-on or a missing admin scope does not allow comes
  // back as a Zoom error (400 code 200 or 4711, 403, 404); that is an answer.
  const maybe = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    run(name, params).catch((e: { response?: { status: number; data?: { code?: number; message?: string } } }) => {
      const status = e.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        return { refused: status, code: e.response?.data?.code, message: e.response?.data?.message } as Refused;
      }
      throw e;
    });
  // Zoom wants a UUID that starts with "/" or contains "//" double-encoded;
  // the tool encodes once, so it is handed over encoded once.
  const uuidArg = (uuid: string) => (uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(uuid) : uuid);
  const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

  it('reads the signed-in user, the user list and one user', async () => {
    const me = S2S ? await maybe('zoom_get_current_user') : await run('zoom_get_current_user');
    if (!isRefused(me)) {
      expect(typeof me.id).toBe('string');
      expect(typeof me.email).toBe('string');
    }
    const users = await maybe('zoom_list_users', { page_size: 5 });
    if (!isRefused(users)) expect(Array.isArray(users.users ?? [])).toBe(true);
    const one = await maybe('zoom_get_user', { user_id: user });
    if (!isRefused(one)) expect(typeof one.id).toBe('string');
  }, 60_000);

  it('lists meetings and reads one with its registrants and past instances', async () => {
    const list = await run('zoom_list_meetings', { user_id: user, page_size: 5 });
    expect(Array.isArray(list.meetings ?? [])).toBe(true);
    const upcoming = await run('zoom_list_meetings', { user_id: user, type: 'upcoming', page_size: 5 });
    expect(Array.isArray(upcoming.meetings ?? [])).toBe(true);
    const first = (list.meetings ?? [])[0];
    if (!first) return;
    const meeting = await run('zoom_get_meeting', { meeting_id: String(first.id) });
    expect(String(meeting.id)).toBe(String(first.id));
    const shaped = applyResponseTransform(meeting, tool('zoom_get_meeting').responseMapping).value as Record<string, unknown>;
    expect(shaped.start_url).toBeUndefined();
    // Registration may be off for this meeting, or the plan may lack it.
    const registrants = await maybe('zoom_list_meeting_registrants', { meeting_id: String(first.id), page_size: 5 });
    if (!isRefused(registrants)) expect(Array.isArray(registrants.registrants ?? [])).toBe(true);
    const instances = await maybe('zoom_list_past_meeting_instances', { meeting_id: String(first.id) });
    if (!isRefused(instances)) expect(Array.isArray(instances.meetings ?? [])).toBe(true);
  }, 90_000);

  it('reads an ended meeting, its participants and its instances', async () => {
    const previous = await run('zoom_list_meetings', { user_id: user, type: 'previous_meetings', page_size: 5 });
    const ended = (previous.meetings ?? [])[0];
    if (!ended) return;
    const past = await maybe('zoom_get_past_meeting', { meeting_id: String(ended.id) });
    if (isRefused(past)) return; // scheduled but never held
    expect(typeof past.uuid).toBe('string');
    const byUuid = await run('zoom_get_past_meeting', { meeting_id: uuidArg(past.uuid) });
    expect(byUuid.uuid).toBe(past.uuid);
    const participants = await maybe('zoom_list_past_meeting_participants', { meeting_id: uuidArg(past.uuid), page_size: 10 });
    if (!isRefused(participants)) expect(Array.isArray(participants.participants ?? [])).toBe(true);
    const instances = await run('zoom_list_past_meeting_instances', { meeting_id: String(ended.id) });
    expect(Array.isArray(instances.meetings ?? [])).toBe(true);
  }, 90_000);

  it('lists the last month of cloud recordings and reads one meeting recording', async () => {
    const list = await maybe('zoom_list_recordings', { user_id: user, from: day(-29), to: day(0), page_size: 5 });
    if (isRefused(list)) return; // Basic plan: no cloud recording
    expect(Array.isArray(list.meetings ?? [])).toBe(true);
    const recorded = (list.meetings ?? [])[0];
    if (!recorded) return;
    const rec = await run('zoom_get_meeting_recordings', { meeting_id: uuidArg(recorded.uuid) });
    expect(rec.uuid).toBe(recorded.uuid);
    expect(Array.isArray(rec.recording_files ?? [])).toBe(true);
  }, 60_000);

  it('lists webinars and reads one when the add-on is there', async () => {
    const list = await maybe('zoom_list_webinars', { user_id: user, page_size: 5 });
    if (isRefused(list)) return; // no Webinars add-on
    expect(Array.isArray(list.webinars ?? [])).toBe(true);
    const first = (list.webinars ?? [])[0];
    if (!first) return;
    const webinar = await run('zoom_get_webinar', { webinar_id: String(first.id) });
    expect(String(webinar.id)).toBe(String(first.id));
  }, 60_000);

  it('reads the user meetings report and, for one meeting, its report and participant report', async () => {
    const report = await maybe('zoom_get_user_meetings_report', { user_id: user, from: day(-28), to: day(0), page_size: 5 });
    if (isRefused(report)) return; // no admin report scope or not a Pro account
    expect(Array.isArray(report.meetings ?? [])).toBe(true);
    const held = (report.meetings ?? [])[0];
    if (!held) return;
    const detail = await maybe('zoom_get_meeting_report', { meeting_id: uuidArg(held.uuid) });
    if (!isRefused(detail)) expect(detail.uuid).toBe(held.uuid);
    const participants = await maybe('zoom_get_meeting_participants_report', { meeting_id: uuidArg(held.uuid), page_size: 10 });
    if (!isRefused(participants)) expect(Array.isArray(participants.participants ?? [])).toBe(true);
  }, 90_000);

  it('a wrong token is a 401', async () => {
    await expect(execute('zoom_get_current_user', env, 'wrong-token', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);

  (write ? it : it.skip)(
    'schedules a meeting without notifications, reads, updates and registers, then deletes it silently',
    async () => {
      const start = new Date(Date.now() + 7 * 86400_000);
      start.setUTCHours(9, 0, 0, 0);
      const created = await run('zoom_create_meeting', {
        user_id: user,
        topic: 'AnythingMCP live spec (safe to delete)',
        type: 2,
        start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        duration: 30,
        timezone: 'UTC',
        agenda: 'Created by the AnythingMCP live spec.',
        settings: {
          approval_type: 2,
          join_before_host: false,
          waiting_room: true,
          auto_recording: 'none',
          email_notification: false,
          alternative_hosts_email_notification: false,
        },
      });
      const id = String(created.id);
      expect(id).toMatch(/^\d{9,12}$/);
      expect(applyResponseTransform(created, tool('zoom_create_meeting').responseMapping).value).not.toHaveProperty('start_url');
      try {
        const read = await run('zoom_get_meeting', { meeting_id: id });
        expect(read.topic).toBe('AnythingMCP live spec (safe to delete)');
        await run('zoom_update_meeting', { meeting_id: id, topic: 'AnythingMCP live spec (updated, safe to delete)', duration: 45 });
        const updated = await run('zoom_get_meeting', { meeting_id: id });
        expect(updated.topic).toBe('AnythingMCP live spec (updated, safe to delete)');
        expect(updated.duration).toBe(45);

        // Registration needs a paid plan; with its emails off and an
        // example.com address nobody is notified.
        const registration = await maybe('zoom_update_meeting', {
          meeting_id: id,
          settings: { approval_type: 1, registrants_confirmation_email: false, registrants_email_notification: false },
        });
        if (isRefused(registration)) return;
        const added = await maybe('zoom_add_meeting_registrant', {
          meeting_id: id,
          email: 'anythingmcp-live-spec@example.com',
          first_name: 'AnythingMCP',
          last_name: 'Live spec',
        });
        if (isRefused(added)) return;
        expect(typeof added.registrant_id).toBe('string');
        const pending = await run('zoom_list_meeting_registrants', { meeting_id: id, status: 'pending' });
        expect((pending.registrants ?? []).map((r: { id: string }) => r.id)).toContain(added.registrant_id);
        await run('zoom_update_meeting_registrant_status', {
          meeting_id: id,
          action: 'approve',
          registrants: [{ id: added.registrant_id, email: 'anythingmcp-live-spec@example.com' }],
        });
        const approved = await run('zoom_list_meeting_registrants', { meeting_id: id });
        expect((approved.registrants ?? []).map((r: { id: string }) => r.id)).toContain(added.registrant_id);
      } finally {
        await run('zoom_delete_meeting', { meeting_id: id, schedule_for_reminder: false, cancel_meeting_reminder: false });
        const gone = await maybe('zoom_get_meeting', { meeting_id: id });
        expect(isRefused(gone) && gone.refused === 404).toBe(true);
      }
    },
    180_000,
  );
});
