import axios from 'axios';
import * as adapter from './google-chat.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Google Chat API v1 (developers.google.com/workspace/chat/api/reference/rest,
 * discovery document at chat.googleapis.com/$discovery/rest?version=v1), user
 * authentication with the shared Google OAuth client. Resource names are
 * spaces/{space}/messages/{message}; tools take the ids separately.
 *
 *   1. Static: always runs. Pins the OAuth setup and scopes, every URL, query
 *      and body against the discovery document, the trimmed message answers,
 *      the attachment download, and the tools switched off.
 *   2. Live (read-only): skipped unless RUN_GOOGLE_CHAT_LIVE=1 and
 *      GOOGLE_CHAT_ACCESS_TOKEN (a user token with chat.spaces.readonly,
 *      chat.messages.readonly and chat.memberships.readonly, e.g. from the
 *      OAuth Playground) are set:
 *
 *        RUN_GOOGLE_CHAT_LIVE=1 GOOGLE_CHAT_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-chat
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { binary?: { maxBytes?: number }; transform?: unknown };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const P = 'google_chat_';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === P + name);
  if (!t) throw new Error(`missing tool ${P}${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const BASE = 'https://chat.googleapis.com';
const S = 'AAAAMpdlehY';
const M = 'ZJ7sqN6qlYk.ZJ7sqN6qlYk';
const MSG = `/v1/spaces/${S}/messages/${M}`;
const call = (name: string, params: Record<string, unknown>) =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: { ...a.connector.authConfig }, headers: { ...a.connector.headers } },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  );
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-chat adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses the shared Google OAuth client with offline access and the three Chat scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes:
        'https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.memberships.readonly',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/Configure the Chat app/);
    expect(a.prerequisites).toMatch(/Chat app configured/);
    expect(a.instructions).toMatch(/read-only setup[^\n]*chat\.messages\.readonly/);
  });

  it('probes with list_spaces, which needs no arguments', () => {
    expect(a.probe).toEqual({ tool: `${P}list_spaces`, params: { page_size: 1 } });
    expect(tool('list_spaces').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/v1/spaces?pageSize=1');
  });

  it('prefixes every tool, shares no name with another adapter, and every declared parameter reaches the request', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^google_chat_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters.required).toContain(p);
      expect(t.endpointMapping.path.startsWith('/v1/')).toBe(true);
    }
  });

  it('percent-encodes ids, except the attachment resource name, whose slashes must stay', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (p.includes('{resource_name}')) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:undefined`);
      else if (/\{\w+\}/.test(p)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs both deletes switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([`${P}delete_message`, `${P}delete_reaction`]);
    expect(a.instructions).toContain(`**Switched off at install**: \`${P}delete_message\` and \`${P}delete_reaction\`;`);
    for (const n of ['delete_message', 'delete_reaction']) expect(annotationsOf(tool(n)).destructiveHint).toBe(true);
  });

  it('marks reads (the POST message search included) read-only, and nothing else', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name.slice(P.length));
    expect(readOnly.sort()).toEqual([
      'download_attachment',
      'find_direct_message',
      'get_attachment',
      'get_message',
      'get_space',
      'list_members',
      'list_messages',
      'list_reactions',
      'list_space_events',
      'list_spaces',
      'search_messages',
      'search_spaces',
    ]);
  });

  it.each([
    ['list_spaces', {}, 'GET', '/v1/spaces'],
    ['search_spaces', { query: 'display_name:"Sales" AND space_type = "SPACE"' }, 'GET', '/v1/spaces:search'],
    ['get_space', { space_id: S }, 'GET', `/v1/spaces/${S}`],
    ['find_direct_message', { user: 'users/ana@example.com' }, 'GET', '/v1/spaces:findDirectMessage'],
    ['list_members', { space_id: S }, 'GET', `/v1/spaces/${S}/members`],
    ['list_messages', { space_id: S }, 'GET', `/v1/spaces/${S}/messages`],
    ['get_message', { space_id: S, message_id: M }, 'GET', MSG],
    ['search_messages', { filter: 'budget' }, 'POST', '/v1/spaces/-/messages:search'],
    ['list_reactions', { space_id: S, message_id: M }, 'GET', `${MSG}/reactions`],
    ['get_attachment', { space_id: S, message_id: M, attachment_id: 'AATUf' }, 'GET', `${MSG}/attachments/AATUf`],
    ['download_attachment', { resource_name: `spaces/${S}/attachments/AATUf` }, 'GET', `/v1/media/spaces/${S}/attachments/AATUf`],
    ['list_space_events', { space_id: S, filter: 'event_types:"google.workspace.chat.message.v1.created"' }, 'GET', `/v1/spaces/${S}/spaceEvents`],
    ['create_message', { space_id: S, text: 'Hi' }, 'POST', `/v1/spaces/${S}/messages`],
    ['reply_in_thread', { space_id: S, thread_name: `spaces/${S}/threads/T1`, text: 'Hi' }, 'POST', `/v1/spaces/${S}/messages`],
    ['update_message', { space_id: S, message_id: M, text: 'Hi' }, 'PATCH', MSG],
    ['add_reaction', { space_id: S, message_id: M, emoji: '\u{1F44D}' }, 'POST', `${MSG}/reactions`],
    ['delete_reaction', { space_id: S, message_id: M, reaction_id: 'R1' }, 'DELETE', `${MSG}/reactions/R1`],
    ['delete_message', { space_id: S, message_id: M }, 'DELETE', MSG],
  ])('%s sends %s to the right Chat URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('passes filters and paging with the documented camelCase names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('list_messages', { space_id: S, filter: 'create_time > "2026-10-01T00:00:00Z"', order_by: 'create_time desc', show_deleted: true, page_size: 50, page_token: 'nx' });
    expect(sent().params).toEqual({ filter: 'create_time > "2026-10-01T00:00:00Z"', orderBy: 'create_time desc', showDeleted: true, pageSize: 50, pageToken: 'nx' });
    mockedAxios.mockClear();
    await call('list_members', { space_id: S, show_invited: true, show_groups: true });
    expect(sent().params).toEqual({ showInvited: true, showGroups: true });
    mockedAxios.mockClear();
    await call('find_direct_message', { user: 'users/ana@example.com' });
    expect(sent().params).toEqual({ name: 'users/ana@example.com' });
    mockedAxios.mockClear();
    await call('download_attachment', { resource_name: 'spaces/S/attachments/A' });
    expect(sent().params).toEqual({ alt: 'media' });
    expect(tool('download_attachment').responseMapping?.binary?.maxBytes).toBe(10485760);
  });

  it('searches messages across all spaces with a JSON body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('search_messages', { filter: 'budget sender.name = "users/ana@example.com"', page_size: 10, page_token: 'p2' });
    expect(sent().data).toEqual({ filter: 'budget sender.name = "users/ana@example.com"', pageSize: 10, pageToken: 'p2' });
  });

  it('posts new messages, replies in a thread with fallback, edits text and reacts', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('create_message', { space_id: S, text: 'Hello *team*', request_id: 'r-1' });
    expect(sent().data).toEqual({ text: 'Hello *team*' });
    expect(sent().params).toEqual({ requestId: 'r-1' });
    mockedAxios.mockClear();
    await call('reply_in_thread', { space_id: S, thread_name: `spaces/${S}/threads/T1`, text: 'Done' });
    expect(sent().data).toEqual({ text: 'Done', thread: { name: `spaces/${S}/threads/T1` } });
    expect(sent().params).toEqual({ messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' });
    mockedAxios.mockClear();
    await call('update_message', { space_id: S, message_id: M, text: 'Fixed' });
    expect(sent().data).toEqual({ text: 'Fixed' });
    expect(sent().params).toEqual({ updateMask: 'text' });
    mockedAxios.mockClear();
    await call('add_reaction', { space_id: S, message_id: M, emoji: '✅' });
    expect(sent().data).toEqual({ emoji: { unicode: '✅' } });
  });

  it('leaves card payloads and the duplicate formatted text out of message answers', () => {
    const one = tool('get_message').responseMapping!;
    expect(validateTransform(one.transform as never)).toBeNull();
    expect(applyResponseTransform({ name: 'n', text: 't', cardsV2: [{}], formattedText: 't' }, one as never).value).toEqual({ name: 'n', text: 't' });
    const list = tool('list_messages').responseMapping!;
    expect(validateTransform(list.transform as never)).toBeNull();
    expect(
      applyResponseTransform({ messages: [{ name: 'n', text: 't', cards: [{}], accessoryWidgets: [{}] }], nextPageToken: 'x' }, list as never).value,
    ).toEqual({ messages: [{ name: 'n', text: 't' }], nextPageToken: 'x' });
  });

  it('documents every tool in the instructions, names only real tools, and writes no em dash', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of names) expect(`${n}:${a.instructions.includes(n)}`).toBe(`${n}:true`);
    const mentioned = [a.instructions, ...a.tools.map((t) => t.description)].flatMap((s) => [...s.matchAll(/\bgoogle_chat_[a-z_]+/g)].map((m) => m[0]));
    for (const n of mentioned) expect(names).toContain(n);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const TOKEN = process.env.GOOGLE_CHAT_ACCESS_TOKEN;
const live = process.env.RUN_GOOGLE_CHAT_LIVE === '1' && TOKEN ? describe : describe.skip;

live('google-chat adapter: live Chat API (read-only)', () => {
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as never)));
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping,
        applySchemaDefaults(tool(name).parameters, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping as never).value);

  it('lists spaces, then reads one space, its members and latest messages', async () => {
    const spaces = await run('list_spaces', { page_size: 5 });
    expect(Array.isArray(spaces.spaces ?? [])).toBe(true);
    const first = (spaces.spaces ?? [])[0] as { name: string } | undefined;
    if (!first) return;
    const id = first.name.replace(/^spaces\//, '');
    expect((await run('get_space', { space_id: id })).name).toBe(first.name);
    expect(Array.isArray((await run('list_members', { space_id: id, page_size: 5 })).memberships ?? [])).toBe(true);
    const msgs = await run('list_messages', { space_id: id, order_by: 'create_time desc', page_size: 3 });
    expect(Array.isArray(msgs.messages ?? [])).toBe(true);
  }, 60_000);
});
