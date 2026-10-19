import axios from 'axios';
import * as adapter from './manychat.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Manychat adapter (Public API):
 *
 *   1. Static: always runs. Pins Bearer auth on api.manychat.com, every
 *      tool's method, path, query and JSON body through the real RestEngine
 *      against Manychat's published OpenAPI document (api.manychat.com/swagger,
 *      Page API), the v2 content body of the text send, the errorWhen rules
 *      for {"status": "error"} answers, and which tools write or install off.
 *
 *   2. Live: skipped unless RUN_MANYCHAT_LIVE=1 and MANYCHAT_API_KEY are set.
 *      Reads only (page info, tags, fields, flows, growth tools); it never
 *      tags, updates or messages a contact.
 *
 *        RUN_MANYCHAT_LIVE=1 MANYCHAT_API_KEY=... npx jest src/adapters/intl/manychat.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  aliases: string[];
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; example?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
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

// Built at run time so no literal here looks like a real key.
const KEY = ['1234567', ['0a1b2c3d', '4e5f6a7b', '8c9d0e1f', '2a3b4c5d'].join('')].join(':');
const BASE = 'https://api.manychat.com';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, key: string, params: Record<string, unknown>) => {
  const env = { MANYCHAT_API_KEY: key };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { token: key }, headers: config.headers, errorWhen: a.connector.config.errorWhen as never },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, KEY, params);
const sent = () => mockedAxios.mock.calls[0][0];
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, a.connector.config.errorWhen as never);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};

const WRITES = [
  'manychat_tag_contact',
  'manychat_create_custom_field',
  'manychat_create_contact',
  'manychat_create_tag',
  'manychat_delete_tag',
  'manychat_untag_contact',
  'manychat_send_content',
  'manychat_send_flow',
  'manychat_send_text_message',
  'manychat_set_bot_fields',
  'manychat_set_contact_fields',
  'manychat_update_contact',
];
const SENDS = ['manychat_send_content', 'manychat_send_flow', 'manychat_send_text_message'];

describe('manychat adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the official Page API OpenAPI document on 19 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('manychat');
    expect(a.icon).toBe('manychat');
    expect(a.category).toBe('marketing-automation');
  });

  it('sends the key as Bearer to api.manychat.com and probes with the page info', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MANYCHAT_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/fb/page/getInfo');
    expect(a.probe.tool).toBe('manychat_get_account');
    mockedAxios.mockResolvedValue({ data: { status: 'success', data: {} } });
    await call('manychat_get_account', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(sent().url).toBe(`${BASE}/fb/page/getInfo`);
  });

  it('asks for the key as a secret in the page-id:hash form', () => {
    expect(a.requiredEnvVars).toEqual(['MANYCHAT_API_KEY']);
    const meta = a.envVarMeta.MANYCHAT_API_KEY;
    expect(meta.secret).toBe(true);
    expect(meta.kind).toBe('credential');
    const re = new RegExp(meta.pattern!);
    expect(re.test(KEY)).toBe(true);
    expect(re.test(meta.example!)).toBe(true);
    for (const bad of ['', '0a1b2c3d4e5f', `Bearer ${KEY}`, `${KEY} `, 'abc:def']) expect(re.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'MANYCHAT_API_KEY')!.secret).toBe(true);
  });

  it('says that the API needs the Pro plan', () => {
    expect(a.instructions).toMatch(/Manychat Pro\*\* plan/);
    expect(a.prerequisites).toMatch(/Pro plan/);
    expect(a.envVarMeta.MANYCHAT_API_KEY).toMatchObject({ help: expect.stringContaining('Pro plan') });
  });

  it('turns {"status": "error"} answers into failed calls', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen as never)).toEqual([]);
    expect(statusOf({ status: 'success', data: [] })).toBeNull();
    expect(statusOf({ status: 'error', message: 'Wrong token' })).toBe(401);
    expect(statusOf({ status: 'error', message: 'Wrong format token' })).toBe(401);
    expect(statusOf({ status: 'error', message: 'Validation error', details: { messages: [{ message: 'tag_name is required' }] } })).toBe(400);
    expect(statusOf({ status: 'error', message: 'Content can not be sent', code: 3011 })).toBe(400);
    expect(statusOf({ status: 'exception', message: 'Something went wrong' })).toBe(502);
  });

  it('prefixes every tool with manychat_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^manychat_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks for confirmation on every write and installs only the tag deletion switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    for (const name of SENDS) expect(tool(name).description).toMatch(/real message/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['manychat_delete_tag']);
    expect(annotationsOf(tool('manychat_delete_tag')).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmanychat_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmanychat_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Manychat\n')).toBe(true);
    for (const text of ['Settings > API', '24 hours', 'template', 'Rate limits', 'switched off']) expect(a.instructions).toContain(text);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, path] from the Page API OpenAPI document.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['manychat_get_account', {}, 'GET', '/fb/page/getInfo'],
    ['manychat_list_tags', {}, 'GET', '/fb/page/getTags'],
    ['manychat_list_custom_fields', {}, 'GET', '/fb/page/getCustomFields'],
    ['manychat_list_bot_fields', {}, 'GET', '/fb/page/getBotFields'],
    ['manychat_list_flows', {}, 'GET', '/fb/page/getFlows'],
    ['manychat_list_growth_tools', {}, 'GET', '/fb/page/getGrowthTools'],
    ['manychat_get_contact', { subscriber_id: 1234567890 }, 'GET', '/fb/subscriber/getInfo'],
    ['manychat_find_contacts_by_name', { name: 'Jane Doe' }, 'GET', '/fb/subscriber/findByName'],
    ['manychat_find_contacts_by_custom_field', { field_id: 42, field_value: 'Lyon' }, 'GET', '/fb/subscriber/findByCustomField'],
    ['manychat_find_contact_by_email_or_phone', { email: 'jane@example.com' }, 'GET', '/fb/subscriber/findBySystemField'],
    ['manychat_tag_contact', { subscriber_id: 1234567890, tag_name: 'vip' }, 'POST', '/fb/subscriber/addTagByName'],
    ['manychat_untag_contact', { subscriber_id: 1234567890, tag_name: 'vip' }, 'POST', '/fb/subscriber/removeTagByName'],
    ['manychat_set_contact_fields', { subscriber_id: 1234567890, fields: [{ field_name: 'City', field_value: 'Lyon' }] }, 'POST', '/fb/subscriber/setCustomFields'],
    ['manychat_create_contact', { whatsapp_phone: '+15405550100' }, 'POST', '/fb/subscriber/createSubscriber'],
    ['manychat_update_contact', { subscriber_id: 1234567890, first_name: 'Jane' }, 'POST', '/fb/subscriber/updateSubscriber'],
    ['manychat_create_tag', { name: 'vip' }, 'POST', '/fb/page/createTag'],
    ['manychat_delete_tag', { tag_name: 'vip' }, 'POST', '/fb/page/removeTagByName'],
    ['manychat_create_custom_field', { caption: 'City', type: 'text' }, 'POST', '/fb/page/createCustomField'],
    ['manychat_set_bot_fields', { fields: [{ field_name: 'promo_code', field_value: 'FALL10' }] }, 'POST', '/fb/page/setBotFields'],
    ['manychat_send_flow', { subscriber_id: 1234567890, flow_ns: 'content20240101000000_123456' }, 'POST', '/fb/sending/sendFlow'],
    ['manychat_send_text_message', { subscriber_id: 1234567890, text: 'Hi' }, 'POST', '/fb/sending/sendContent'],
    ['manychat_send_content', { subscriber_id: 1234567890, data: { version: 'v2', content: { messages: [] } } }, 'POST', '/fb/sending/sendContent'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { status: 'success' } });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
    if (method === 'GET') expect(sent().data).toBeUndefined();
  });

  it('sends lookups as query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 'success', data: {} } });
    await call('manychat_find_contact_by_email_or_phone', { phone: '+15405550100' });
    expect(sent().params).toEqual({ phone: '+15405550100' });
    mockedAxios.mockClear();
    await call('manychat_find_contacts_by_custom_field', { field_id: 42, field_value: 'Lyon' });
    expect(sent().params).toEqual({ field_id: 42, field_value: 'Lyon' });
  });

  it('sends writes as the JSON bodies the OpenAPI document defines', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 'success' } });
    await call('manychat_tag_contact', { subscriber_id: 1234567890, tag_name: 'vip' });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, tag_name: 'vip' });
    mockedAxios.mockClear();
    const fields = [{ field_id: 7, field_value: 3 }, { field_name: 'City', field_value: 'Lyon' }];
    await call('manychat_set_contact_fields', { subscriber_id: 1234567890, fields });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, fields });
    mockedAxios.mockClear();
    await call('manychat_create_custom_field', { caption: 'City', type: 'text' });
    expect(sent().data).toEqual({ caption: 'City', type: 'text' });
    mockedAxios.mockClear();
    await call('manychat_create_contact', { email: 'jane@example.com', has_opt_in_email: true, first_name: 'Jane' });
    expect(sent().data).toEqual({ email: 'jane@example.com', has_opt_in_email: true, first_name: 'Jane' });
    mockedAxios.mockClear();
    await call('manychat_send_flow', { subscriber_id: 1234567890, flow_ns: 'content20240101000000_123456' });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, flow_ns: 'content20240101000000_123456' });
    expect(tool('manychat_update_contact').parameters.properties).not.toHaveProperty('whatsapp_phone');
  });

  it('builds a v2 text message, with the channel type only when it is not Messenger', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 'success' } });
    await call('manychat_send_text_message', { subscriber_id: 1234567890, text: 'Your order shipped.' });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, data: { version: 'v2', content: { messages: [{ type: 'text', text: 'Your order shipped.' }] } } });
    mockedAxios.mockClear();
    await call('manychat_send_text_message', { subscriber_id: 1234567890, channel: 'whatsapp', text: 'Hi' });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, data: { version: 'v2', content: { type: 'whatsapp', messages: [{ type: 'text', text: 'Hi' }] } } });
  });

  it('passes rich content through unchanged', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 'success' } });
    const data = { version: 'v2', content: { type: 'instagram', messages: [{ type: 'text', text: 'Hi', buttons: [{ type: 'url', caption: 'Open', url: 'https://example.com' }] }] } };
    await call('manychat_send_content', { subscriber_id: 1234567890, data });
    expect(sent().data).toEqual({ subscriber_id: 1234567890, data });
  });

  it('caps batch field updates at 20, as Manychat does', () => {
    expect(tool('manychat_set_contact_fields').parameters.properties!.fields.maxItems).toBe(20);
    expect(tool('manychat_set_bot_fields').parameters.properties!.fields.maxItems).toBe(20);
  });
});

const LIVE_KEY = process.env.MANYCHAT_API_KEY;
const live = process.env.RUN_MANYCHAT_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('manychat adapter: live Page API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, LIVE_KEY as string, params);

  it('reads the page, tags, fields, flows and growth tools', async () => {
    const page = await run('manychat_get_account');
    expect(page.status).toBe('success');
    expect(page.data.id).toBeDefined();
    for (const name of ['manychat_list_tags', 'manychat_list_custom_fields', 'manychat_list_bot_fields', 'manychat_list_growth_tools']) {
      expect(Array.isArray((await run(name)).data)).toBe(true);
    }
    expect(Array.isArray((await run('manychat_list_flows')).data.flows)).toBe(true);
  }, 60_000);

  it('a wrong key is refused', async () => {
    await expect(execute('manychat_get_account', '1:0000000000', {})).rejects.toBeDefined();
  }, 30_000);
});
