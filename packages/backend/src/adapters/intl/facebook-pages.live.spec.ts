import axios from 'axios';
import * as adapter from './facebook-pages.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Facebook Pages adapter:
 *
 *   1. Static: always runs. Pins the Page token as a bearer header on Graph
 *      API v26.0, the Page id variable in the Page-level paths, the default
 *      fields and insights metrics (none of them retired by Meta in 2025 or
 *      2026), the form bodies of posts, comments and moderation, the JSON
 *      body of the Send API, every tool's method and URL, which tools ask
 *      for confirmation and which install switched off.
 *
 *   2. Live: skipped unless FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID
 *      are set (a Page token with pages_read_engagement and read_insights):
 *
 *        FACEBOOK_PAGE_ACCESS_TOKEN=EAA... FACEBOOK_PAGE_ID=1045... \
 *          npx jest src/adapters/intl/facebook-pages.live.spec.ts
 *
 *      Reads the Page, posts, feed, scheduled posts, comments, Page and post
 *      insights and, when the token has pages_messaging, conversations.
 *
 *      FACEBOOK_PAGES_LIVE_WRITE=1 (needs pages_manage_posts) schedules a
 *      post two days ahead, finds it among the scheduled posts, edits its
 *      text and deletes it in `finally`, so nothing is ever published.
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
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  icon: string;
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

// Built at run time so no literal here looks like a real token.
const TOKEN = 'EAA' + 'x'.repeat(40);
const PAGE = '104512345678901';
const ENV = { FACEBOOK_PAGE_ACCESS_TOKEN: TOKEN, FACEBOOK_PAGE_ID: PAGE };
const BASE = 'https://graph.facebook.com/v26.0';
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

// Everything that is public or reaches a customer the moment it runs.
const CONFIRMED = [
  'facebook_pages_create_post',
  'facebook_pages_schedule_post',
  'facebook_pages_create_photo_post',
  'facebook_pages_update_post',
  'facebook_pages_comment_on_post',
  'facebook_pages_reply_to_comment',
  'facebook_pages_send_message',
  'facebook_pages_send_private_reply',
];
const OFF = ['facebook_pages_delete_comment', 'facebook_pages_delete_post'];

// Retired by Meta on 14 Mar 2024, 15 Nov 2025 and 15 Jun 2026 (Graph API
// v25.0 changelog and the Pages API "deprecated metrics" page): Graph answers
// any call that names one of them with an invalid-metric error.
const RETIRED_METRICS = [
  'page_impressions', 'page_impressions_unique', 'page_impressions_paid', 'page_impressions_paid_unique',
  'page_impressions_viral', 'page_impressions_viral_unique', 'page_impressions_nonviral', 'page_impressions_nonviral_unique',
  'page_fans', 'page_fans_locale', 'page_fans_city', 'page_fans_country', 'page_fan_adds', 'page_fan_adds_unique',
  'page_fan_removes', 'page_fan_removes_unique', 'page_engaged_users', 'page_consumptions',
  'page_posts_impressions', 'page_posts_impressions_unique', 'page_posts_impressions_paid', 'page_posts_impressions_organic_unique',
  'page_video_views_unique', 'post_impressions', 'post_impressions_unique', 'post_impressions_paid', 'post_impressions_fan',
  'post_impressions_organic', 'post_impressions_viral', 'post_impressions_nonviral', 'post_engaged_users',
  'post_video_views_unique', 'post_video_views_organic_unique', 'post_video_views_paid_unique',
];

describe('facebook-pages adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.name).toBe('Facebook Pages');
    expect(a.icon).toBe('facebook');
    expect(a.prerequisites).toMatch(/Page access token/);
  });

  it('sends the Page token as a bearer header to Graph API v26.0, never in the URL', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({
      token: '{{FACEBOOK_PAGE_ACCESS_TOKEN}}',
      // A pasted user token becomes a Page token that does not expire when
      // the app id and secret are set.
      tokenRenewal: {
        provider: 'meta',
        appIdVar: 'META_APP_ID',
        appSecretVar: 'META_APP_SECRET',
        pageIdVar: 'FACEBOOK_PAGE_ID',
        graphVersion: 'v26.0',
      },
    });
    expect((a as { optionalEnvVars?: string[] }).optionalEnvVars).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.instructions).toContain('v26.0');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('facebook_pages_get_page', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().url).not.toContain(TOKEN);
    expect(JSON.stringify(sent().params)).not.toContain(TOKEN);
  });

  it('checks the token and the numeric Page id, and keeps the token secret', () => {
    expect(a.requiredEnvVars).toEqual(['FACEBOOK_PAGE_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID']);
    const token = new RegExp(a.envVarMeta.FACEBOOK_PAGE_ACCESS_TOKEN.pattern!);
    expect(token.test(TOKEN)).toBe(true);
    expect(token.test(`Bearer ${TOKEN}`)).toBe(false);
    const page = new RegExp(a.envVarMeta.FACEBOOK_PAGE_ID.pattern!);
    expect(page.test(PAGE)).toBe(true);
    expect(page.test('MyBakery')).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'FACEBOOK_PAGE_ACCESS_TOKEN')!.secret).toBe(true);
  });

  it('explains how to get a Page token that never expires', () => {
    expect(a.instructions).toMatch(/me\/accounts/);
    expect(a.instructions).toMatch(/Extend Access Token/);
    expect(a.instructions).toMatch(/expires Never/);
    expect(a.instructions).toMatch(/System users/);
  });

  it('probes with the Page itself, which needs no arguments', () => {
    expect(a.probe).toEqual({ tool: 'facebook_pages_get_page' });
    expect(tool('facebook_pages_get_page').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me?fields=id,name');
  });

  it('prefixes every tool with facebook_pages_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^facebook_pages_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks before anything public and installs deletions switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    for (const name of CONFIRMED) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:true:false`);
      expect(tool(name).description).toMatch(/wait for (their|the user's) confirmation/);
      expect(tool(name).enabled).toBeUndefined();
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) {
      expect(tool(name).endpointMapping.method).toBe('DELETE');
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    // Hiding is reversible and repeatable.
    const hide = annotationsOf(tool('facebook_pages_hide_comment'));
    expect(`${hide.readOnlyHint}:${hide.destructiveHint}:${hide.idempotentHint}`).toBe('false:false:true');
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual([...CONFIRMED, ...OFF, 'facebook_pages_hide_comment'].sort());
  });

  it('asks for useful fields by default, since the Graph API returns only ids otherwise', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET' && !x.name.endsWith('_insights'))) {
      expect(`${t.name}:${typeof t.parameters.properties?.fields?.default}`).toBe(`${t.name}:string`);
      expect(t.endpointMapping.queryParams?.fields).toBe('$fields');
    }
  });

  it('defaults to insights metrics Meta still serves, and warns about the retired ones', () => {
    for (const name of ['facebook_pages_get_page_insights', 'facebook_pages_get_post_insights']) {
      const metrics = String(tool(name).parameters.properties?.metric?.default).split(',');
      expect(metrics.length).toBeGreaterThan(3);
      for (const m of metrics) expect(`${name}:${RETIRED_METRICS.includes(m)}`).toBe(`${name}:false`);
    }
    expect(String(tool('facebook_pages_get_page_insights').parameters.properties?.metric?.default)).toMatch(/^page_/);
    expect(String(tool('facebook_pages_get_post_insights').parameters.properties?.metric?.default)).toMatch(/^post_/);
    // The recommended lists in the instructions name no retired metric either.
    const recommended = a.instructions.split('- Gone, do not use')[0];
    for (const m of RETIRED_METRICS) expect(`${m}:${new RegExp(`\`${m}\``).test(recommended)}`).toBe(`${m}:false`);
    expect(a.instructions).toMatch(/Gone, do not use: `page_impressions`/);
  });

  it('keeps page sizes inside what Graph allows', () => {
    for (const t of a.tools) {
      const limit = t.parameters.properties?.limit as { maximum?: number } | undefined;
      if (limit) expect(`${t.name}:${limit.maximum}`).toBe(`${t.name}:100`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfacebook_pages_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfacebook_pages_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const P = `${BASE}/${PAGE}`;
  const POST = `${PAGE}_200`;
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['facebook_pages_get_page', {}, 'GET', P],
    ['facebook_pages_list_posts', {}, 'GET', `${P}/posts`],
    ['facebook_pages_list_feed', {}, 'GET', `${P}/feed`],
    ['facebook_pages_list_scheduled_posts', {}, 'GET', `${P}/scheduled_posts`],
    ['facebook_pages_get_post', { post_id: POST }, 'GET', `${BASE}/${POST}`],
    ['facebook_pages_create_post', { message: 'Hi' }, 'POST', `${P}/feed`],
    ['facebook_pages_schedule_post', { message: 'Hi', scheduled_publish_time: '1767261600' }, 'POST', `${P}/feed`],
    ['facebook_pages_create_photo_post', { url: 'https://example.com/a.jpg' }, 'POST', `${P}/photos`],
    ['facebook_pages_update_post', { post_id: POST, message: 'Hi' }, 'POST', `${BASE}/${POST}`],
    ['facebook_pages_delete_post', { post_id: POST }, 'DELETE', `${BASE}/${POST}`],
    ['facebook_pages_list_comments', { object_id: POST }, 'GET', `${BASE}/${POST}/comments`],
    ['facebook_pages_comment_on_post', { post_id: POST, message: 'Hi' }, 'POST', `${BASE}/${POST}/comments`],
    ['facebook_pages_reply_to_comment', { comment_id: '200_300', message: 'Hi' }, 'POST', `${BASE}/200_300/comments`],
    ['facebook_pages_hide_comment', { comment_id: '200_300', is_hidden: true }, 'POST', `${BASE}/200_300`],
    ['facebook_pages_delete_comment', { comment_id: '200_300' }, 'DELETE', `${BASE}/200_300`],
    ['facebook_pages_get_page_insights', {}, 'GET', `${P}/insights`],
    ['facebook_pages_get_post_insights', { post_id: POST }, 'GET', `${BASE}/${POST}/insights`],
    ['facebook_pages_list_conversations', {}, 'GET', `${P}/conversations`],
    ['facebook_pages_list_messages', { conversation_id: 't_400' }, 'GET', `${BASE}/t_400/messages`],
    ['facebook_pages_send_message', { recipient_id: '500', text: 'Hi' }, 'POST', `${P}/messages`],
    ['facebook_pages_send_private_reply', { comment_id: '200_300', text: 'Hi' }, 'POST', `${P}/messages`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
  });

  it('publishes now, or schedules with published=false, as form fields', async () => {
    mockedAxios.mockResolvedValue({ data: { id: POST } });
    await call('facebook_pages_create_post', { message: 'Opening hours change', link: 'https://example.com/' });
    expect(sent().data).toBe('message=Opening+hours+change&link=https%3A%2F%2Fexample.com%2F');
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    mockedAxios.mockClear();
    await call('facebook_pages_schedule_post', { message: 'Soon', scheduled_publish_time: '1767261600' });
    expect(sent().data).toBe('message=Soon&published=false&scheduled_publish_time=1767261600');
    mockedAxios.mockClear();
    await call('facebook_pages_create_photo_post', { url: 'https://example.com/a.jpg', caption: 'New', published: false, scheduled_publish_time: '1767261600' });
    expect(sent().data).toBe('url=https%3A%2F%2Fexample.com%2Fa.jpg&caption=New&published=false&scheduled_publish_time=1767261600');
    mockedAxios.mockClear();
    await call('facebook_pages_update_post', { post_id: POST, is_published: true });
    expect(sent().data).toBe('is_published=true');
  });

  it('comments, replies and hides with form fields', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await call('facebook_pages_reply_to_comment', { comment_id: '200_300', message: 'Thanks!' });
    expect(sent().data).toBe('message=Thanks%21');
    mockedAxios.mockClear();
    await call('facebook_pages_hide_comment', { comment_id: '200_300', is_hidden: false });
    expect(sent().data).toBe('is_hidden=false');
  });

  it('reads comments with the documented filter and order values', async () => {
    expect(tool('facebook_pages_list_comments').parameters.properties?.filter?.enum).toEqual(['toplevel', 'stream']);
    expect(tool('facebook_pages_list_comments').parameters.properties?.order?.enum).toEqual(['chronological', 'reverse_chronological']);
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('facebook_pages_list_comments', { object_id: POST, filter: 'stream', summary: true, limit: 50 });
    expect(sent().params).toEqual(expect.objectContaining({ filter: 'stream', summary: true, limit: 50 }));
  });

  it('sends Messenger messages in the Send API JSON shape', async () => {
    mockedAxios.mockResolvedValue({ data: { recipient_id: '500', message_id: 'm_1' } });
    await call('facebook_pages_send_message', { recipient_id: '500', text: 'Your order shipped' });
    expect(sent().data).toEqual({ recipient: { id: '500' }, messaging_type: 'RESPONSE', message: { text: 'Your order shipped' } });
    mockedAxios.mockClear();
    await call('facebook_pages_send_message', { recipient_id: '500', text: 'Following up', messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
    expect(sent().data).toEqual({ recipient: { id: '500' }, messaging_type: 'MESSAGE_TAG', message: { text: 'Following up' }, tag: 'HUMAN_AGENT' });
    // The tags retired in April 2026 answer with error 100; only HUMAN_AGENT is offered.
    expect(tool('facebook_pages_send_message').parameters.properties?.tag?.enum).toEqual(['HUMAN_AGENT']);
    mockedAxios.mockClear();
    await call('facebook_pages_send_private_reply', { comment_id: '200_300', text: 'Sent you the details' });
    expect(sent().data).toEqual({ recipient: { comment_id: '200_300' }, message: { text: 'Sent you the details' } });
  });

  it('reads Messenger conversations only, with the 24-hour window explained', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('facebook_pages_list_conversations', {});
    expect(sent().params).toEqual(expect.objectContaining({ platform: 'messenger', fields: 'id,updated_time,participants' }));
    expect(a.instructions).toMatch(/24 hours/);
    expect(tool('facebook_pages_send_message').description).toMatch(/24 hours/);
  });

  it('builds insights queries from the documented parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('facebook_pages_get_page_insights', { metric: 'page_media_view', breakdown: 'is_from_ads', since: '2026-09-01', until: '2026-09-30' });
    expect(sent().params).toEqual({ metric: 'page_media_view', period: 'day', breakdown: 'is_from_ads', since: '2026-09-01', until: '2026-09-30' });
    mockedAxios.mockClear();
    await call('facebook_pages_get_post_insights', { post_id: POST });
    expect(sent().params).toEqual({ metric: 'post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total' });
  });

  it('encodes path values, so a stray slash cannot reach another endpoint', async () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path.replace(/\{\{[A-Z_]+\}\}/g, '')))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('facebook_pages_get_post', { post_id: '1/../me/accounts' });
    expect(sent().url).toBe(`${BASE}/1%2F..%2Fme%2Faccounts`);
  });
});

const LIVE_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const LIVE_PAGE = process.env.FACEBOOK_PAGE_ID;
const live = LIVE_TOKEN && LIVE_PAGE ? describe : describe.skip;

live('facebook-pages adapter: live Graph API', () => {
  const write = process.env.FACEBOOK_PAGES_LIVE_WRITE === '1';
  const env = { FACEBOOK_PAGE_ACCESS_TOKEN: LIVE_TOKEN as string, FACEBOOK_PAGE_ID: LIVE_PAGE as string };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  // A refusal (missing permission, too few likes for insights) is still a Graph answer.
  const graphAnswer = (p: Promise<any>) =>
    p.then((r) => expect(r).toBeDefined()).catch((e: { response?: { data?: { error?: { code?: number } } } }) => expect(e.response?.data?.error?.code).toBeDefined());

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the Page, its posts, feed, scheduled posts and comments', async () => {
    const page = await run('facebook_pages_get_page');
    expect(page.id).toBe(LIVE_PAGE);
    const posts = await run('facebook_pages_list_posts', { limit: 5 });
    expect(Array.isArray(posts.data)).toBe(true);
    expect(Array.isArray((await run('facebook_pages_list_feed', { limit: 5 })).data)).toBe(true);
    expect(Array.isArray((await run('facebook_pages_list_scheduled_posts', { limit: 5 })).data)).toBe(true);
    if (posts.data.length) {
      const id = posts.data[0].id;
      expect((await run('facebook_pages_get_post', { post_id: id })).id).toBe(id);
      const comments = await run('facebook_pages_list_comments', { object_id: id, summary: true, filter: 'stream' });
      expect(Array.isArray(comments.data)).toBe(true);
    }
  }, 120_000);

  it('reads Page and post insights with the current metric names', async () => {
    await graphAnswer(run('facebook_pages_get_page_insights', { date_preset: 'last_7d' }));
    await graphAnswer(run('facebook_pages_get_page_insights', { metric: 'page_follows' }));
    const posts = await run('facebook_pages_list_posts', { limit: 1 });
    if (posts.data.length) await graphAnswer(run('facebook_pages_get_post_insights', { post_id: posts.data[0].id }));
  }, 120_000);

  it('reads Messenger conversations when the token has pages_messaging', async () => {
    await graphAnswer(
      run('facebook_pages_list_conversations', { limit: 5 }).then(async (list) => {
        expect(Array.isArray(list.data)).toBe(true);
        if (list.data.length) {
          const messages = await run('facebook_pages_list_messages', { conversation_id: list.data[0].id, limit: 5 });
          expect(Array.isArray(messages.data)).toBe(true);
        }
        return list;
      }),
    );
  }, 120_000);

  (write ? it : it.skip)('schedules a post two days ahead, edits it and deletes it before it goes live', async () => {
    const when = Math.floor(Date.now() / 1000) + 2 * 86400;
    const created = await run('facebook_pages_schedule_post', {
      message: `AnythingMCP live spec ${new Date().toISOString()}`,
      scheduled_publish_time: String(when),
    });
    const id = created.id as string;
    try {
      const scheduled = await run('facebook_pages_list_scheduled_posts', { limit: 100 });
      expect(scheduled.data.map((p: { id: string }) => p.id)).toContain(id);
      expect((await run('facebook_pages_update_post', { post_id: id, message: 'AnythingMCP live spec (edited)' })).success).toBe(true);
      expect((await run('facebook_pages_get_post', { post_id: id, fields: 'message' })).message).toBe('AnythingMCP live spec (edited)');
    } finally {
      const deleted = await mockedAxios.__actual({ method: 'DELETE', url: `${BASE}/${id}`, headers: { Authorization: `Bearer ${LIVE_TOKEN}` } });
      expect(deleted.data.success).toBe(true);
    }
  }, 120_000);
});
