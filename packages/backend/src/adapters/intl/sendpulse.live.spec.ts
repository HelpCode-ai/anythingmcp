import axios from 'axios';
import * as adapter from './sendpulse.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * SendPulse REST API adapter (e-mail service, SMTP service, chatbots).
 *
 * Static checks always run: the OAuth 2.0 client-credentials grant at
 * /oauth/access_token, every tool's method and path against SendPulse's API
 * reference (sendpulse.com/integrations/api) and the OpenAPI documents of the
 * WhatsApp and Telegram chatbot services, the transactional e-mail body, and
 * which tools install switched off: everything that mails a whole list, costs
 * money (SMS) or deletes.
 * https://sendpulse.com/integrations/api
 *
 * Without credentials the live check confirms the token endpoint refuses wrong
 * credentials; with SENDPULSE_CLIENT_ID and SENDPULSE_CLIENT_SECRET it reads
 * the balance and one page of mailing lists.
 *
 * Live checks run only with RUN_SENDPULSE_LIVE=1 and never write.
 *
 *   RUN_SENDPULSE_LIVE=1 [SENDPULSE_CLIENT_ID=... SENDPULSE_CLIENT_SECRET=...] \
 *     npx jest src/adapters/intl/sendpulse.live.spec.ts
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
    bodyEncoding?: string;
    headers?: Record<string, string>;
    envDefaults?: Record<string, string>;
    encodePathParams?: boolean;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown; largeIntegers?: string };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error('missing tool ' + name);
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
// Text outside `code` must not carry characters the website reads as MDX.
const plain = (text: string) => text.replace(/`[^`]*`/g, '');

// Placeholders, not credentials.
const ENV: Record<string, string> = {
  SENDPULSE_CLIENT_ID: '0123456789abcdef0123456789abcdef',
  SENDPULSE_CLIENT_SECRET: 'fedcba9876543210fedcba9876543210',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['sendpulse_list_mailing_lists', 'GET', '/addressbooks', ''],
  ['sendpulse_get_mailing_list', 'GET', '/addressbooks/{id}', 'id'],
  ['sendpulse_list_mailing_list_variables', 'GET', '/addressbooks/{id}/variables', 'id'],
  ['sendpulse_list_mailing_list_emails', 'GET', '/addressbooks/{id}/emails', 'id'],
  ['sendpulse_create_mailing_list', 'POST', '/addressbooks', 'name'],
  ['sendpulse_add_emails_to_mailing_list', 'POST', '/addressbooks/{id}/emails', 'id,emails'],
  ['sendpulse_unsubscribe_emails', 'POST', '/addressbooks/{id}/emails/unsubscribe', 'id,emails'],
  ['sendpulse_remove_emails_from_mailing_list', 'DELETE', '/addressbooks/{id}/emails', 'id,emails'],
  ['sendpulse_get_email_info', 'GET', '/emails/{email}', 'email'],
  ['sendpulse_get_email_campaign_stats', 'GET', '/emails/{email}/campaigns', 'email'],
  ['sendpulse_list_campaigns', 'GET', '/campaigns', ''],
  ['sendpulse_get_campaign', 'GET', '/campaigns/{id}', 'id'],
  ['sendpulse_create_campaign', 'POST', '/campaigns', 'sender_name,sender_email,subject,list_id'],
  ['sendpulse_cancel_campaign', 'DELETE', '/campaigns/{id}', 'id'],
  ['sendpulse_list_templates', 'GET', '/templates', ''],
  ['sendpulse_list_senders', 'GET', '/senders', ''],
  ['sendpulse_list_blacklist', 'GET', '/blacklist', ''],
  ['sendpulse_get_balance', 'GET', '/balance', ''],
  ['sendpulse_get_balance_details', 'GET', '/user/balance/detail', ''],
  ['sendpulse_send_smtp_email', 'POST', '/smtp/emails', 'subject,from_email,from_name,to'],
  ['sendpulse_list_smtp_emails', 'GET', '/smtp/emails', ''],
  ['sendpulse_get_smtp_email', 'GET', '/smtp/emails/{id}', 'id'],
  ['sendpulse_list_smtp_bounces', 'GET', '/smtp/bounces/day', ''],
  ['sendpulse_list_smtp_unsubscribed', 'GET', '/smtp/unsubscribe', ''],
  ['sendpulse_list_smtp_senders', 'GET', '/smtp/senders', ''],
  ['sendpulse_send_sms', 'POST', '/sms/send', 'sender,phones,body'],
  ['sendpulse_list_whatsapp_bots', 'GET', '/whatsapp/bots', ''],
  ['sendpulse_list_whatsapp_chats', 'GET', '/whatsapp/chats', 'bot_id'],
  ['sendpulse_list_whatsapp_messages', 'GET', '/whatsapp/chats/messages', 'contact_id'],
  ['sendpulse_get_whatsapp_contact_by_phone', 'GET', '/whatsapp/contacts/getByPhone', 'bot_id,phone'],
  ['sendpulse_send_whatsapp_message', 'POST', '/whatsapp/contacts/send', 'contact_id,text'],
  ['sendpulse_list_telegram_bots', 'GET', '/telegram/bots', ''],
  ['sendpulse_list_telegram_chats', 'GET', '/telegram/chats', 'bot_id'],
  ['sendpulse_list_telegram_messages', 'GET', '/telegram/chats/messages', 'contact_id'],
  ['sendpulse_send_telegram_message', 'POST', '/telegram/contacts/sendText', 'contact_id,text'],
];
const SWITCHED_OFF = ['sendpulse_cancel_campaign','sendpulse_create_campaign','sendpulse_remove_emails_from_mailing_list','sendpulse_send_sms'];
const READ_ONLY = new Set(['sendpulse_list_mailing_lists','sendpulse_get_mailing_list','sendpulse_list_mailing_list_variables','sendpulse_list_mailing_list_emails','sendpulse_get_email_info','sendpulse_get_email_campaign_stats','sendpulse_list_campaigns','sendpulse_get_campaign','sendpulse_list_templates','sendpulse_list_senders','sendpulse_list_blacklist','sendpulse_get_balance','sendpulse_get_balance_details','sendpulse_list_smtp_emails','sendpulse_get_smtp_email','sendpulse_list_smtp_bounces','sendpulse_list_smtp_unsubscribed','sendpulse_list_smtp_senders','sendpulse_list_whatsapp_bots','sendpulse_list_whatsapp_chats','sendpulse_list_whatsapp_messages','sendpulse_get_whatsapp_contact_by_phone','sendpulse_list_telegram_bots','sendpulse_list_telegram_chats','sendpulse_list_telegram_messages']);

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown> = {}) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  const bundle = async () => ({ token: 'test-login-token', expiresAt: Date.now() + 900_000 });
  const login = { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
  return new RestEngine(tokens, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
      largeIntegers: a.connector.config?.largeIntegers,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('sendpulse adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('sendpulse');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('marketing-automation');
    expect(a.icon).toBe('sendpulse');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.sendpulse.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['SENDPULSE_CLIENT_ID','SENDPULSE_CLIENT_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('sendpulse_get_balance');
    for (const key of ['400','401','403','404','rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('uses the client-credentials grant at api.sendpulse.com', async () => {
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SENDPULSE_CLIENT_ID}}',
      clientSecret: '{{SENDPULSE_CLIENT_SECRET}}',
      tokenUrl: 'https://api.sendpulse.com/oauth/access_token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.envVarMeta.SENDPULSE_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.SENDPULSE_CLIENT_ID.pattern!).test(ENV.SENDPULSE_CLIENT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.SENDPULSE_CLIENT_SECRET.pattern!).test('has space 0123456789abcdef')).toBe(false);

    ok({ currency: 'USD', balance_currency: 0 });
    await call('sendpulse_get_balance');
    const req = sent();
    expect(req.url).toBe('https://api.sendpulse.com/balance');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
  });

  it('keeps every tool on its documented method and path', () => {
    expect(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path, (t.parameters.required ?? []).join(',')])).toEqual(TOOLS);
    expect(a.tools).toHaveLength(35);
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^sendpulse_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      for (const def of Object.values(entry.parameters.properties ?? {})) expect(def.description).toBeTruthy();
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('marks reads read-only and installs the risky tools switched off', () => {
    for (const entry of a.tools) {
      expect(entry.name + ':' + String(annotationsOf(entry).readOnlyHint)).toBe(entry.name + ':' + String(READ_ONLY.has(entry.name)));
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual(SWITCHED_OFF);
    // Sending to one or a few people stays on; mailing a list and paid SMS do not.
    expect(tool('sendpulse_send_smtp_email').enabled).not.toBe(false);
    expect(tool('sendpulse_create_campaign').endpointMapping).toMatchObject({ method: 'POST', path: '/campaigns' });
    expect(tool('sendpulse_send_sms').endpointMapping).toMatchObject({ method: 'POST', path: '/sms/send' });
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/campaigns\/send|sendTemplate|\/viber|\/push/);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const entry of a.tools) {
      expect(a.instructions).toContain(entry.name);
      expect(plain(entry.description)).not.toMatch(/[{}<]/);
      for (const def of Object.values(entry.parameters.properties ?? {})) expect(plain(def.description ?? '')).not.toMatch(/[{}<]/);
    }
    expect(plain(a.instructions)).not.toMatch(/[{}<]/);
    expect(plain(a.description)).not.toMatch(/[{}<]/);
    expect(a.instructions).not.toMatch(/\u2014/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('builds the transactional e-mail as SendPulse documents it', async () => {
    ok({ result: true, id: 'pzkic9-0afezp-fc' });
    await call('sendpulse_send_smtp_email', {
      subject: 'Your invoice',
      from_email: 'billing@example.com',
      from_name: 'Billing',
      to: [{ email: 'jane@example.com', name: 'Jane' }],
      text: 'Hello Jane',
      html_base64: 'PHA+SGVsbG8gSmFuZTwvcD4=',
    });
    expect(sent().url).toBe('https://api.sendpulse.com/smtp/emails');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      email: {
        subject: 'Your invoice',
        from: { name: 'Billing', email: 'billing@example.com' },
        to: [{ email: 'jane@example.com', name: 'Jane' }],
        text: 'Hello Jane',
        html: 'PHA+SGVsbG8gSmFuZTwvcD4=',
      },
    });

    ok({ result: true });
    await call('sendpulse_send_smtp_email', {
      subject: 'Your code',
      from_email: 'no-reply@example.com',
      from_name: 'Shop',
      to: [{ email: 'jane@example.com' }],
      template: { id: 123456, variables: { code: '4711' } },
    });
    expect(sent().data).toEqual({
      email: {
        subject: 'Your code',
        from: { name: 'Shop', email: 'no-reply@example.com' },
        to: [{ email: 'jane@example.com' }],
        template: { id: 123456, variables: { code: '4711' } },
      },
    });
  });

  it('reads and maintains mailing lists on the documented paths', async () => {
    ok([]);
    await call('sendpulse_list_mailing_list_emails', { id: 422325, limit: 100, offset: 100, active: true });
    expect(sent().url).toBe('https://api.sendpulse.com/addressbooks/422325/emails');
    expect(sent().params).toEqual({ limit: 100, offset: 100, active: true });

    ok({ id: 1 });
    await call('sendpulse_create_mailing_list', { name: 'Newsletter' });
    expect(sent().url).toBe('https://api.sendpulse.com/addressbooks');
    expect(sent().data).toEqual({ bookName: 'Newsletter' });

    ok({ result: true });
    await call('sendpulse_add_emails_to_mailing_list', { id: 422325, emails: [{ email: 'jane@example.com', variables: { name: 'Jane' } }] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ emails: [{ email: 'jane@example.com', variables: { name: 'Jane' } }] });

    ok({ result: true });
    await call('sendpulse_remove_emails_from_mailing_list', { id: 422325, emails: ['jane@example.com'] });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe('https://api.sendpulse.com/addressbooks/422325/emails');
    expect(sent().data).toEqual({ emails: ['jane@example.com'] });

    ok([]);
    await call('sendpulse_get_email_info', { email: 'jane@example.com' });
    expect(sent().url).toBe('https://api.sendpulse.com/emails/jane%40example.com');

    ok([]);
    await call('sendpulse_list_templates');
    expect(sent().url).toBe('https://api.sendpulse.com/templates');
    expect(sent().params).toEqual({ owner: 'me' });
  });

  it('talks to the chatbot services under /whatsapp and /telegram', async () => {
    ok({ success: true, data: [] });
    await call('sendpulse_list_whatsapp_chats', { bot_id: '60c9d4b8e0f3b2a1c4d5e6f0', size: 20 });
    expect(sent().url).toBe('https://api.sendpulse.com/whatsapp/chats');
    expect(sent().params).toEqual({ bot_id: '60c9d4b8e0f3b2a1c4d5e6f0', size: 20 });

    ok({ success: true, data: {} });
    await call('sendpulse_send_whatsapp_message', { contact_id: '60c9d4b8e0f3b2a1c4d5e6f7', text: 'Hello' });
    expect(sent().url).toBe('https://api.sendpulse.com/whatsapp/contacts/send');
    expect(sent().data).toEqual({ contact_id: '60c9d4b8e0f3b2a1c4d5e6f7', message: { type: 'text', text: { body: 'Hello' } } });

    ok({ success: true, data: {} });
    await call('sendpulse_send_telegram_message', { contact_id: '60c9d4b8e0f3b2a1c4d5e6f7', text: 'Hello' });
    expect(sent().url).toBe('https://api.sendpulse.com/telegram/contacts/sendText');
    expect(sent().data).toEqual({ contact_id: '60c9d4b8e0f3b2a1c4d5e6f7', text: 'Hello' });
  });
});

// Opt-in: RUN_SENDPULSE_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_SENDPULSE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('sendpulse: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post(
      'https://api.sendpulse.com/oauth/access_token',
      'grant_type=client_credentials&client_id=not-a-client&client_secret=not-a-secret',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true },
    );
    expect([400, 401]).toContain(response.status);
  });

  it('reads the balance and one page of mailing lists', async () => {
    const id = process.env.SENDPULSE_CLIENT_ID;
    const secret = process.env.SENDPULSE_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set SENDPULSE_CLIENT_ID and SENDPULSE_CLIENT_SECRET for the live check');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString();
    const token = await liveFetch.post('https://api.sendpulse.com/oauth/access_token', body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const auth = { Authorization: 'Bearer ' + token.data.access_token };
    const balance = await liveFetch.get('https://api.sendpulse.com/balance', { headers: auth, validateStatus: () => true });
    expect(balance.status).toBe(200);
    const lists = await liveFetch.get('https://api.sendpulse.com/addressbooks', { headers: auth, params: { limit: 5 }, validateStatus: () => true });
    expect(lists.status).toBe(200);
  });
});
