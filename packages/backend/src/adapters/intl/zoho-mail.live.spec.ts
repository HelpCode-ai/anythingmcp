import axios from 'axios';
import * as adapter from './zoho-mail.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Zoho Mail adapter:
 *
 *   1. Static: always runs. Pins the Zoho OAuth endpoints on the configurable
 *      data-center sign-in server (offline access, consent prompt, the
 *      `Zoho-oauthtoken` header), the Mail API host, and every tool's method,
 *      URL, query and body through the real RestEngine, checked against the
 *      Zoho Mail API pages (zoho.com/mail/help/api, read 14 Oct 2026): the
 *      updatemessage modes, the reply action, expunge on delete. Ids stay
 *      strings because Zoho's 19-digit ids do not fit a JavaScript number.
 *
 *   2. Live: skipped unless RUN_ZOHO_MAIL_LIVE=1. Without a token it checks
 *      that Zoho answers 401 INVALID_OAUTHTOKEN on the real routes. With
 *      ZOHO_MAIL_ACCESS_TOKEN (scopes as in the adapter; ZOHO_MAIL_API_URL
 *      defaults to https://mail.zoho.eu) it reads the accounts, folders,
 *      labels, the Inbox, a search, and one email's content, headers and
 *      details:
 *
 *        RUN_ZOHO_MAIL_LIVE=1 ZOHO_MAIL_ACCESS_TOKEN=1000.abc... npx jest src/adapters/intl/zoho-mail.live.spec.ts
 *
 *      ZOHO_MAIL_LIVE_WRITE=1 with ZOHO_MAIL_TEST_TO (an address of your own)
 *      sends one test email, then marks it unread and read, flags it and
 *      clears the flag.
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
  parameters: { properties?: Record<string, { type?: string; items?: { type: string }; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: { transform?: unknown };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
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

const EU = 'https://mail.zoho.eu';
const BASE = `${EU}/api`;
const ACC = '2560636000000008002';
const FOLDER = '2560636000000008014';
const MSG = '1709887058769100001';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params,
// schema defaults applied, and the OAuth2 token sent with the adapter's prefix.
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    {
      baseUrl: config.baseUrl,
      authType: 'OAUTH2',
      authConfig: { tokenPrefix: a.connector.authConfig.tokenPrefix },
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const ENV = { ZOHO_MAIL_API_URL: EU };
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'zoho_mail_get_email_content',
  'zoho_mail_get_email_details',
  'zoho_mail_get_email_headers',
  'zoho_mail_list_accounts',
  'zoho_mail_list_emails',
  'zoho_mail_list_folders',
  'zoho_mail_list_labels',
  'zoho_mail_search_emails',
];

describe('zoho-mail adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified on a live account on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('email');
    expect(a.icon).toBe('zoho-mail');
  });

  it('signs in at the chosen data center with offline access and sends Zoho-oauthtoken', async () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{ZOHO_MAIL_CLIENT_ID}}',
      clientSecret: '{{ZOHO_MAIL_CLIENT_SECRET}}',
      authorizationUrl: '{{ZOHO_MAIL_ACCOUNTS_URL}}/oauth/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: '{{ZOHO_MAIL_ACCOUNTS_URL}}/oauth/v2/token',
      scopes: 'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.ALL,ZohoMail.tags.READ',
      tokenPrefix: 'Zoho-oauthtoken',
    });
    expect(a.instructions).toContain(a.connector.authConfig.scopes);
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    mockedAxios.mockResolvedValue({ data: { status: { code: 200 } } });
    await call('zoho_mail_list_accounts', {});
    expect(sent().headers.Authorization).toBe('Zoho-oauthtoken test-token');
  });

  it('validates the data-center hosts', () => {
    expect(a.requiredEnvVars).toEqual(['ZOHO_MAIL_CLIENT_ID', 'ZOHO_MAIL_CLIENT_SECRET', 'ZOHO_MAIL_ACCOUNTS_URL', 'ZOHO_MAIL_API_URL']);
    expect(a.connector.baseUrl).toBe('{{ZOHO_MAIL_API_URL}}/api');
    const accounts = new RegExp(a.envVarMeta.ZOHO_MAIL_ACCOUNTS_URL.pattern!);
    for (const ok of ['https://accounts.zoho.eu', 'https://accounts.zoho.com', 'https://accounts.zoho.in', 'https://accounts.zoho.com.au', 'https://accounts.zohocloud.ca', 'https://accounts.zoho.sa']) {
      expect(accounts.test(ok)).toBe(true);
    }
    expect(accounts.test('https://accounts.zoho.eu/')).toBe(false);
    expect(accounts.test('https://accounts.zoho.eu.evil.example')).toBe(false);
    const api = new RegExp(a.envVarMeta.ZOHO_MAIL_API_URL.pattern!);
    for (const ok of [EU, 'https://mail.zoho.com', 'https://mail.zoho.in', 'https://mail.zohocloud.ca', 'https://mail.zoho.com.au', 'https://mail.zoho.ae']) {
      expect(api.test(ok)).toBe(true);
    }
    for (const bad of [`${EU}/api`, 'https://www.zohoapis.eu', 'https://mail.zoho.eu/']) expect(api.test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.ZOHO_MAIL_CLIENT_ID.pattern!).test('1000.ABCDEF123')).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'ZOHO_MAIL_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'ZOHO_MAIL_API_URL')!.kind).toBe('address');
  });

  it('probes and health-checks with the account list, which every other tool depends on', () => {
    expect(a.probe.tool).toBe('zoho_mail_list_accounts');
    expect(a.connector.healthcheckPath).toBe('/accounts');
    expect(a.instructions).toMatch(/Account id first/);
    for (const t of a.tools.filter((x) => x.name !== 'zoho_mail_list_accounts')) {
      expect(t.parameters.required).toContain('account_id');
      expect(t.endpointMapping.path.startsWith('/accounts/{account_id}')).toBe(true);
    }
  });

  it('keeps every id a string, since Zoho ids exceed JavaScript number precision', () => {
    for (const t of a.tools) {
      for (const [key, prop] of Object.entries(t.parameters.properties ?? {})) {
        // flag_id is a small enum (0 to 3), not a record id.
        if (/_id$/.test(key) && key !== 'flag_id') expect(`${t.name}.${key}:${prop.type}`).toBe(`${t.name}.${key}:string`);
        if (/_ids$/.test(key)) expect(`${t.name}.${key}:${prop.items?.type}`).toBe(`${t.name}.${key}:string`);
      }
    }
  });

  it('prefixes every tool with zoho_mail_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^zoho_mail_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the reads read-only, asks to confirm every write and installs delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const t of a.tools.filter((x) => !READ_ONLY.includes(x.name))) {
      expect(`${t.name}: ${t.description}`).toMatch(/confirm|explicit yes/i);
    }
    expect(tool('zoho_mail_send_email').description).toMatch(/explicit yes/);
    expect(tool('zoho_mail_reply_to_email').description).toMatch(/explicit yes/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['zoho_mail_delete_email']);
    expect(annotationsOf(tool('zoho_mail_delete_email')).destructiveHint).toBe(true);
    // The updatemessage PUTs only set state; marking twice changes nothing more.
    for (const name of ['zoho_mail_mark_as_read', 'zoho_mail_mark_as_unread', 'zoho_mail_move_emails', 'zoho_mail_flag_emails', 'zoho_mail_apply_labels']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bzoho_mail_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzoho_mail_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const msgPath = `/accounts/${ACC}/folders/${FOLDER}/messages/${MSG}`;
  const ids = { account_id: ACC, folder_id: FOLDER, message_id: MSG };
  const mail = { account_id: ACC, from_address: 'me@example.com', to_address: 'you@example.com', subject: 'Hi', content: 'Hello' };
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['zoho_mail_list_accounts', {}, 'GET', '/accounts'],
    ['zoho_mail_list_folders', { account_id: ACC }, 'GET', `/accounts/${ACC}/folders`],
    ['zoho_mail_list_labels', { account_id: ACC }, 'GET', `/accounts/${ACC}/labels`],
    ['zoho_mail_list_emails', { account_id: ACC }, 'GET', `/accounts/${ACC}/messages/view`],
    ['zoho_mail_search_emails', { account_id: ACC, search_key: 'newMails' }, 'GET', `/accounts/${ACC}/messages/search`],
    ['zoho_mail_get_email_content', ids, 'GET', `${msgPath}/content`],
    ['zoho_mail_get_email_headers', ids, 'GET', `${msgPath}/header`],
    ['zoho_mail_get_email_details', ids, 'GET', `${msgPath}/details`],
    ['zoho_mail_send_email', mail, 'POST', `/accounts/${ACC}/messages`],
    ['zoho_mail_reply_to_email', { ...mail, message_id: MSG }, 'POST', `/accounts/${ACC}/messages/${MSG}`],
    ['zoho_mail_mark_as_read', { account_id: ACC, message_ids: [MSG] }, 'PUT', `/accounts/${ACC}/updatemessage`],
    ['zoho_mail_mark_as_unread', { account_id: ACC, message_ids: [MSG] }, 'PUT', `/accounts/${ACC}/updatemessage`],
    ['zoho_mail_move_emails', { account_id: ACC, message_ids: [MSG], destination_folder_id: FOLDER }, 'PUT', `/accounts/${ACC}/updatemessage`],
    ['zoho_mail_flag_emails', { account_id: ACC, message_ids: [MSG], flag: 'important' }, 'PUT', `/accounts/${ACC}/updatemessage`],
    ['zoho_mail_apply_labels', { account_id: ACC, message_ids: [MSG], label_ids: ['2674552000000009027'] }, 'PUT', `/accounts/${ACC}/updatemessage`],
    ['zoho_mail_delete_email', ids, 'DELETE', msgPath],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { status: { code: 200 } } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Zoho-oauthtoken test-token' }) }),
    );
  });

  it('lists a folder with Zoho parameter names and the default page size', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_list_emails', { account_id: ACC, folder_id: FOLDER, status: 'unread', flag_id: 2, sort_ascending: false, include_to: true });
    expect(sent().params).toEqual({ folderId: FOLDER, limit: 20, status: 'unread', flagid: 2, sortorder: false, includeto: true });
  });

  it('searches with searchKey and receivedTime', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_search_emails', { account_id: ACC, search_key: 'subject:invoice::has:attachment', received_before: 1760000000000, start: 21 });
    expect(sent().params).toEqual({ searchKey: 'subject:invoice::has:attachment', receivedTime: 1760000000000, start: 21, limit: 20 });
  });

  it('reads headers as JSON by default and content with quoted blocks on request', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_get_email_headers', ids);
    expect(sent().params).toEqual({ raw: false });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_get_email_content', { ...ids, include_quoted: true });
    expect(sent().params).toEqual({ includeBlockContent: true });
  });

  it('sends an email with the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_send_email', { ...mail, cc_address: 'cc@example.com', mail_format: 'plaintext', is_schedule: true, schedule_type: 6, time_zone: 'GMT 1:00', schedule_time: '10/20/2026 09:00:00' });
    expect(sent().data).toEqual({
      fromAddress: 'me@example.com', toAddress: 'you@example.com', ccAddress: 'cc@example.com', subject: 'Hi', content: 'Hello',
      mailFormat: 'plaintext', isSchedule: true, scheduleType: 6, timeZone: 'GMT 1:00', scheduleTime: '10/20/2026 09:00:00',
    });
  });

  it('replies with action reply', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_reply_to_email', { ...mail, message_id: MSG, subject: 'Re: Hi' });
    expect(sent().data).toEqual({ fromAddress: 'me@example.com', toAddress: 'you@example.com', subject: 'Re: Hi', content: 'Hello', action: 'reply' });
  });

  it.each([
    ['zoho_mail_mark_as_read', {}, { mode: 'markAsRead' }],
    ['zoho_mail_mark_as_unread', {}, { mode: 'markAsUnread' }],
    ['zoho_mail_move_emails', { destination_folder_id: FOLDER }, { mode: 'moveMessage', destfolderId: FOLDER }],
    ['zoho_mail_flag_emails', { flag: 'followup' }, { mode: 'setFlag', flagid: 'followup' }],
    ['zoho_mail_apply_labels', { label_ids: ['11', '12'] }, { mode: 'applyLabel', labelId: ['11', '12'] }],
  ])('%s sends the updatemessage mode with string ids', async (name, extra, expected) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name as string, { account_id: ACC, message_ids: [MSG, '1709887058769100002'], ...(extra as object) });
    expect(sent().data).toEqual({ ...(expected as object), messageId: [MSG, '1709887058769100002'] });
  });

  it('moves a deleted email to the Trash unless asked to expunge', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_delete_email', ids);
    expect(sent().params).toEqual({ expunge: false });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoho_mail_delete_email', { ...ids, permanently: true });
    expect(sent().params).toEqual({ expunge: true });
  });

  it('shrinks the account list to the fields needed for the next calls', () => {
    const t = tool('zoho_mail_list_accounts');
    expect(validateTransform(t.responseMapping!.transform)).toBeNull();
    const raw = {
      status: { code: 200, description: 'success' },
      data: [{ accountId: ACC, accountName: 'bizdemo', accountDisplayName: 'Rebecca', primaryEmailAddress: 'rebecca@zylker.com', mailboxAddress: 'rebecca@zylker.com', emailAddress: [{ mailId: 'rebecca@zylker.com', isPrimary: true }], sendMailDetails: [{ fromAddress: 'rebecca@zylker.com' }], type: 'ZOHO_ACCOUNT', lastLogin: 1, usedStorage: 2 }],
    };
    const out = applyResponseTransform(raw, t.responseMapping as any).value as any;
    expect(out.accounts[0]).toEqual({
      accountId: ACC, accountName: 'bizdemo', accountDisplayName: 'Rebecca', primaryEmailAddress: 'rebecca@zylker.com', mailboxAddress: 'rebecca@zylker.com',
      emailAddress: [{ mailId: 'rebecca@zylker.com', isPrimary: true }], sendMailDetails: [{ fromAddress: 'rebecca@zylker.com' }], type: 'ZOHO_ACCOUNT',
    });
  });
});

const live = process.env.RUN_ZOHO_MAIL_LIVE === '1' ? describe : describe.skip;
const TOKEN = process.env.ZOHO_MAIL_ACCESS_TOKEN;

live('zoho-mail adapter: live API', () => {
  const env = { ZOHO_MAIL_API_URL: process.env.ZOHO_MAIL_API_URL || EU };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  // Like production: the tool's responseMapping applies to the engine's answer.
  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, env, TOKEN as string, params), (tool(name) as any).responseMapping).value;

  it('answers 401 INVALID_OAUTHTOKEN without a valid token', async () => {
    for (const [name, params] of [
      ['zoho_mail_list_accounts', {}],
      ['zoho_mail_list_folders', { account_id: ACC }],
      ['zoho_mail_list_emails', { account_id: ACC }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(execute(name, env, 'invalid-token', params)).rejects.toMatchObject({ response: { status: 401 } });
    }
  }, 60_000);

  (TOKEN ? it : it.skip)('reads accounts, folders, labels, the Inbox, a search and one email', async () => {
    const { accounts } = await run('zoho_mail_list_accounts');
    expect(accounts.length).toBeGreaterThan(0);
    const accountId = String(accounts[0].accountId);
    const folders = (await run('zoho_mail_list_folders', { account_id: accountId })).data;
    const inbox = folders.find((f: { folderType: string }) => f.folderType === 'Inbox') ?? folders[0];
    expect(Array.isArray((await run('zoho_mail_list_labels', { account_id: accountId })).data)).toBe(true);
    const list = (await run('zoho_mail_list_emails', { account_id: accountId, folder_id: String(inbox.folderId), limit: 3 })).data;
    expect(Array.isArray(list)).toBe(true);
    expect(Array.isArray((await run('zoho_mail_search_emails', { account_id: accountId, search_key: 'has:attachment', limit: 3 })).data ?? [])).toBe(true);
    if (list.length) {
      const ids = { account_id: accountId, folder_id: String(list[0].folderId), message_id: String(list[0].messageId) };
      expect(typeof (await run('zoho_mail_get_email_content', ids)).data.content).toBe('string');
      expect((await run('zoho_mail_get_email_headers', ids)).status.code).toBe(200);
      expect((await run('zoho_mail_get_email_details', ids)).status.code).toBe(200);
    }
  }, 120_000);

  (TOKEN && process.env.ZOHO_MAIL_LIVE_WRITE === '1' && process.env.ZOHO_MAIL_TEST_TO ? it : it.skip)('sends a test email and marks, flags and unflags it', async () => {
    const { accounts } = await run('zoho_mail_list_accounts');
    const account = accounts[0];
    const accountId = String(account.accountId);
    const sentMail = (
      await run('zoho_mail_send_email', {
        account_id: accountId, from_address: account.primaryEmailAddress, to_address: process.env.ZOHO_MAIL_TEST_TO,
        subject: `AnythingMCP live spec ${new Date().toISOString()}`, content: 'Sent by the AnythingMCP live spec; safe to delete.', mail_format: 'plaintext',
      })
    ).data;
    const messageIds = [String(sentMail.messageId)];
    await run('zoho_mail_mark_as_unread', { account_id: accountId, message_ids: messageIds });
    await run('zoho_mail_mark_as_read', { account_id: accountId, message_ids: messageIds });
    await run('zoho_mail_flag_emails', { account_id: accountId, message_ids: messageIds, flag: 'followup' });
    await run('zoho_mail_flag_emails', { account_id: accountId, message_ids: messageIds, flag: 'flag_not_set' });
  }, 120_000);
});
