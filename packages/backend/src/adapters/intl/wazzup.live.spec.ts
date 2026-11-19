import axios from 'axios';
import * as adapter from './wazzup.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Wazzup public API v3 adapter (https://api.wazzup24.com/v3, Bearer API key).
 *
 * Static checks always run: the bearer key, every tool's method and path
 * against Wazzup's API pages (channels, message, users, contacts, deals,
 * pipelines, unanswered, iframe, webhooks, WhatsApp templates), the message,
 * list-upload, iframe and webhook bodies, and which tools install switched
 * off. Sending stays on; deletes and the webhook address change are off.
 * https://wazzup24.ru/help/api-ru/
 *
 * Live checks run only with RUN_WAZZUP_LIVE=1. Without a key they confirm
 * the API refuses a wrong one; with WAZZUP_API_KEY they read the channel
 * list. Nothing is sent or written.
 *
 *   RUN_WAZZUP_LIVE=1 WAZZUP_API_KEY=... npx jest src/adapters/intl/wazzup.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = { WAZZUP_API_KEY: '33a817cbc1504bd5885574d8f0290cd3' };
const BASE = 'https://api.wazzup24.com/v3';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// name, method, path, required parameters: as Wazzup documents API v3.
const CONTRACT: Array<[string, string, string, string[]]> = [
  ['wazzup_list_channels', 'GET', '/channels', []],
  ['wazzup_send_message', 'POST', '/message', ['channel_id', 'chat_type']],
  ['wazzup_edit_message', 'PATCH', '/message/{message_id}', ['message_id']],
  ['wazzup_delete_message', 'DELETE', '/message/{message_id}', ['message_id']],
  ['wazzup_list_whatsapp_templates', 'GET', '/templates/whatsapp', []],
  ['wazzup_list_users', 'GET', '/users', []],
  ['wazzup_get_user', 'GET', '/users/{user_id}', ['user_id']],
  ['wazzup_upsert_users', 'POST', '/users', ['users']],
  ['wazzup_delete_user', 'DELETE', '/users/{user_id}', ['user_id']],
  ['wazzup_list_contacts', 'GET', '/contacts', []],
  ['wazzup_get_contact', 'GET', '/contacts/{contact_id}', ['contact_id']],
  ['wazzup_upsert_contacts', 'POST', '/contacts', ['contacts']],
  ['wazzup_delete_contact', 'DELETE', '/contacts/{contact_id}', ['contact_id']],
  ['wazzup_list_deals', 'GET', '/deals', []],
  ['wazzup_get_deal', 'GET', '/deals/{deal_id}', ['deal_id']],
  ['wazzup_upsert_deals', 'POST', '/deals', ['deals']],
  ['wazzup_delete_deal', 'DELETE', '/deals/{deal_id}', ['deal_id']],
  ['wazzup_list_pipelines', 'GET', '/pipelines', []],
  ['wazzup_upsert_pipelines', 'POST', '/pipelines', ['pipelines']],
  ['wazzup_get_unanswered_count', 'GET', '/unanswered/{user_id}', ['user_id']],
  ['wazzup_create_chat_window_link', 'POST', '/iframe', ['user_id', 'scope']],
  ['wazzup_get_webhooks', 'GET', '/webhooks', []],
  ['wazzup_set_webhooks', 'PATCH', '/webhooks', ['webhooks_uri']],
];

describe('wazzup adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key as a bearer token to api.wazzup24.com/v3', () => {
    expect(a.slug).toBe('wazzup');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('wazzup');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WAZZUP_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['WAZZUP_API_KEY']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.envVarMeta.WAZZUP_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const key = new RegExp(a.envVarMeta.WAZZUP_API_KEY.pattern!);
    expect(key.test(ENV.WAZZUP_API_KEY)).toBe(true);
    for (const bad of ['', 'Bearer 33a817cbc1504bd5885574d8f0290cd3', 'has space 33a817cbc1504bd5']) expect(key.test(bad)).toBe(false);
  });

  it('says it is a paid gateway and probes the channel list', () => {
    expect(a.description).toMatch(/paid gateway/);
    expect(a.instructions).toMatch(/paid gateway/);
    expect(a.prerequisites).toMatch(/paid subscription/);
    expect(a.probe).toEqual({ tool: 'wazzup_list_channels', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(CONTRACT.map(([name]) => name));
    for (const [name, method, path, required] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(path);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^wazzup_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('keeps sending on, installs deletes and the webhook change switched off, and has no bulk delete', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(entry.endpointMapping.method === 'GET');
      expect(entry.endpointMapping.path).not.toContain('bulk_delete');
      if (entry.endpointMapping.method === 'DELETE') expect(entry.enabled).toBe(false);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([
      'wazzup_delete_contact',
      'wazzup_delete_deal',
      'wazzup_delete_message',
      'wazzup_delete_user',
      'wazzup_set_webhooks',
    ]);
    expect(tool('wazzup_send_message').enabled).toBeUndefined();
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists channels with the bearer key', async () => {
    ok();
    await call('wazzup_list_channels', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/channels`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.WAZZUP_API_KEY}`);
  });

  it('builds the message body with Wazzup field names', async () => {
    ok(201);
    await call('wazzup_send_message', {
      channel_id: 'e0629e11-0f67-4567-92a9-2237e91ec1b9',
      chat_type: 'whatsapp',
      chat_id: '79011112233',
      text: 'Hello',
      crm_message_id: 'crm-1',
      clear_unanswered: false,
    });
    expect(sent().url).toBe(`${BASE}/message`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      channelId: 'e0629e11-0f67-4567-92a9-2237e91ec1b9',
      chatType: 'whatsapp',
      chatId: '79011112233',
      text: 'Hello',
      crmMessageId: 'crm-1',
      clearUnanswered: false,
    });

    ok(201);
    await call('wazzup_send_message', {
      channel_id: '24197d5f-06de-421f-8576-9f6e6cb67f28',
      chat_type: 'whatsapp',
      chat_id: '79994621848',
      template_id: '6201005a-9a6f-486f-bdd5-e6cb86c76ddb',
      template_values: ['value'],
      buttons_object: { buttons: [{ payload: 'p1' }] },
    });
    expect(sent().data).toEqual({
      channelId: '24197d5f-06de-421f-8576-9f6e6cb67f28',
      chatType: 'whatsapp',
      chatId: '79994621848',
      templateId: '6201005a-9a6f-486f-bdd5-e6cb86c76ddb',
      templateValues: ['value'],
      buttonsObject: { buttons: [{ payload: 'p1' }] },
    });

    ok();
    await call('wazzup_edit_message', { message_id: '6f1b3c67-3008-488b-9abc-12fcac6de134', text: 'New text' });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().url).toBe(`${BASE}/message/6f1b3c67-3008-488b-9abc-12fcac6de134`);
    expect(sent().data).toEqual({ text: 'New text' });
  });

  it('uploads users, contacts, deals and pipelines as a top-level JSON list', async () => {
    const users = [{ id: 'u1', name: 'Alex Salesman', phone: '79263334567' }];
    ok();
    await call('wazzup_upsert_users', { users });
    expect(sent().url).toBe(`${BASE}/users`);
    expect(sent().data).toEqual(users);

    const contacts = [
      { id: '1', responsibleUserId: 'u1', name: 'Customer', contactData: [{ chatType: 'whatsapp', chatId: '79991114433' }] },
    ];
    ok();
    await call('wazzup_upsert_contacts', { contacts });
    expect(sent().url).toBe(`${BASE}/contacts`);
    expect(Array.isArray(sent().data)).toBe(true);
    expect(sent().data).toEqual(contacts);

    const deals = [{ id: 'd1', responsibleUserId: 'u1', name: 'Deal', uri: 'https://crm.example.test/d1', contacts: ['1'], closed: false }];
    ok();
    await call('wazzup_upsert_deals', { deals });
    expect(sent().url).toBe(`${BASE}/deals`);
    expect(sent().data).toEqual(deals);

    const pipelines = [{ id: 'p1', name: 'Sales', stages: [{ id: '1', name: 'New' }] }];
    ok();
    await call('wazzup_upsert_pipelines', { pipelines });
    expect(sent().url).toBe(`${BASE}/pipelines`);
    expect(sent().data).toEqual(pipelines);
  });

  it('reads lists, single records and the unanswered counter on the documented paths', async () => {
    ok();
    await call('wazzup_list_contacts', { offset: 100 });
    expect(sent().url).toBe(`${BASE}/contacts`);
    expect(sent().params).toEqual({ offset: 100 });

    ok();
    await call('wazzup_get_deal', { deal_id: '101' });
    expect(sent().url).toBe(`${BASE}/deals/101`);

    ok();
    await call('wazzup_get_unanswered_count', { user_id: 'user1' });
    expect(sent().url).toBe(`${BASE}/unanswered/user1`);

    ok();
    await call('wazzup_list_whatsapp_templates', {});
    expect(sent().url).toBe(`${BASE}/templates/whatsapp`);
    expect(sent().params).toEqual({ limit: 100, offset: 0 });
  });

  it('builds the chat window and webhook bodies', async () => {
    ok();
    await call('wazzup_create_chat_window_link', {
      user_id: '222555',
      user_name: 'User Name',
      scope: 'card',
      filter: [{ chatType: 'whatsapp', chatId: '79998887766' }],
      active_chat: { chatType: 'whatsapp', chatId: '79998887766' },
    });
    expect(sent().url).toBe(`${BASE}/iframe`);
    expect(sent().data).toEqual({
      user: { id: '222555', name: 'User Name' },
      scope: 'card',
      filter: [{ chatType: 'whatsapp', chatId: '79998887766' }],
      activeChat: { chatType: 'whatsapp', chatId: '79998887766' },
    });

    ok();
    await call('wazzup_set_webhooks', {
      webhooks_uri: 'https://hooks.example.test/wazzup',
      messages_and_statuses: true,
      contacts_and_deals_creation: false,
    });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().url).toBe(`${BASE}/webhooks`);
    expect(sent().data).toEqual({
      webhooksUri: 'https://hooks.example.test/wazzup',
      subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: false },
    });

    ok();
    await call('wazzup_delete_contact', { contact_id: 'c-1' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/contacts/c-1`);
    expect(sent().data).toBeUndefined();
  });
});

// Opt-in: RUN_WAZZUP_LIVE=1. The refusal check needs no account; the read
// needs WAZZUP_API_KEY. Nothing is sent or written.
const live = process.env.RUN_WAZZUP_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('wazzup: live', () => {
  it('refuses a wrong API key with INVALID_APIKEY', async () => {
    const response = await liveFetch.get(`${BASE}/channels`, {
      headers: { Authorization: 'Bearer 00000000000000000000000000000000', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data.error).toBe('INVALID_APIKEY');
  });

  it('reads the channel list', async () => {
    const key = process.env.WAZZUP_API_KEY;
    if (!key) throw new Error('Set WAZZUP_API_KEY for the live check');
    const response = await liveFetch.get(`${BASE}/channels`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data)).toBe(true);
  });
});
