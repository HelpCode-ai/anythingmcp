import axios from 'axios';
import * as adapter from './webex.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { attachResponseMeta } from '../../connectors/engines/response-headers.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Webex adapter:
 *
 *   1. Static: always runs. Pins the OAuth authorization code flow against
 *      webexapis.com (client secret in the form body, PKCE left on, the scope
 *      string the instructions list), the env var patterns, every tool's
 *      method and URL through the real RestEngine, the request bodies of every
 *      write, Link header paging, the response mappings (host key, webhook
 *      secrets and message HTML left out, the transcript download capped), and
 *      the read-only, destructive and switched-off sets.
 *
 *   2. Live: skipped unless RUN_WEBEX_LIVE=1 and WEBEX_ACCESS_TOKEN (an OAuth
 *      access token of a Webex integration with the scopes from the
 *      instructions, or a personal access token from developer.webex.com,
 *      which lasts 12 hours) are set.
 *
 *        RUN_WEBEX_LIVE=1 WEBEX_ACCESS_TOKEN=... npx jest src/adapters/intl/webex.live.spec.ts
 *
 *      Runs every read tool and applies each tool's responseMapping the way
 *      the MCP layer does. Calls the user's license or role does not allow
 *      (meetings without a host license, participants of meetings the user
 *      did not host, transcripts or summaries that do not exist) may be
 *      refused with 400, 403 or 404; that is accepted, a crash or a 401 is not.
 *
 *      WEBEX_LIVE_WRITE=1 also creates a space "AnythingMCP live spec (safe to
 *      delete)" with nobody else in it, posts and reads a message there, then
 *      deletes the space again; and schedules a meeting a week ahead with no
 *      invitees and sendEmail false, reads and updates it, and deletes it with
 *      sendEmail false. No message or e-mail reaches anyone else.
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
    exposeHeaders?: string[];
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
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

const BASE = 'https://webexapis.com/v1';
// Stand-ins only: the engine runs with a bearer token here, never with these.
const ENV = { WEBEX_CLIENT_ID: `C${'a1'.repeat(32)}`, WEBEX_CLIENT_SECRET: 'b2'.repeat(32) };
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const prepare = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return { config, endpointMapping, params: { ...applySchemaDefaults(tool(name).parameters, params), ...env } };
};
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const p = prepare(name, env, params);
  return engine().execute(
    { baseUrl: p.config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: p.config.headers },
    p.endpointMapping,
    p.params,
  ) as Promise<any>;
};
// What the model receives: the body shaped by the tool's responseMapping, then
// the exposed headers and the Link pagination attached, as the MCP layer does.
const executeShaped = async (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const p = prepare(name, env, params);
  const { body, headers } = await engine().executeWithMeta(
    { baseUrl: p.config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: p.config.headers },
    p.endpointMapping,
    p.params,
  );
  const shaped = applyResponseTransform(body, tool(name).responseMapping as never).value;
  return (tool(name).endpointMapping.exposeHeaders?.length
    ? attachResponseMeta(shaped, { headers }, tool(name).endpointMapping.queryParams)
    : shaped) as any;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const SCOPES = [
  'spark:kms',
  'spark:people_read',
  'spark:rooms_read',
  'spark:rooms_write',
  'spark:memberships_read',
  'spark:memberships_write',
  'spark:messages_read',
  'spark:messages_write',
  'spark:teams_read',
  'spark:webhooks_read',
  'meeting:schedules_read',
  'meeting:schedules_write',
  'meeting:participants_read',
  'meeting:transcripts_read',
  'meeting:summaries_read',
  'meeting:recordings_read',
];
const OFF = ['webex_delete_meeting', 'webex_delete_message'];
const WRITES = [
  'webex_add_membership',
  'webex_create_meeting',
  'webex_create_room',
  'webex_delete_meeting',
  'webex_delete_message',
  'webex_send_direct_message',
  'webex_send_message',
  'webex_update_meeting',
];
const PAGED = [
  'webex_list_meeting_invitees',
  'webex_list_meeting_participants',
  'webex_list_meetings',
  'webex_list_memberships',
  'webex_list_messages',
  'webex_list_recordings',
  'webex_list_rooms',
  'webex_list_teams',
  'webex_list_transcript_snippets',
  'webex_list_transcripts',
  'webex_list_webhooks',
  'webex_search_people',
];

describe('webex adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('webex');
    expect(a.icon).toBe('webex');
    expect(a.category).toBe('messaging');
  });

  it('signs in with the authorization code flow at webexapis.com, the secret in the form body and the listed scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{WEBEX_CLIENT_ID}}',
      clientSecret: '{{WEBEX_CLIENT_SECRET}}',
      authorizationUrl: 'https://webexapis.com/v1/authorize',
      tokenUrl: 'https://webexapis.com/v1/access_token',
      tokenAuthMethod: 'client_secret_post',
      scopes: SCOPES.join(' '),
    });
    // Webex supports PKCE on the authorization code flow, so the engine's
    // default (on) stays.
    expect(a.connector.authConfig.pkce).toBeUndefined();
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/people/me');
    expect(a.appRegistrationUrl).toBe('https://developer.webex.com/my-apps/new/integration');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('<your AnythingMCP URL>/api/mcp-oauth/callback');
    for (const scope of SCOPES) expect(a.instructions).toContain(`\`${scope}\``);
  });

  it('asks for the client id and a secret client secret, with patterns', () => {
    expect(a.requiredEnvVars).toEqual(['WEBEX_CLIENT_ID', 'WEBEX_CLIENT_SECRET']);
    const id = new RegExp(a.envVarMeta.WEBEX_CLIENT_ID.pattern!);
    for (const ok of [ENV.WEBEX_CLIENT_ID, `C${'0f'.repeat(32)}`]) expect(id.test(ok)).toBe(true);
    for (const bad of ['', 'abc', ENV.WEBEX_CLIENT_SECRET, `${ENV.WEBEX_CLIENT_ID} `, `C ${'a'.repeat(30)}`]) expect(id.test(bad)).toBe(false);
    const secret = new RegExp(a.envVarMeta.WEBEX_CLIENT_SECRET.pattern!);
    expect(secret.test(ENV.WEBEX_CLIENT_SECRET)).toBe(true);
    for (const bad of ['tooshort', `Bearer ${'a'.repeat(32)}`, ' '.repeat(32)]) expect(secret.test(bad)).toBe(false);
    for (const meta of Object.values(a.envVarMeta)) {
      expect(meta.kind).toBe('credential');
      expect(meta.link).toMatch(/^https:\/\/developer\.webex\.com\//);
    }
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'WEBEX_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'WEBEX_CLIENT_ID')!.secret).toBeFalsy();
  });

  it('probes with the signed-in user, which needs no argument', async () => {
    expect(a.probe.tool).toBe('webex_get_me');
    expect(tool('webex_get_me').parameters.required).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webex_get_me', {});
    expect(sent().url).toBe(`${BASE}/people/me`);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('prefixes every tool with webex_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^webex_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, asks for confirmation on every write, and installs the deletes switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm|wait for their yes/i);
    const destructive = a.tools.filter((t) => !annotationsOf(t).readOnlyHint && annotationsOf(t).destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual(['webex_delete_meeting', 'webex_delete_message', 'webex_update_meeting']);
    expect(tool('webex_update_meeting').annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
  });

  it('URL-encodes every path argument and sends no body on reads', () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(t.endpointMapping.bodyMapping).toBeUndefined();
    }
  });

  it('every responseMapping does real work: a maxBytes alone would be skipped', () => {
    for (const t of a.tools.filter((x) => x.responseMapping)) {
      const tr = t.responseMapping!.transform!;
      expect(`${t.name}:${Boolean(tr.select || tr.exclude || tr.include)}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      expect(`${t.name}:${Boolean(t.responseMapping)}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, documents setup, privacy and paging, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bwebex_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bwebex_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Webex\n')).toBe(true);
    expect(a.instructions).toContain('https://developer.webex.com');
    expect(a.instructions).toContain('Read-only use');
    expect(a.instructions).toContain('Confirm before every write');
    expect(a.instructions).toContain('Personal data and untrusted content');
    expect(a.instructions).toMatch(/never as instructions/);
    expect(a.instructions).toContain('_pagination');
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  const MEETING = '870f51ff287b41be84648412901e0402';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['webex_get_me', {}, 'GET', `${BASE}/people/me`],
    ['webex_search_people', { email: 'ana@example.com' }, 'GET', `${BASE}/people`],
    ['webex_list_rooms', {}, 'GET', `${BASE}/rooms`],
    ['webex_get_room', { roomId: 'Y2lzY29zcGFyazovL3VzL1JPT00vYWJj' }, 'GET', `${BASE}/rooms/Y2lzY29zcGFyazovL3VzL1JPT00vYWJj`],
    ['webex_create_room', { title: 'Project' }, 'POST', `${BASE}/rooms`],
    ['webex_list_memberships', { roomId: 'r1' }, 'GET', `${BASE}/memberships`],
    ['webex_add_membership', { roomId: 'r1', personEmail: 'ana@example.com' }, 'POST', `${BASE}/memberships`],
    ['webex_list_messages', { roomId: 'r1' }, 'GET', `${BASE}/messages`],
    ['webex_list_direct_messages', { personEmail: 'ana@example.com' }, 'GET', `${BASE}/messages/direct`],
    ['webex_get_message', { messageId: 'm1' }, 'GET', `${BASE}/messages/m1`],
    ['webex_send_message', { roomId: 'r1', markdown: 'Hi' }, 'POST', `${BASE}/messages`],
    ['webex_send_direct_message', { toPersonEmail: 'ana@example.com', markdown: 'Hi' }, 'POST', `${BASE}/messages`],
    ['webex_delete_message', { messageId: 'm1' }, 'DELETE', `${BASE}/messages/m1`],
    ['webex_list_teams', {}, 'GET', `${BASE}/teams`],
    ['webex_list_meetings', {}, 'GET', `${BASE}/meetings`],
    ['webex_get_meeting', { meetingId: MEETING }, 'GET', `${BASE}/meetings/${MEETING}`],
    ['webex_create_meeting', { title: 'Weekly', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z' }, 'POST', `${BASE}/meetings`],
    ['webex_update_meeting', { meetingId: MEETING, title: 'Weekly sync' }, 'PATCH', `${BASE}/meetings/${MEETING}`],
    ['webex_delete_meeting', { meetingId: MEETING }, 'DELETE', `${BASE}/meetings/${MEETING}`],
    ['webex_list_meeting_participants', { meetingId: `${MEETING}_I_123` }, 'GET', `${BASE}/meetingParticipants`],
    ['webex_list_meeting_invitees', { meetingId: MEETING }, 'GET', `${BASE}/meetingInvitees`],
    ['webex_list_transcripts', {}, 'GET', `${BASE}/meetingTranscripts`],
    ['webex_list_transcript_snippets', { transcriptId: 't1' }, 'GET', `${BASE}/meetingTranscripts/t1/snippets`],
    ['webex_download_transcript', { transcriptId: 't1' }, 'GET', `${BASE}/meetingTranscripts/t1/download`],
    ['webex_get_meeting_summary', { meetingId: `${MEETING}_I_123` }, 'GET', `${BASE}/meetingSummaries`],
    ['webex_list_recordings', {}, 'GET', `${BASE}/recordings`],
    ['webex_get_recording', { recordingId: 'rec1' }, 'GET', `${BASE}/recordings/rec1`],
    ['webex_list_webhooks', {}, 'GET', `${BASE}/webhooks`],
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

  it('encodes ids with reserved characters in the path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webex_get_message', { messageId: 'a/b?c' });
    expect(sent().url).toBe(`${BASE}/messages/a%2Fb%3Fc`);
  });

  it('posts a space message with markdown and an optional thread parent, and a direct message by e-mail', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webex_send_message', { roomId: 'r1', markdown: '**Done**', parentId: 'p1' });
    expect(sent().data).toEqual({ roomId: 'r1', parentId: 'p1', markdown: '**Done**' });
    mockedAxios.mockClear();
    await call('webex_send_direct_message', { toPersonEmail: 'ana@example.com', markdown: 'Hi Ana', text: 'Hi Ana' });
    expect(sent().data).toEqual({ toPersonEmail: 'ana@example.com', markdown: 'Hi Ana', text: 'Hi Ana' });
    expect(tool('webex_send_message').parameters.required).toEqual(['roomId', 'markdown']);
    expect(tool('webex_send_direct_message').parameters.required).toEqual(['toPersonEmail', 'markdown']);
  });

  it('creates a space and adds a member with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webex_create_room', { title: 'Project', teamId: 't1' });
    expect(sent().data).toEqual({ title: 'Project', teamId: 't1' });
    mockedAxios.mockClear();
    await call('webex_add_membership', { roomId: 'r1', personEmail: 'ana@example.com', isModerator: false });
    expect(sent().data).toEqual({ roomId: 'r1', personEmail: 'ana@example.com', isModerator: false });
  });

  it('schedules a meeting with invitees as given, patches only the changed fields and deletes with sendEmail as a query parameter', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const invitees = [{ email: 'ana@example.com', displayName: 'Ana', coHost: false }];
    await call('webex_create_meeting', {
      title: 'Weekly',
      start: '2026-10-20T15:00:00+02:00',
      end: '2026-10-20T15:30:00+02:00',
      timezone: 'Europe/Berlin',
      invitees,
      sendEmail: false,
    });
    expect(sent().data).toEqual({
      title: 'Weekly',
      start: '2026-10-20T15:00:00+02:00',
      end: '2026-10-20T15:30:00+02:00',
      timezone: 'Europe/Berlin',
      invitees,
      sendEmail: false,
    });
    mockedAxios.mockClear();
    await call('webex_update_meeting', { meetingId: MEETING, agenda: 'New agenda', sendEmail: false });
    expect(sent().data).toEqual({ agenda: 'New agenda', sendEmail: false });
    mockedAxios.mockClear();
    await call('webex_delete_meeting', { meetingId: MEETING, sendEmail: false });
    expect(sent().params).toEqual({ sendEmail: false });
    expect(sent().data).toBeUndefined();
  });

  it('sends list filters, defaults, the timezone header and the cursor', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webex_list_meetings', { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', meetingType: 'meeting', state: 'ended', timezone: 'Europe/Berlin', cursor: 'abc' });
    expect(sent().params).toEqual({ from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', meetingType: 'meeting', state: 'ended', max: 20, cursor: 'abc' });
    expect(sent().headers.timezone).toBe('Europe/Berlin');
    mockedAxios.mockClear();
    await call('webex_list_rooms', {});
    expect(sent().params).toEqual({ sortBy: 'lastactivity', max: 50 });
    expect(sent().headers.timezone).toBeUndefined();
    mockedAxios.mockClear();
    await call('webex_search_people', { displayName: 'Ana' });
    expect(sent().params).toEqual({ displayName: 'Ana', max: 20, excludeStatus: 'true' });
    mockedAxios.mockClear();
    await call('webex_download_transcript', { transcriptId: 't1' });
    expect(sent().params).toEqual({ format: 'txt' });
    expect(sent().headers.Accept).toBe('text/plain');
  });

  it('pages every list tool with the Link header and a cursor parameter', () => {
    const paged = a.tools.filter((t) => t.endpointMapping.exposeHeaders).map((t) => t.name).sort();
    expect(paged).toEqual(PAGED);
    for (const name of PAGED) {
      expect(tool(name).endpointMapping.exposeHeaders).toEqual(['link']);
      expect(tool(name).endpointMapping.queryParams!.cursor).toBe('$cursor');
      // The engine reports the first mapped parameter it finds in the next link, and
      // Webex repeats max, roomId and the filters there: cursor has to come first.
      expect(Object.keys(tool(name).endpointMapping.queryParams!)[0]).toBe('cursor');
      expect(tool(name).description).toContain('_pagination');
    }
  });

  it('turns a Webex next link into a cursor the model can pass back', () => {
    const link = `<${BASE}/rooms?max=2&cursor=bGltaXQ9MiZiZWZvcmU9>; rel="next"`;
    const shaped = shape('webex_list_rooms', { items: [{ id: 'r1', title: 'A', type: 'group', creatorId: 'x' }] }).value;
    const out = attachResponseMeta(shaped, { headers: { link } }, tool('webex_list_rooms').endpointMapping.queryParams) as any;
    expect(out.items).toEqual([{ id: 'r1', title: 'A', type: 'group' }]);
    expect(out._pagination).toMatchObject({ nextCursor: 'bGltaXQ9MiZiZWZvcmU9', cursorParam: 'cursor' });
    // Messages: a next link that continues with beforeMessage is fed back the same way.
    const msgLink = `<${BASE}/messages?roomId=r1&max=25&beforeMessage=m25>; rel="next"`;
    const msgs = attachResponseMeta({ items: [] }, { headers: { link: msgLink } }, tool('webex_list_messages').endpointMapping.queryParams) as any;
    expect(msgs._pagination).toMatchObject({ nextCursor: 'm25', cursorParam: 'beforeMessage' });
    // A next link without cursor names another parameter; the instructions
    // tell the model not to feed that back and to narrow from/to instead.
    const mtgLink = `<${BASE}/meetings?from=2026-10-01T00:00:00Z&max=20&offset=20>; rel="next"`;
    const mtgs = attachResponseMeta({ items: [] }, { headers: { link: mtgLink } }, tool('webex_list_meetings').endpointMapping.queryParams) as any;
    expect(mtgs._pagination.cursorParam).not.toBe('cursor');
    expect(a.instructions).toMatch(/When `cursorParam` is anything else[^.]*do not feed it back/);
    const last = attachResponseMeta({ items: [] }, { headers: {} }, tool('webex_list_rooms').endpointMapping.queryParams) as any;
    expect(last._pagination).toBeUndefined();
  });

  it('keeps the host key, panelist passwords and webhook secrets out, and message HTML and cards too', () => {
    const meeting = { id: MEETING, title: 'Weekly', password: 'Pw1', webLink: 'https://example.webex.com/x', hostKey: '123456', panelistPassword: 'p', phoneAndVideoSystemPassword: '1', links: [{ rel: 'self' }] };
    for (const name of ['webex_get_meeting', 'webex_create_meeting', 'webex_update_meeting']) {
      const out = shape(name, meeting).value as Record<string, unknown>;
      expect(out).toEqual({ id: MEETING, title: 'Weekly', password: 'Pw1', webLink: 'https://example.webex.com/x' });
    }
    const hooks = shape('webex_list_webhooks', { items: [{ id: 'w1', name: 'n', targetUrl: 'https://example.com/h', resource: 'messages', event: 'created', secret: 'shh', status: 'active' }] }).value as any;
    expect(hooks.items[0].secret).toBeUndefined();
    expect(hooks.items[0].targetUrl).toBe('https://example.com/h');
    const msg = shape('webex_get_message', { id: 'm1', text: 'hi', html: '<p>hi</p>', attachments: [{ contentType: 'card' }] }).value;
    expect(msg).toEqual({ id: 'm1', text: 'hi' });
    const list = shape('webex_list_messages', { items: [{ id: 'm1', text: 'hi', html: '<p>hi</p>', personId: 'p', personEmail: 'ana@example.com', created: 'c' }] }).value as any;
    expect(list.items).toEqual([{ id: 'm1', text: 'hi', personEmail: 'ana@example.com', created: 'c' }]);
  });

  it('shapes transcripts, summaries, participants and recordings', () => {
    const snippets = shape('webex_list_transcript_snippets', { items: [{ id: 's1', text: 'Hello', personName: 'Ana', personEmail: 'ana@example.com', offsetMillisecond: 10, durationMillisecond: 900 }] }).value as any;
    expect(snippets.items).toEqual([{ personName: 'Ana', text: 'Hello', offsetMillisecond: 10, durationMillisecond: 900 }]);
    const summary = shape('webex_get_meeting_summary', { items: [{ id: 'x', meetingId: 'm', status: 'available', notes: { content: '<p>Notes</p>' }, actionItems: [{ id: 'a', content: 'Send deck' }] }] }).value as any;
    expect(summary.items).toEqual([{ id: 'x', meetingId: 'm', status: 'available', notes: '<p>Notes</p>', actionItems: ['Send deck'] }]);
    const participants = shape('webex_list_meeting_participants', { items: [{ id: 'p', displayName: 'Ana', email: 'ana@example.com', host: true, devices: [{ deviceType: 'mac', correlationId: 'c' }], joinedTime: 'j' }] }).value as any;
    expect(participants.items).toEqual([{ id: 'p', displayName: 'Ana', email: 'ana@example.com', host: true, joinedTime: 'j' }]);
    const recordings = shape('webex_list_recordings', { items: [{ id: 'r', topic: 'T', password: 'pw', playbackUrl: 'https://p', downloadUrl: 'https://d', integrationTags: ['x'] }] }).value as any;
    expect(recordings.items).toEqual([{ id: 'r', topic: 'T', playbackUrl: 'https://p', downloadUrl: 'https://d' }]);
    const rec = shape('webex_get_recording', { id: 'r', password: 'pw', temporaryDirectDownloadLinks: { recordingDownloadLink: 'https://t', expiration: 'e' }, integrationTags: ['x'] }).value as any;
    expect(rec).toEqual({ id: 'r', password: 'pw', temporaryDirectDownloadLinks: { recordingDownloadLink: 'https://t', expiration: 'e' } });
  });

  it('caps a long plain-text transcript download and leaves a short one as it is', () => {
    const short = 'Ana 00:00:01\nHello\n';
    expect(shape('webex_download_transcript', short).value).toBe(short);
    const long = 'Ana 00:00:01\nHello everyone.\n'.repeat(10_000);
    const out = shape('webex_download_transcript', long);
    expect(out.truncated).toBe(true);
    expect((out.value as any)._truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(110_000);
  });
});

const TOKEN = process.env.WEBEX_ACCESS_TOKEN;
const live = process.env.RUN_WEBEX_LIVE === '1' && TOKEN ? describe : describe.skip;

type Refused = { refused: number; message?: string };
const isRefused = (x: unknown): x is Refused => typeof x === 'object' && x !== null && 'refused' in x;

live('webex adapter: live REST API', () => {
  const write = process.env.WEBEX_LIVE_WRITE === '1';
  // The engine refuses a request while any {{VAR}} the connector uses is
  // unfilled. The live run signs in with a bearer token, so stand-ins do.
  const env: Record<string, string> = { WEBEX_CLIENT_ID: 'live-stand-in', WEBEX_CLIENT_SECRET: 'live-stand-in' };
  const token = TOKEN || '';

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => executeShaped(name, env, token, params);
  // A call the license, role or meeting does not allow comes back as 400, 403
  // or 404 from Webex; that is an answer, not a broken tool.
  const maybe = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    run(name, params).catch((e: { response?: { status: number; data?: { message?: string } } }) => {
      const status = e.response?.status;
      if (status === 400 || status === 403 || status === 404) return { refused: status, message: e.response?.data?.message } as Refused;
      throw e;
    });
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('reads the signed-in user and finds them by e-mail', async () => {
    const me = await run('webex_get_me');
    expect(typeof me.id).toBe('string');
    expect(Array.isArray(me.emails)).toBe(true);
    const found = await run('webex_search_people', { email: me.emails[0], max: 1 });
    expect(found.items.map((p: { id: string }) => p.id)).toContain(me.id);
  }, 60_000);

  it('lists spaces, reads one with its members and recent messages, and lists teams and webhooks', async () => {
    const rooms = await run('webex_list_rooms', { max: 2 });
    expect(Array.isArray(rooms.items)).toBe(true);
    if (rooms.items.length === 2) expect(rooms._pagination === undefined || typeof rooms._pagination.nextUrl === 'string').toBe(true);
    const first = rooms.items[0];
    if (first) {
      const room = await run('webex_get_room', { roomId: first.id });
      expect(room.id).toBe(first.id);
      const members = await run('webex_list_memberships', { roomId: first.id, max: 5 });
      expect(Array.isArray(members.items)).toBe(true);
      const messages = await maybe('webex_list_messages', { roomId: first.id, max: 3 });
      if (!isRefused(messages)) {
        expect(Array.isArray(messages.items)).toBe(true);
        const m = messages.items[0];
        if (m) {
          const one = await run('webex_get_message', { messageId: m.id });
          expect(one.id).toBe(m.id);
          expect(one.html).toBeUndefined();
        }
      }
    }
    const teams = await run('webex_list_teams', { max: 5 });
    expect(Array.isArray(teams.items)).toBe(true);
    const hooks = await run('webex_list_webhooks', { max: 5 });
    expect(Array.isArray(hooks.items)).toBe(true);
    for (const h of hooks.items) expect(h.secret).toBeUndefined();
  }, 90_000);

  it('lists meetings, reads one with its invitees, and the last month of ended meetings with their after-meeting data', async () => {
    const series = await maybe('webex_list_meetings', { max: 5 });
    if (isRefused(series)) return; // no Meetings license
    expect(Array.isArray(series.items)).toBe(true);
    const next = series.items[0];
    if (next) {
      const meeting = await run('webex_get_meeting', { meetingId: next.id });
      expect(meeting.id).toBe(next.id);
      expect(meeting.hostKey).toBeUndefined();
      const invitees = await maybe('webex_list_meeting_invitees', { meetingId: next.id, max: 5 });
      if (!isRefused(invitees)) expect(Array.isArray(invitees.items)).toBe(true);
    }
    const ended = await run('webex_list_meetings', { meetingType: 'meeting', state: 'ended', from: iso(-30), to: iso(0), max: 5 });
    expect(Array.isArray(ended.items)).toBe(true);
    const held = ended.items[0];
    if (held) {
      const participants = await maybe('webex_list_meeting_participants', { meetingId: held.id, max: 10 });
      if (!isRefused(participants)) expect(Array.isArray(participants.items)).toBe(true);
      const summary = await maybe('webex_get_meeting_summary', { meetingId: held.id });
      if (!isRefused(summary)) expect(Array.isArray(summary.items)).toBe(true);
    }
  }, 90_000);

  it('lists transcripts and reads one as snippets and as text', async () => {
    const list = await maybe('webex_list_transcripts', { from: iso(-30), to: iso(0), max: 5 });
    if (isRefused(list)) return;
    expect(Array.isArray(list.items)).toBe(true);
    const t = list.items[0];
    if (!t) return;
    const snippets = await run('webex_list_transcript_snippets', { transcriptId: t.id, max: 20 });
    expect(Array.isArray(snippets.items)).toBe(true);
    const text = await run('webex_download_transcript', { transcriptId: t.id });
    expect(typeof text === 'string' || text._truncated === true).toBe(true);
  }, 90_000);

  it('lists recordings and reads one', async () => {
    const list = await maybe('webex_list_recordings', { from: iso(-30), to: iso(0), max: 5 });
    if (isRefused(list)) return;
    expect(Array.isArray(list.items)).toBe(true);
    const r = list.items[0];
    if (!r) return;
    const rec = await run('webex_get_recording', { recordingId: r.id });
    expect(rec.id).toBe(r.id);
  }, 60_000);

  (write ? it : it.skip)('creates a private space, posts and reads a message, then removes the space', async () => {
    const room = await run('webex_create_room', { title: 'AnythingMCP live spec (safe to delete)' });
    expect(typeof room.id).toBe('string');
    try {
      const posted = await run('webex_send_message', { roomId: room.id, markdown: '**AnythingMCP live spec**: safe to ignore.' });
      expect(posted.roomId).toBe(room.id);
      const read = await run('webex_get_message', { messageId: posted.id });
      expect(read.markdown).toContain('AnythingMCP live spec');
      const members = await run('webex_list_memberships', { roomId: room.id });
      expect(members.items).toHaveLength(1);
    } finally {
      // Removing spaces is not a tool of this adapter; the test cleans up directly.
      await mockedAxios.__actual.delete(`${BASE}/rooms/${encodeURIComponent(room.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    }
  }, 90_000);

  (write ? it : it.skip)('schedules, reads, updates and deletes a meeting without e-mails', async () => {
    const start = new Date(Date.now() + 7 * 86400_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const created = await maybe('webex_create_meeting', {
      title: 'AnythingMCP live spec (safe to delete)',
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: 'UTC',
      sendEmail: false,
    });
    if (isRefused(created)) return; // no Meetings license
    expect(created.hostKey).toBeUndefined();
    try {
      const read = await run('webex_get_meeting', { meetingId: created.id });
      expect(read.title).toBe('AnythingMCP live spec (safe to delete)');
      const updated = await run('webex_update_meeting', { meetingId: created.id, agenda: 'Changed by the live spec', sendEmail: false });
      expect(updated.agenda).toBe('Changed by the live spec');
    } finally {
      await run('webex_delete_meeting', { meetingId: created.id, sendEmail: false });
    }
  }, 90_000);

  it('a wrong token is a 401', async () => {
    await expect(execute('webex_get_me', env, 'wrong-token', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
