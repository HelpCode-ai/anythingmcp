import axios from 'axios';
import * as adapter from './onesignal.json';
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
 * Two layers of verification for the OneSignal adapter:
 *
 *   1. Static: always runs. Pins `Authorization: Key <App API key>`, the App
 *      ID variable in every path, query or body that needs it, every tool's
 *      method, URL, query and body through the real RestEngine, checked against
 *      OneSignal's OpenAPI document (documentation.onesignal.com/openapi.json,
 *      read 14 Oct 2026). Also which tools only read, that every send asks for
 *      confirmation, that the delete ships off and that the app answer never
 *      carries push credentials.
 *
 *   2. Live: skipped unless RUN_ONESIGNAL_LIVE=1. Without credentials it checks
 *      that OneSignal refuses a wrong key with 401. With ONESIGNAL_APP_ID and
 *      ONESIGNAL_APP_API_KEY it reads the app, messages, segments, templates
 *      and outcomes, shaped by each tool's response mapping as production does.
 *      Nothing is written unless RUN_ONESIGNAL_LIVE_WRITES=1 and
 *      ONESIGNAL_TEST_EXTERNAL_ID are set too: then one tag is set on that test
 *      user. No message is ever sent by this spec.
 *
 *        RUN_ONESIGNAL_LIVE=1 ONESIGNAL_APP_ID=... ONESIGNAL_APP_API_KEY=os_v2_app_... \
 *          npx jest src/adapters/intl/onesignal.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
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
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://api.onesignal.com';
const APP = '2c1f7a8e-5b3d-4e6f-9a0b-1c2d3e4f5a6b';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'os_v2_app_' + 'a'.repeat(40);
const ENV: Record<string, string> = { ONESIGNAL_APP_ID: APP, ONESIGNAL_APP_API_KEY: FAKE_KEY };

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
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const SENDS = ['onesignal_send_email', 'onesignal_send_push', 'onesignal_send_sms'];
const WRITES = [
  'onesignal_cancel_message',
  'onesignal_create_segment',
  'onesignal_delete_user',
  ...SENDS,
  'onesignal_update_user',
].sort();

describe('onesignal adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the App API key as "Authorization: Key ..." and keeps the App ID a setting', () => {
    expect(a.category).toBe('marketing-automation');
    expect(a.icon).toBe('onesignal');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Key {{ONESIGNAL_APP_API_KEY}}' });
    // Every OneSignal route needs the App ID, and a healthcheckPath is sent
    // without variables, so the install check is the probe instead.
    expect(a.connector.healthcheckPath).toBeUndefined();
    expect(a.probe).toEqual({ tool: 'onesignal_view_app' });
    expect(a.requiredEnvVars).toEqual(['ONESIGNAL_APP_ID', 'ONESIGNAL_APP_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.ONESIGNAL_APP_ID).toMatchObject({ kind: 'setting', secret: false, required: true });
    expect(meta.ONESIGNAL_APP_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a UUID App ID and a bare key, and refuses a key pasted with its prefix', () => {
    const id = new RegExp(a.envVarMeta.ONESIGNAL_APP_ID.pattern!);
    expect(id.test(APP)).toBe(true);
    for (const bad of ['', 'my-app', `${APP}x`, ' ' + APP]) expect(id.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.ONESIGNAL_APP_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Key ${FAKE_KEY}`, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('explains wrong App IDs and keys', () => {
    for (const status of ['400', '401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['400']).toMatch(/App ID/);
  });

  it('prefixes every tool with onesignal_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^onesignal_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the POST history export read-only, confirms every write and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('onesignal_export_message_history'))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of SENDS) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/real messages to real people/);
      expect(tool(name).description).toMatch(/only after the user confirms/);
      expect(tool(name).description).toContain('"yes, send"');
    }
    for (const name of ['onesignal_cancel_message', 'onesignal_create_segment', 'onesignal_update_user']) {
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('onesignal_cancel_message'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['onesignal_delete_user']);
    expect(annotationsOf(tool('onesignal_delete_user'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bonesignal_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bonesignal_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // OneSignal's own identifier field, not a tool name.
      .filter((n) => n !== 'onesignal_id');
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Keys & IDs');
    expect(a.instructions).toContain('os_v2_app_');
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
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
    ['onesignal_view_app', {}, 'GET', `/apps/${APP}`],
    ['onesignal_list_messages', {}, 'GET', '/notifications'],
    ['onesignal_view_message', { message_id: 'm1' }, 'GET', '/notifications/m1'],
    ['onesignal_view_outcomes', {}, 'GET', `/apps/${APP}/outcomes`],
    ['onesignal_export_message_history', { message_id: 'm1' }, 'POST', '/notifications/m1/history'],
    ['onesignal_list_segments', {}, 'GET', `/apps/${APP}/segments`],
    ['onesignal_view_user', { alias_id: 'u1' }, 'GET', `/apps/${APP}/users/by/external_id/u1`],
    ['onesignal_list_templates', {}, 'GET', '/templates'],
    ['onesignal_view_template', { template_id: 't1' }, 'GET', '/templates/t1'],
    ['onesignal_send_push', { contents: { en: 'Hi' }, included_segments: ['Subscribed Users'] }, 'POST', '/notifications'],
    ['onesignal_send_email', { email_subject: 'Hi', email_body: '<p>Hi</p>', include_aliases: { external_id: ['u1'] }, target_channel: 'email' }, 'POST', '/notifications'],
    ['onesignal_send_sms', { contents: { en: 'Hi' }, include_phone_numbers: ['+4915112345678'] }, 'POST', '/notifications'],
    ['onesignal_cancel_message', { message_id: 'm1' }, 'DELETE', '/notifications/m1'],
    ['onesignal_create_segment', { name: 'Pro', filters: [{ field: 'tag', key: 'plan', relation: '=', value: 'pro' }] }, 'POST', `/apps/${APP}/segments`],
    ['onesignal_update_user', { alias_id: 'u1', tags: { plan: 'pro' } }, 'PATCH', `/apps/${APP}/users/by/external_id/u1`],
    ['onesignal_delete_user', { alias_label: 'onesignal_id', alias_id: 'o1' }, 'DELETE', `/apps/${APP}/users/by/onesignal_id/o1`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Key ${FAKE_KEY}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('puts the App ID in the query or body where the API expects it', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('onesignal_list_messages', { kind: 1, time_offset: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ app_id: APP, limit: 20, kind: 1, time_offset: '2026-10-01T00:00:00Z' });
    mockedAxios.mockClear();
    await call('onesignal_view_message', { message_id: 'm1', outcome_names: 'os__click.count', outcome_time_range: '1d' });
    expect(sent().params).toEqual({ app_id: APP, outcome_names: 'os__click.count', outcome_time_range: '1d' });
    mockedAxios.mockClear();
    await call('onesignal_cancel_message', { message_id: 'm1' });
    expect(sent().params).toEqual({ app_id: APP });
    mockedAxios.mockClear();
    await call('onesignal_export_message_history', { message_id: 'm1', events: 'clicked' });
    expect(sent().data).toEqual({ app_id: APP, events: 'clicked' });
    mockedAxios.mockClear();
    await call('onesignal_view_outcomes', {});
    expect(sent().params).toEqual({ outcome_names: 'os__click.count,os__confirmed_delivery.count,os__session_duration.count' });
  });

  it('builds the three send bodies with the app id and only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('onesignal_send_push', {
      contents: { en: 'Order shipped' },
      headings: { en: 'Update' },
      include_aliases: { external_id: ['u1'] },
      target_channel: 'push',
      idempotency_key: 'k1',
    });
    expect(sent().data).toEqual({
      app_id: APP,
      contents: { en: 'Order shipped' },
      headings: { en: 'Update' },
      include_aliases: { external_id: ['u1'] },
      target_channel: 'push',
      idempotency_key: 'k1',
    });
    mockedAxios.mockClear();
    await call('onesignal_send_email', { email_subject: 'Hi', template_id: 't1', included_segments: ['Subscribed Users'], send_after: '2026-10-20T09:00:00Z' });
    expect(sent().data).toEqual({ app_id: APP, email_subject: 'Hi', template_id: 't1', included_segments: ['Subscribed Users'], send_after: '2026-10-20T09:00:00Z' });
    mockedAxios.mockClear();
    await call('onesignal_send_sms', { contents: { en: 'Code 1' }, include_aliases: { external_id: ['u1'] } });
    expect(sent().data).toEqual({ app_id: APP, contents: { en: 'Code 1' }, include_aliases: { external_id: ['u1'] }, target_channel: 'sms' });
  });

  it('builds segment and user update bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const filters = [{ field: 'tag', key: 'plan', relation: '=', value: 'pro' }, { operator: 'OR' }, { field: 'country', relation: '=', value: 'DE' }];
    await call('onesignal_create_segment', { name: 'Pro or DE', filters });
    expect(sent().data).toEqual({ name: 'Pro or DE', filters });
    mockedAxios.mockClear();
    await call('onesignal_update_user', { alias_id: 'u 1/x', tags: { plan: 'pro' }, language: 'de' });
    expect(sent().url).toBe(`${HOST}/apps/${APP}/users/by/external_id/u%201%2Fx`);
    expect(sent().data).toEqual({ properties: { tags: { plan: 'pro' }, language: 'de' } });
  });

  it('never returns push credentials from the app and keeps message lists compact', () => {
    const app = {
      id: APP,
      name: 'Shop',
      players: 10,
      messageable_players: 8,
      gcm_key: 'legacy-secret',
      fcm_v1_service_account_json: '{"private_key":"x"}',
      apns_p8: 'secret',
      apns_key_id: 'K',
      safari_apns_p12_password: 'pw',
    };
    const out = applyResponseTransform(app, tool('onesignal_view_app').responseMapping as any).value as any;
    expect(out).toEqual({ id: APP, name: 'Shop', players: 10, messageable_players: 8 });
    const list = {
      total_count: 1,
      offset: 0,
      limit: 20,
      notifications: [{ id: 'm1', name: 'Promo', contents: { en: 'Hi' }, successful: 5, failed: 0, big_picture: 'https://x', ios_attachments: { a: 'b' } }],
    };
    expect(applyResponseTransform(list, tool('onesignal_list_messages').responseMapping as any).value).toEqual({
      total_count: 1,
      offset: 0,
      limit: 20,
      notifications: [{ id: 'm1', name: 'Promo', contents: { en: 'Hi' }, successful: 5, failed: 0 }],
    });
  });

  it('keeps the deleted user identity, the only field the delete answers with', () => {
    // DELETE /users/by/... answers 202 with { identity: { onesignal_id } }, no success flag.
    const out = applyResponseTransform({ identity: { onesignal_id: 'o1' } }, tool('onesignal_delete_user').responseMapping as any).value;
    expect(out).toEqual({ identity: { onesignal_id: 'o1' } });
  });
});

const live = process.env.RUN_ONESIGNAL_LIVE === '1' ? describe : describe.skip;
live('onesignal adapter: live', () => {
  const real = !!(process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_APP_API_KEY);
  const env = () => ({ ONESIGNAL_APP_ID: process.env.ONESIGNAL_APP_ID!, ONESIGNAL_APP_API_KEY: process.env.ONESIGNAL_APP_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['onesignal_view_app', {}],
    ['onesignal_list_messages', {}],
    ['onesignal_list_segments', {}],
  ])('%s reaches OneSignal and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the app, messages, segments, templates and outcomes', async () => {
    const app = await shaped('onesignal_view_app', {}, env());
    expect(app.id).toBe(process.env.ONESIGNAL_APP_ID);
    expect(Object.keys(app).some((k) => /key|p8|p12|json/.test(k))).toBe(false);
    const messages = await shaped('onesignal_list_messages', { limit: 5 }, env());
    expect(Array.isArray(messages.notifications)).toBe(true);
    const segments = await shaped('onesignal_list_segments', {}, env());
    expect(Array.isArray(segments.segments)).toBe(true);
    const templates = await shaped('onesignal_list_templates', {}, env());
    expect(Array.isArray(templates.templates)).toBe(true);
    const outcomes = await shaped('onesignal_view_outcomes', { outcome_time_range: '1d' }, env());
    expect(Array.isArray(outcomes.outcomes)).toBe(true);
  }, 60000);

  const writes = real && process.env.RUN_ONESIGNAL_LIVE_WRITES === '1' && !!process.env.ONESIGNAL_TEST_EXTERNAL_ID;
  (writes ? it : it.skip)('sets one tag on the test user (no message is sent)', async () => {
    const out = await shaped('onesignal_update_user', { alias_id: process.env.ONESIGNAL_TEST_EXTERNAL_ID, tags: { amcp_live_check: String(Date.now()) } }, env());
    expect(out.properties).toBeDefined();
  }, 30000);
});
