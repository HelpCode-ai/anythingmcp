import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as adapter from './wati.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Two layers of verification for the WATI adapter:
 *
 *   1. Static: always runs. Pins the Bearer token, the workspace's API
 *      Endpoint as the base of every tool (API v1 only), every tool's method,
 *      URL, query and body through the real RestEngine, which tools write and
 *      which are switched off (session, interactive and bulk sends), the
 *      errors WATI reports inside HTTP 200, and the response shaping. Checked
 *      on 18 Oct 2026 against the OpenAPI definitions embedded in
 *      docs.wati.io/reference (API V1). API v3 is left out: a real token from
 *      WATI's API Endpoint screen got 403 on every v3 path (tested on Cloud,
 *      18 Oct 2026), while all v1 reads answered 200.
 *
 *   2. Live: skipped unless RUN_WATI_LIVE=1. It checks that the routes exist:
 *      a made-up token gets 401 while a made-up route gets 404. With
 *      WATI_API_ENDPOINT and WATI_ACCESS_TOKEN it also runs the reads on that
 *      workspace. Nothing is ever sent:
 *
 *        RUN_WATI_LIVE=1 WATI_API_ENDPOINT=https://live-mt-server.wati.io/... WATI_ACCESS_TOKEN=... npx jest src/adapters/intl/wati.live.spec.ts
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
  unlisted?: boolean;
  aliases: string[];
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
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

const ENDPOINT = 'https://live-mt-server.wati.io/123456';
// Built at run time so no literal looks like a real credential.
const fakeToken = () => ['amcpTest', Math.random().toString(36).slice(2, 12), Math.random().toString(36).slice(2, 12)].join('.');
const FAKE_TOKEN = fakeToken();
const ENV: Record<string, string> = { WATI_API_ENDPOINT: ENDPOINT, WATI_ACCESS_TOKEN: FAKE_TOKEN };

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
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () =>
  Object.fromEntries(
    Object.entries((sent().params ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NUM = '919876543210';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['wati_list_message_templates', {}, 'GET', `${ENDPOINT}/api/v1/getMessageTemplates`],
  ['wati_list_contacts', {}, 'GET', `${ENDPOINT}/api/v1/getContacts`],
  ['wati_get_messages', { target: NUM }, 'GET', `${ENDPOINT}/api/v1/getMessages/${NUM}`],
  ['wati_add_contact', { whatsapp_number: NUM, name: 'Anna' }, 'POST', `${ENDPOINT}/api/v1/addContact/${NUM}`],
  ['wati_update_contact_attributes', { target: NUM, custom_params: [{ name: 'city', value: 'Pune' }] }, 'POST', `${ENDPOINT}/api/v1/updateContactAttributes/${NUM}`],
  ['wati_assign_operator', { target: NUM, email: 'agent@example.com' }, 'POST', `${ENDPOINT}/api/v1/assignOperator`],
  ['wati_send_template_message', { whatsapp_number: NUM, template_name: 'order_update' }, 'POST', `${ENDPOINT}/api/v1/sendTemplateMessage`],
  ['wati_send_template_broadcast', { template_name: 'promo', broadcast_name: 'October', receivers: [] }, 'POST', `${ENDPOINT}/api/v1/sendTemplateMessages`],
  ['wati_send_session_message', { target: NUM, message_text: 'Hi' }, 'POST', `${ENDPOINT}/api/v1/sendSessionMessage/${NUM}`],
  ['wati_send_interactive_buttons', { whatsapp_number: NUM, body: 'Pick one', buttons: [{ text: 'Yes' }] }, 'POST', `${ENDPOINT}/api/v1/sendInteractiveButtonsMessage`],
];
const OFF = ['wati_send_template_broadcast', 'wati_send_session_message', 'wati_send_interactive_buttons'];
const CONFIRM = ['wati_add_contact', 'wati_update_contact_attributes', 'wati_send_template_message', ...OFF];
const INBOX_WRITES = ['wati_assign_operator'];

describe('wati adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed in messaging with its own logo and search aliases', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('wati');
    for (const alias of a.aliases) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('sends a Bearer token to the API Endpoint and checks it on the template list', () => {
    expect(a.connector.baseUrl).toBe('{{WATI_API_ENDPOINT}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WATI_ACCESS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/api/v1/getMessageTemplates?pageSize=1&pageNumber=1');
    expect(a.probe).toEqual({ tool: 'wati_list_message_templates', params: { page_size: 1 } });
    expect(a.requiredEnvVars).toEqual(['WATI_API_ENDPOINT', 'WATI_ACCESS_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.WATI_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.WATI_API_ENDPOINT).toMatchObject({ kind: 'address', secret: false, required: true });
    for (const key of ['401', '403', '404', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('accepts the API Endpoint as WATI shows it and rejects a token pasted with Bearer', () => {
    const endpoint = new RegExp(a.envVarMeta.WATI_API_ENDPOINT.pattern!);
    for (const good of [ENDPOINT, `${ENDPOINT}/`, 'https://live-server-1234.wati.io/567890']) expect(endpoint.test(good)).toBe(true);
    for (const bad of ['', 'live-mt-server.wati.io/123456', `${ENDPOINT}/api/v1`, 'https://live-mt-server.wati.io', 'https://example.com/123456']) {
      expect(endpoint.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.WATI_ACCESS_TOKEN.pattern!);
    for (const good of [FAKE_TOKEN, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl', 'wati_abcdefghijklmnopqrstuvwxyz0123']) {
      expect(token.test(good)).toBe(true);
    }
    for (const bad of ['', 'short', `Bearer ${FAKE_TOKEN}`, `bearer ${FAKE_TOKEN}`, `Bearer${FAKE_TOKEN}`]) expect(token.test(bad)).toBe(false);
  });

  it('prefixes every tool with wati_ and shares no tool name with another adapter file', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^wati_[a-z_]+$/);
    const root = path.join(__dirname, '..');
    for (const region of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) {
      for (const file of fs.readdirSync(path.join(root, region)).filter((f) => f.endsWith('.json') && f !== 'wati.json')) {
        const other = JSON.parse(fs.readFileSync(path.join(root, region, file), 'utf8'));
        for (const t of other.tools ?? []) expect(`${file}:${mine.has(t.name)}`).toBe(`${file}:false`);
      }
    }
  });

  it('installs session, interactive and bulk sends switched off, keeps one template send on, and marks the reads read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(tool('wati_send_template_message').enabled).toBeUndefined();
    for (const name of CONFIRM) expect(tool(name).description).toMatch(/confirm with the user first/);
    for (const name of OFF) expect(tool(name).description).toMatch(/Installed switched off\./);
    for (const name of [...CONFIRM, ...INBOX_WRITES]) expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    for (const t of a.tools.filter((x) => ![...CONFIRM, ...INBOX_WRITES].includes(x.name))) {
      expect(`${t.name}:${t.endpointMapping.method}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:GET:true`);
      expect(t.description).toMatch(/Read-only\./);
    }
  });

  it('uses only API v1 paths on the API Endpoint and never the v3 API the token cannot open', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.path.startsWith('/api/v1/')}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(adapter)).not.toMatch(/api\/ext\/v3/);
    expect(a.instructions).toMatch(/API v3[^.]*needs a token/);
  });

  it('explains setup, the Bearer prefix, numbers and confirmations, names only real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bwati_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bwati_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String(p.description).matchAll(/\bwati_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Writes need a yes/);
    expect(a.instructions).toMatch(/API Docs/);
    expect(a.instructions).toMatch(/without\*\* the word `Bearer`/);
    expect(a.instructions).toMatch(/24-hour/);
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
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('works with an API Endpoint saved with a trailing slash', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wati_list_contacts', {}, { ...ENV, WATI_API_ENDPOINT: `${ENDPOINT}/` });
    expect(sent().url).toBe(`${ENDPOINT}/api/v1/getContacts`);
  });

  it('builds the send and contact bodies and queries with WATI field names', async () => {
    mockedAxios.mockResolvedValue({ data: { result: true } });
    await call('wati_send_template_message', { whatsapp_number: NUM, template_name: 'order_update', parameters: [{ name: '1', value: 'Anna' }] });
    expect(query()).toEqual({ whatsappNumber: NUM });
    expect(sent().data).toEqual({ template_name: 'order_update', broadcast_name: 'AnythingMCP', parameters: [{ name: '1', value: 'Anna' }] });
    mockedAxios.mockClear();
    await call('wati_send_template_message', { whatsapp_number: NUM, template_name: 'hello', channel_number: '85264318722' });
    expect(sent().data).toEqual({ template_name: 'hello', broadcast_name: 'AnythingMCP', parameters: [], channel_number: '85264318722' });
    mockedAxios.mockClear();
    const receivers = [{ whatsappNumber: NUM, customParams: [{ name: 'name', value: 'Anna' }] }];
    await call('wati_send_template_broadcast', { template_name: 'promo', broadcast_name: 'October', receivers });
    expect(sent().data).toEqual({ template_name: 'promo', broadcast_name: 'October', receivers });
    mockedAxios.mockClear();
    await call('wati_send_session_message', { target: NUM, message_text: 'Your order shipped', reply_context_id: 'wamid.X' });
    expect(query()).toEqual({ messageText: 'Your order shipped', replyContextId: 'wamid.X' });
    mockedAxios.mockClear();
    await call('wati_send_interactive_buttons', { whatsapp_number: NUM, body: 'Pick one', buttons: [{ text: 'Yes' }, { text: 'No' }], footer: 'Shop' });
    expect(query()).toEqual({ whatsappNumber: NUM });
    expect(sent().data).toEqual({ body: 'Pick one', footer: 'Shop', buttons: [{ text: 'Yes' }, { text: 'No' }] });
    mockedAxios.mockClear();
    await call('wati_add_contact', { whatsapp_number: NUM, name: 'Anna', custom_params: [{ name: 'city', value: 'Pune' }] });
    expect(sent().data).toEqual({ name: 'Anna', customParams: [{ name: 'city', value: 'Pune' }] });
    mockedAxios.mockClear();
    await call('wati_update_contact_attributes', { target: NUM, custom_params: [{ name: 'stage', value: 'won' }] });
    expect(sent().data).toEqual({ customParams: [{ name: 'stage', value: 'won' }] });

    mockedAxios.mockClear();
    await call('wati_assign_operator', { target: NUM, email: 'agent@example.com' });
    expect(query()).toEqual({ target: NUM, email: 'agent@example.com' });
  });

  it('maps the list filters and paging to WATI query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wati_list_contacts', { name: 'Anna', attribute: '[{"name":"city","operator":"==","value":"Pune"}]', created_date: '2026-10-01', page_number: 2 });
    expect(query()).toEqual({ name: 'Anna', attribute: '[{"name":"city","operator":"==","value":"Pune"}]', createdDate: '2026-10-01', pageSize: '50', pageNumber: '2' });
    mockedAxios.mockClear();
    await call('wati_list_message_templates', { page_size: 1 });
    expect(query()).toEqual({ pageSize: '1', pageNumber: '1' });
    mockedAxios.mockClear();
    await call('wati_get_messages', { target: NUM, from: '2026-10-01 00:00:00', to: '2026-10-18 00:00:00' });
    expect(query()).toEqual({ pageSize: '50', pageNumber: '1', from: '2026-10-01 00:00:00', to: '2026-10-18 00:00:00' });
  });

  it('turns the failures WATI reports inside HTTP 200 into errors, a chat that does not exist as not found', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    mockedAxios.mockResolvedValue({ data: { result: false, info: 'Template is not approved' } });
    await expect(call('wati_send_template_message', { whatsapp_number: NUM, template_name: 'x' })).rejects.toMatchObject({
      message: expect.stringMatching(/Template is not approved/),
    });
    mockedAxios.mockResolvedValue({ data: { result: false, errors: { error: 'Invalid numbers', invalidWhatsappNumbers: ['1'] } } });
    await expect(call('wati_send_template_broadcast', { template_name: 'x', broadcast_name: 'y', receivers: [] })).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid numbers/),
    });
    mockedAxios.mockResolvedValue({ data: { ok: false, errors: null, message: null, info: 'Session is not open' } });
    await expect(call('wati_send_interactive_buttons', { whatsapp_number: NUM, body: 'x', buttons: [{ text: 'Yes' }] })).rejects.toMatchObject({
      message: expect.stringMatching(/Session is not open/),
      status: 400,
    });
    // What a contact without chats answers (seen on a real workspace, 18 Oct 2026).
    mockedAxios.mockResolvedValue({ data: { result: false, info: "Can't find Conversation" } });
    await expect(call('wati_get_messages', { target: NUM })).rejects.toMatchObject({
      message: expect.stringMatching(/Can't find Conversation/),
      status: 404,
    });
    mockedAxios.mockResolvedValue({ data: { result: 'success', messages: [], link: {} } });
    await expect(call('wati_get_messages', { target: NUM })).resolves.toBeDefined();
  });

  it('shapes templates, contacts and messages to the fields an agent needs', () => {
    const templates = shape('wati_list_message_templates', {
      result: 'success',
      messageTemplates: [
        { id: 't1', elementName: 'order_update', category: 'UTILITY', status: 'APPROVED', language: { key: 'en', value: 'en', text: 'English' }, body: 'Hi {{1}}', hsm: 'Hi {{1}}', bodyOriginal: 'x', customParams: [{ paramName: '1', paramValue: 'Anna' }] },
      ],
      link: { pageNumber: 1, pageSize: 1, total: 4 },
    });
    expect(templates).toEqual({
      templates: [{ id: 't1', name: 'order_update', category: 'UTILITY', status: 'APPROVED', language: 'en', body: 'Hi {{1}}', customParams: [{ paramName: '1', paramValue: 'Anna' }] }],
      link: { pageNumber: 1, pageSize: 1, total: 4 },
    });
    const contacts = shape('wati_list_contacts', {
      result: 'success',
      contact_list: [{ id: 'c1', wAid: NUM, firstName: 'Anna', fullName: 'Anna Rao', phone: NUM, created: '2026-10-01T08:00:00Z', photo: 'x', isInFlow: false }],
      link: { total: 1 },
    });
    expect(contacts).toEqual({ contacts: [{ id: 'c1', wAid: NUM, fullName: 'Anna Rao', firstName: 'Anna', phone: NUM, created: '2026-10-01T08:00:00Z' }], link: { total: 1 } });
    const messages = shape('wati_get_messages', {
      result: 'success',
      messages: [{ id: 'm1', created: '2024-01-15T10:30:00Z', type: 'text', text: 'Hello', statusString: 'DELIVERED', owner: false, avatarUrl: 'x' }],
      link: { nextPage: null },
    });
    expect(messages).toEqual({ messages: [{ id: 'm1', created: '2024-01-15T10:30:00Z', type: 'text', text: 'Hello', owner: false, status: 'DELIVERED' }], link: { nextPage: null } });
  });
});

const live = process.env.RUN_WATI_LIVE === '1' ? describe : describe.skip;
live('wati adapter: live', () => {
  const real = !!process.env.WATI_API_ENDPOINT && !!process.env.WATI_ACCESS_TOKEN;
  const env = () => ({ WATI_API_ENDPOINT: process.env.WATI_API_ENDPOINT!, WATI_ACCESS_TOKEN: process.env.WATI_ACCESS_TOKEN! });
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    await sleep(1100); // contacts and messages: about 10 requests per 10 seconds
    return shape(name, await call(name, params, env()));
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const probes = table.filter(([name]) => tool(name).endpointMapping.method === 'GET');
  it.each(probes)('%s reaches a real route and is refused with a made-up token (401)', async (name, params) => {
    await sleep(500);
    await expect(call(name, params, { WATI_API_ENDPOINT: ENDPOINT, WATI_ACCESS_TOKEN: fakeToken() })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it.each([`${ENDPOINT}/api/v1/noSuchRoute`])('answers the made-up route %s with 404, which makes the 401s above meaningful', async (url) => {
    await sleep(500);
    await expect((mockedAxios.__actual as any).request({ method: 'GET', url, headers: { Authorization: `Bearer ${fakeToken()}` } })).rejects.toMatchObject({
      response: { status: 404 },
    });
  }, 30000);

  (real ? it : it.skip)('runs the reads on the workspace', async () => {
    const templates = await run('wati_list_message_templates', { page_size: 5 });
    expect(Array.isArray(templates.templates)).toBe(true);
    const contacts = await run('wati_list_contacts', { page_size: 5 });
    expect(Array.isArray(contacts.contacts)).toBe(true);
    const first = contacts.contacts[0];
    if (first) {
      // A contact without chats answers result:false "Can't find Conversation" (404).
      await run('wati_get_messages', { target: first.wAid ?? first.phone, page_size: 5 }).catch((e) => expect(e.status).toBe(404));
    }
  }, 120000);
});
