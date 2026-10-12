import axios from 'axios';
import * as adapter from './intercom.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Intercom adapter:
 *
 *   1. Static: always runs. Pins the Bearer token auth, the region host from
 *      INTERCOM_API_URL, the Intercom-Version 2.16 header, the env var
 *      patterns, every tool's method and URL through the real RestEngine (with
 *      axios mocked), the request bodies of every write (fixed message_type
 *      and type values, search pagination inside the body, draft articles by
 *      default), and the read-only, destructive and switched-off sets.
 *
 *   2. Live: skipped unless INTERCOM_ACCESS_TOKEN is set (the access token of a
 *      Developer Hub app, Configure → Authentication). INTERCOM_API_URL
 *      defaults to https://api.intercom.io (US):
 *
 *        INTERCOM_ACCESS_TOKEN=... npx jest src/adapters/intl/intercom.live.spec.ts
 *
 *      Runs every read tool, picking ids from list answers and skipping the
 *      follow-up reads when the workspace has nothing to read.
 *
 *      INTERCOM_LIVE_WRITE=1 also runs a write cycle on test data labelled
 *      "AnythingMCP live spec (safe to delete)": a tag, a lead with an
 *      example.com address (updated, tagged, noted, attached to a test company,
 *      archived and unarchived), an inbound conversation from that lead
 *      (noted, assigned, tagged, snoozed, reopened, closed without a message),
 *      and, when the workspace has a Help Center, a collection with a draft
 *      article. Everything is deleted in `finally`. Nothing is sent to a real
 *      customer; the only customer-visible reply goes to the test lead, and
 *      only with INTERCOM_LIVE_REPLY=1 as well. Use a development workspace.
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

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  headers?: Record<string, string>;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
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
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

// Mirrors DynamicMcpTools: {{VAR}} interpolated everywhere, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};

const EU = 'https://api.eu.intercom.io';
const ENV = { INTERCOM_API_URL: EU, INTERCOM_ACCESS_TOKEN: 'test-token' };
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'intercom_find_contact_by_external_id',
  'intercom_get_admin',
  'intercom_get_article',
  'intercom_get_collection',
  'intercom_get_company',
  'intercom_get_contact',
  'intercom_get_conversation',
  'intercom_get_me',
  'intercom_get_team',
  'intercom_get_ticket',
  'intercom_list_admins',
  'intercom_list_articles',
  'intercom_list_collections',
  'intercom_list_companies',
  'intercom_list_company_contacts',
  'intercom_list_contact_companies',
  'intercom_list_contact_notes',
  'intercom_list_contact_tags',
  'intercom_list_contacts',
  'intercom_list_conversations',
  'intercom_list_data_attributes',
  'intercom_list_help_centers',
  'intercom_list_segments',
  'intercom_list_tags',
  'intercom_list_teams',
  'intercom_list_ticket_states',
  'intercom_list_ticket_types',
  'intercom_search_articles',
  'intercom_search_contacts',
  'intercom_search_conversations',
  'intercom_search_tickets',
];
const OFF = ['intercom_delete_article', 'intercom_delete_collection', 'intercom_delete_contact'];
// Writes that overwrite, hide, close or remove something.
const DESTRUCTIVE = [
  ...OFF,
  'intercom_archive_contact',
  'intercom_close_conversation',
  'intercom_detach_contact_from_company',
  'intercom_untag_contact',
  'intercom_untag_conversation',
  'intercom_update_article',
  'intercom_update_collection',
  'intercom_update_contact',
  'intercom_update_ticket',
].sort();
// Writes whose effect a customer can see, or that remove data: the description asks for confirmation.
const CONFIRM = [
  ...OFF,
  'intercom_archive_contact',
  'intercom_close_conversation',
  'intercom_create_article',
  'intercom_create_collection',
  'intercom_reply_to_conversation',
  'intercom_reply_to_ticket',
  'intercom_update_article',
  'intercom_update_collection',
  'intercom_update_ticket',
];

describe('intercom adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the access token as Bearer to the region host, with Intercom-Version 2.16', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INTERCOM_ACCESS_TOKEN}}' });
    expect(a.connector.baseUrl).toBe('{{INTERCOM_API_URL}}');
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'Intercom-Version': '2.16', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.requiredEnvVars).toEqual(['INTERCOM_API_URL', 'INTERCOM_ACCESS_TOKEN']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'INTERCOM_ACCESS_TOKEN')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'INTERCOM_API_URL')!.kind).toBe('address');
  });

  it('accepts only the three regional API hosts and a bare token', () => {
    const host = new RegExp(a.envVarMeta.INTERCOM_API_URL.pattern!);
    for (const ok of ['https://api.intercom.io', 'https://api.eu.intercom.io', 'https://api.au.intercom.io']) {
      expect(host.test(ok)).toBe(true);
    }
    for (const bad of [
      'https://api.intercom.io/',
      'https://api.intercom.io/me',
      'http://api.intercom.io',
      'https://api.intercom.io.evil.example',
      'https://api.us.intercom.io',
      'https://app.intercom.com',
      'api.intercom.io',
    ]) {
      expect(host.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.INTERCOM_ACCESS_TOKEN.pattern!);
    const fake = 'dG9r' + 'x'.repeat(40) + '=';
    expect(token.test(fake)).toBe(true);
    expect(token.test(`Bearer ${fake}`)).toBe(false);
    expect(token.test('short')).toBe(false);
  });

  it('probes with the token owner, which needs no argument, and sends the version header', async () => {
    expect(a.probe.tool).toBe('intercom_get_me');
    expect(a.probe.params).toBeUndefined();
    expect(tool('intercom_get_me').parameters.required).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_get_me', {});
    expect(sent().url).toBe(`${EU}/me`);
    expect(sent().headers).toMatchObject({ Authorization: 'Bearer test-token', 'Intercom-Version': '2.16', Accept: 'application/json' });
  });

  it('prefixes every tool with intercom_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^intercom_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (the POST searches too), pins the destructive writes and installs deletes switched off', () => {
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort()).toEqual(READ_ONLY);
    for (const name of ['intercom_search_contacts', 'intercom_search_conversations', 'intercom_search_tickets']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).description).toMatch(/read-only although it is a POST/i);
    }
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint === false);
    expect(writes.length + READ_ONLY.length).toBe(a.tools.length);
    expect(writes.filter((t) => annotationsOf(t).destructiveHint === true).map((t) => t.name).sort()).toEqual(DESTRUCTIVE);
    expect(annotationsOf(tool('intercom_close_conversation'))).toMatchObject({ destructiveHint: true, idempotentHint: false });
    // Unarchiving restores a contact; the name must not make it look destructive.
    expect(annotationsOf(tool('intercom_unarchive_contact')).destructiveHint).toBe(false);
    // Replies post a new message each time.
    expect(annotationsOf(tool('intercom_reply_to_conversation')).idempotentHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of CONFIRM) expect(`${name}: ${tool(name).description}`).toMatch(/confirm/i);
  });

  it('encodes every path argument', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bintercom_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bintercom_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Intercom')).toBe(true);
    for (const text of [
      'https://app.intercom.com/a/apps/_/developer-hub',
      'https://app.intercom.com/admins/sign_up/developer',
      'Configure → Authentication',
      'https://api.eu.intercom.io',
      'https://api.au.intercom.io',
      'Read-only setup',
      'Out of scope',
      '429',
    ]) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const C = '6762f0d01bb69f9f2193bb7d';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['intercom_get_me', {}, 'GET', `${EU}/me`],
    ['intercom_list_admins', {}, 'GET', `${EU}/admins`],
    ['intercom_get_admin', { admin_id: '991267459' }, 'GET', `${EU}/admins/991267459`],
    ['intercom_list_teams', {}, 'GET', `${EU}/teams`],
    ['intercom_get_team', { team_id: '5017691' }, 'GET', `${EU}/teams/5017691`],
    ['intercom_list_tags', {}, 'GET', `${EU}/tags`],
    ['intercom_create_tag', { name: 'VIP' }, 'POST', `${EU}/tags`],
    ['intercom_list_segments', {}, 'GET', `${EU}/segments`],
    ['intercom_list_data_attributes', {}, 'GET', `${EU}/data_attributes`],
    ['intercom_list_contacts', {}, 'GET', `${EU}/contacts`],
    ['intercom_search_contacts', { query: {} }, 'POST', `${EU}/contacts/search`],
    ['intercom_get_contact', { contact_id: C }, 'GET', `${EU}/contacts/${C}`],
    ['intercom_find_contact_by_external_id', { external_id: 'crm/42' }, 'GET', `${EU}/contacts/find_by_external_id/crm%2F42`],
    ['intercom_create_contact', { email: 'ana@example.com' }, 'POST', `${EU}/contacts`],
    ['intercom_update_contact', { contact_id: C, name: 'Ana' }, 'PUT', `${EU}/contacts/${C}`],
    ['intercom_archive_contact', { contact_id: C }, 'POST', `${EU}/contacts/${C}/archive`],
    ['intercom_unarchive_contact', { contact_id: C }, 'POST', `${EU}/contacts/${C}/unarchive`],
    ['intercom_delete_contact', { contact_id: C }, 'DELETE', `${EU}/contacts/${C}`],
    ['intercom_list_contact_tags', { contact_id: C }, 'GET', `${EU}/contacts/${C}/tags`],
    ['intercom_tag_contact', { contact_id: C, tag_id: '81' }, 'POST', `${EU}/contacts/${C}/tags`],
    ['intercom_untag_contact', { contact_id: C, tag_id: '81' }, 'DELETE', `${EU}/contacts/${C}/tags/81`],
    ['intercom_list_contact_notes', { contact_id: C }, 'GET', `${EU}/contacts/${C}/notes`],
    ['intercom_add_contact_note', { contact_id: C, body: 'Called' }, 'POST', `${EU}/contacts/${C}/notes`],
    ['intercom_list_contact_companies', { contact_id: C }, 'GET', `${EU}/contacts/${C}/companies`],
    ['intercom_attach_contact_to_company', { contact_id: C, company_id: 'co1' }, 'POST', `${EU}/contacts/${C}/companies`],
    ['intercom_detach_contact_from_company', { contact_id: C, company_id: 'co1' }, 'DELETE', `${EU}/contacts/${C}/companies/co1`],
    ['intercom_list_companies', {}, 'GET', `${EU}/companies`],
    ['intercom_get_company', { company_id: 'co1' }, 'GET', `${EU}/companies/co1`],
    ['intercom_create_or_update_company', { company_id: 'acme-1' }, 'POST', `${EU}/companies`],
    ['intercom_list_company_contacts', { company_id: 'co1' }, 'GET', `${EU}/companies/co1/contacts`],
    ['intercom_list_conversations', {}, 'GET', `${EU}/conversations`],
    ['intercom_search_conversations', { query: {} }, 'POST', `${EU}/conversations/search`],
    ['intercom_get_conversation', { conversation_id: '1295' }, 'GET', `${EU}/conversations/1295`],
    ['intercom_reply_to_conversation', { conversation_id: '1295', admin_id: '7', body: 'Hi' }, 'POST', `${EU}/conversations/1295/reply`],
    ['intercom_add_conversation_note', { conversation_id: '1295', admin_id: '7', body: 'FYI' }, 'POST', `${EU}/conversations/1295/reply`],
    ['intercom_assign_conversation', { conversation_id: '1295', admin_id: '7', assignee_type: 'admin', assignee_id: '8' }, 'POST', `${EU}/conversations/1295/parts`],
    ['intercom_close_conversation', { conversation_id: '1295', admin_id: '7' }, 'POST', `${EU}/conversations/1295/parts`],
    ['intercom_snooze_conversation', { conversation_id: '1295', admin_id: '7', snoozed_until: 1893456000 }, 'POST', `${EU}/conversations/1295/parts`],
    ['intercom_open_conversation', { conversation_id: '1295', admin_id: '7' }, 'POST', `${EU}/conversations/1295/parts`],
    ['intercom_tag_conversation', { conversation_id: '1295', tag_id: '81', admin_id: '7' }, 'POST', `${EU}/conversations/1295/tags`],
    ['intercom_untag_conversation', { conversation_id: '1295', tag_id: '81', admin_id: '7' }, 'DELETE', `${EU}/conversations/1295/tags/81`],
    ['intercom_search_tickets', { query: {} }, 'POST', `${EU}/tickets/search`],
    ['intercom_get_ticket', { ticket_id: '631' }, 'GET', `${EU}/tickets/631`],
    ['intercom_reply_to_ticket', { ticket_id: '631', admin_id: '7', body: 'Noted' }, 'POST', `${EU}/tickets/631/reply`],
    ['intercom_update_ticket', { ticket_id: '631', open: false }, 'PUT', `${EU}/tickets/631`],
    ['intercom_list_ticket_types', {}, 'GET', `${EU}/ticket_types`],
    ['intercom_list_ticket_states', {}, 'GET', `${EU}/ticket_states`],
    ['intercom_list_help_centers', {}, 'GET', `${EU}/help_center/help_centers`],
    ['intercom_list_collections', {}, 'GET', `${EU}/help_center/collections`],
    ['intercom_get_collection', { collection_id: '159' }, 'GET', `${EU}/help_center/collections/159`],
    ['intercom_create_collection', { name: 'Billing' }, 'POST', `${EU}/help_center/collections`],
    ['intercom_update_collection', { collection_id: '159', name: 'Billing' }, 'PUT', `${EU}/help_center/collections/159`],
    ['intercom_delete_collection', { collection_id: '159' }, 'DELETE', `${EU}/help_center/collections/159`],
    ['intercom_list_articles', {}, 'GET', `${EU}/articles`],
    ['intercom_search_articles', { phrase: 'refund' }, 'GET', `${EU}/articles/search`],
    ['intercom_get_article', { article_id: '39' }, 'GET', `${EU}/articles/39`],
    ['intercom_create_article', { title: 'Refunds', author_id: 7 }, 'POST', `${EU}/articles`],
    ['intercom_update_article', { article_id: '39', title: 'Refunds' }, 'PUT', `${EU}/articles/39`],
    ['intercom_delete_article', { article_id: '39' }, 'DELETE', `${EU}/articles/39`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'Intercom-Version': '2.16' }),
      }),
    );
  });

  it('pages list tools with per_page 20 by default and the cursor or page number', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_list_contacts', { starting_after: 'WzE3MDc5MzAwODEwMDAsMTMxLDJd' });
    expect(sent().params).toEqual({ per_page: 20, starting_after: 'WzE3MDc5MzAwODEwMDAsMTMxLDJd' });
    mockedAxios.mockClear();
    await call('intercom_list_conversations', {});
    expect(sent().params).toEqual({ per_page: 20 });
    mockedAxios.mockClear();
    await call('intercom_list_companies', { name: 'Acme', page: 2 });
    expect(sent().params).toEqual({ name: 'Acme', page: 2, per_page: 20 });
    mockedAxios.mockClear();
    await call('intercom_list_articles', { page: 3, per_page: 50 });
    expect(sent().params).toEqual({ page: 3, per_page: 50 });
    mockedAxios.mockClear();
    await call('intercom_search_articles', { phrase: 'refund', state: 'published', highlight: true });
    expect(sent().params).toEqual({ phrase: 'refund', state: 'published', highlight: true });
    mockedAxios.mockClear();
    await call('intercom_list_data_attributes', { model: 'contact' });
    expect(sent().params).toEqual({ model: 'contact' });
  });

  it('searches with the query and the pagination inside the body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const query = { operator: 'AND', value: [{ field: 'email', operator: '~', value: 'example.com' }] };
    await call('intercom_search_contacts', { query, sort: { field: 'created_at', order: 'ascending' }, per_page: 50, starting_after: 'abc' });
    expect(sent().data).toEqual({ query, pagination: { per_page: 50, starting_after: 'abc' }, sort: { field: 'created_at', order: 'ascending' } });
    expect(sent().params).toBeUndefined();
    for (const name of ['intercom_search_conversations', 'intercom_search_tickets']) {
      mockedAxios.mockClear();
      await call(name, { query: { field: 'open', operator: '=', value: true } });
      expect(sent().data).toEqual({ query: { field: 'open', operator: '=', value: true }, pagination: { per_page: 20 } });
    }
  });

  it('creates and updates contacts and companies with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_create_contact', { role: 'lead', email: 'ana@example.com', name: 'Ana', custom_attributes: { plan: 'pro' } });
    expect(sent().data).toEqual({ role: 'lead', email: 'ana@example.com', name: 'Ana', custom_attributes: { plan: 'pro' } });
    mockedAxios.mockClear();
    await call('intercom_update_contact', { contact_id: C, phone: '+4930123456', unsubscribed_from_emails: false });
    expect(sent().data).toEqual({ phone: '+4930123456', unsubscribed_from_emails: false });
    mockedAxios.mockClear();
    await call('intercom_create_or_update_company', { company_id: 'acme-1', name: 'Acme', size: 40 });
    expect(sent().data).toEqual({ company_id: 'acme-1', name: 'Acme', size: 40 });
    mockedAxios.mockClear();
    await call('intercom_attach_contact_to_company', { contact_id: C, company_id: 'co1' });
    expect(sent().data).toEqual({ id: 'co1' });
    mockedAxios.mockClear();
    await call('intercom_archive_contact', { contact_id: C });
    expect(sent().data).toBeUndefined();
  });

  it('tags, untags and notes with the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_create_tag', { name: 'VIP', id: '81' });
    expect(sent().data).toEqual({ name: 'VIP', id: '81' });
    mockedAxios.mockClear();
    await call('intercom_tag_contact', { contact_id: C, tag_id: '81' });
    expect(sent().data).toEqual({ id: '81' });
    mockedAxios.mockClear();
    await call('intercom_untag_contact', { contact_id: C, tag_id: '81' });
    expect(sent().data).toBeUndefined();
    mockedAxios.mockClear();
    await call('intercom_tag_conversation', { conversation_id: '1295', tag_id: '81', admin_id: '7' });
    expect(sent().data).toEqual({ id: '81', admin_id: '7' });
    mockedAxios.mockClear();
    await call('intercom_untag_conversation', { conversation_id: '1295', tag_id: '81', admin_id: '7' });
    expect(sent().data).toEqual({ admin_id: '7' });
    mockedAxios.mockClear();
    await call('intercom_add_contact_note', { contact_id: C, body: 'Called', admin_id: '7' });
    expect(sent().data).toEqual({ body: 'Called', admin_id: '7' });
  });

  it('replies as an admin, with comment for the customer and note for teammates', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_reply_to_conversation', { conversation_id: '1295', admin_id: '7', body: '<p>Hi</p>', attachment_urls: ['https://example.com/a.png'] });
    expect(sent().data).toEqual({ message_type: 'comment', type: 'admin', admin_id: '7', body: '<p>Hi</p>', attachment_urls: ['https://example.com/a.png'] });
    mockedAxios.mockClear();
    await call('intercom_add_conversation_note', { conversation_id: '1295', admin_id: '7', body: 'FYI' });
    expect(sent().data).toEqual({ message_type: 'note', type: 'admin', admin_id: '7', body: 'FYI' });
    mockedAxios.mockClear();
    await call('intercom_reply_to_ticket', { ticket_id: '631', admin_id: '7', body: 'Looking' });
    expect(sent().data).toEqual({ message_type: 'note', type: 'admin', admin_id: '7', body: 'Looking' });
    mockedAxios.mockClear();
    await call('intercom_reply_to_ticket', { ticket_id: '631', message_type: 'comment', admin_id: '7', body: 'Fixed' });
    expect(sent().data).toEqual({ message_type: 'comment', type: 'admin', admin_id: '7', body: 'Fixed' });
  });

  it('assigns, closes, snoozes and opens through the parts endpoint', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_assign_conversation', { conversation_id: '1295', admin_id: '7', assignee_type: 'team', assignee_id: '5017691' });
    expect(sent().data).toEqual({ message_type: 'assignment', type: 'team', admin_id: '7', assignee_id: '5017691' });
    mockedAxios.mockClear();
    await call('intercom_close_conversation', { conversation_id: '1295', admin_id: '7' });
    expect(sent().data).toEqual({ message_type: 'close', type: 'admin', admin_id: '7' });
    mockedAxios.mockClear();
    await call('intercom_close_conversation', { conversation_id: '1295', admin_id: '7', body: 'Bye' });
    expect(sent().data).toEqual({ message_type: 'close', type: 'admin', admin_id: '7', body: 'Bye' });
    mockedAxios.mockClear();
    await call('intercom_snooze_conversation', { conversation_id: '1295', admin_id: '7', snoozed_until: 1893456000 });
    expect(sent().data).toEqual({ message_type: 'snoozed', admin_id: '7', snoozed_until: 1893456000 });
    mockedAxios.mockClear();
    await call('intercom_open_conversation', { conversation_id: '1295', admin_id: '7' });
    expect(sent().data).toEqual({ message_type: 'open', admin_id: '7' });
    mockedAxios.mockClear();
    await call('intercom_get_conversation', { conversation_id: '1295', display_as: 'plaintext' });
    expect(sent().params).toEqual({ display_as: 'plaintext' });
  });

  it('updates tickets with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_update_ticket', { ticket_id: '631', ticket_attributes: { _default_title_: 'Login fails' }, open: false, admin_id: 7 });
    expect(sent().data).toEqual({ ticket_attributes: { _default_title_: 'Login fails' }, open: false, admin_id: 7 });
  });

  it('creates articles as drafts unless told to publish, and leaves the state alone on update', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_create_article', { title: 'Refunds', author_id: 7, body: '<p>How</p>', parent_id: 159, parent_type: 'collection' });
    expect(sent().data).toEqual({ title: 'Refunds', author_id: 7, body: '<p>How</p>', state: 'draft', parent_id: 159, parent_type: 'collection' });
    mockedAxios.mockClear();
    await call('intercom_create_article', { title: 'Refunds', author_id: 7, body_markdown: '# How', state: 'published' });
    expect(sent().data).toEqual({ title: 'Refunds', author_id: 7, body_markdown: '# How', state: 'published' });
    mockedAxios.mockClear();
    await call('intercom_update_article', { article_id: '39', description: 'Short' });
    expect(sent().data).toEqual({ description: 'Short' });
  });

  it('creates and updates collections with the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('intercom_create_collection', { name: 'Billing', description: 'Invoices', help_center_id: 79 });
    expect(sent().data).toEqual({ name: 'Billing', description: 'Invoices', help_center_id: 79 });
    mockedAxios.mockClear();
    await call('intercom_update_collection', { collection_id: '159', parent_id: '160' });
    expect(sent().data).toEqual({ parent_id: '160' });
  });
});

const TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;
const LABEL = 'AnythingMCP live spec (safe to delete)';

live('intercom adapter: live REST API', () => {
  // The engine refuses a call while any {{VAR}} the connector uses is unfilled,
  // so both variables are always set.
  const env: Record<string, string> = {
    INTERCOM_API_URL: (process.env.INTERCOM_API_URL || 'https://api.intercom.io').replace(/\/+$/, ''),
    INTERCOM_ACCESS_TOKEN: TOKEN as string,
  };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  // Calls the adapter deliberately has no tool for, used to set up and clean up test data.
  const raw = (method: string, path: string, params: Record<string, unknown> = {}, bodyMapping?: Record<string, unknown>): Promise<any> =>
    engine().execute(
      { baseUrl: env.INTERCOM_API_URL, authType: 'BEARER_TOKEN', authConfig: { token: env.INTERCOM_ACCESS_TOKEN }, headers: a.connector.headers },
      { method, path, encodePathParams: true, ...(bodyMapping ? { bodyMapping } : {}) },
      params,
    );
  const list = (answer: any, key = 'data'): any[] => (Array.isArray(answer?.[key]) ? answer[key] : []);
  let me: { id: string; name: string };

  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    me = await run('intercom_get_me');
    expect(me.id).toBeDefined();
  }, 30_000);

  it('reads the workspace: admins, teams, tags, segments and data attributes', async () => {
    const admins = list(await run('intercom_list_admins'), 'admins');
    expect(admins.map((x) => String(x.id))).toContain(String(me.id));
    expect(String((await run('intercom_get_admin', { admin_id: me.id })).id)).toBe(String(me.id));
    const teams = list(await run('intercom_list_teams'), 'teams');
    if (teams[0]) expect(String((await run('intercom_get_team', { team_id: teams[0].id })).id)).toBe(String(teams[0].id));
    expect(Array.isArray(list(await run('intercom_list_tags')))).toBe(true);
    expect(Array.isArray(list(await run('intercom_list_segments', { include_count: true }), 'segments'))).toBe(true);
    const attributes = list(await run('intercom_list_data_attributes', { model: 'contact' }));
    expect(attributes.some((x) => x.name === 'email')).toBe(true);
  }, 60_000);

  it('reads contacts, their tags, notes and companies, and companies', async () => {
    const contacts = list(await run('intercom_list_contacts', { per_page: 5 }));
    const found = await run('intercom_search_contacts', { query: { field: 'role', operator: 'IN', value: ['user', 'lead'] }, per_page: 5 });
    expect(found.type).toBe('list');
    const first = contacts[0] ?? list(found)[0];
    if (first) {
      expect((await run('intercom_get_contact', { contact_id: first.id })).id).toBe(first.id);
      expect(Array.isArray(list(await run('intercom_list_contact_tags', { contact_id: first.id })))).toBe(true);
      expect(Array.isArray(list(await run('intercom_list_contact_notes', { contact_id: first.id })))).toBe(true);
      expect(Array.isArray(list(await run('intercom_list_contact_companies', { contact_id: first.id })))).toBe(true);
      const user = contacts.find((x) => x.role === 'user' && x.external_id);
      if (user) expect((await run('intercom_find_contact_by_external_id', { external_id: user.external_id })).id).toBe(user.id);
    }
    const companies = list(await run('intercom_list_companies', { per_page: 5 }));
    if (companies[0]) {
      expect((await run('intercom_get_company', { company_id: companies[0].id })).id).toBe(companies[0].id);
      expect(Array.isArray(list(await run('intercom_list_company_contacts', { company_id: companies[0].id })))).toBe(true);
    }
  }, 90_000);

  it('reads and searches conversations', async () => {
    const conversations = list(await run('intercom_list_conversations', { per_page: 5 }), 'conversations');
    const found = await run('intercom_search_conversations', { query: { field: 'state', operator: 'IN', value: ['open', 'closed', 'snoozed'] }, per_page: 5 });
    expect(found.type).toBe('conversation.list');
    const first = conversations[0] ?? list(found, 'conversations')[0];
    if (first) {
      const one = await run('intercom_get_conversation', { conversation_id: first.id, display_as: 'plaintext' });
      expect(String(one.id)).toBe(String(first.id));
    }
  }, 60_000);

  it('reads ticket types, states and tickets (tickets may be missing from the plan)', async () => {
    // A plan without tickets answers 403; that is an API answer, not a broken tool.
    const plan = (e: { response?: { status: number } }) => {
      expect(e.response?.status).toBe(403);
      return undefined;
    };
    const types = await run('intercom_list_ticket_types').catch(plan);
    if (!types) return;
    expect(Array.isArray(list(types))).toBe(true);
    expect(Array.isArray(list(await run('intercom_list_ticket_states')))).toBe(true);
    const found = await run('intercom_search_tickets', {
      query: { operator: 'OR', value: [{ field: 'open', operator: '=', value: true }, { field: 'open', operator: '=', value: false }] },
      per_page: 5,
    });
    const first = list(found, 'tickets')[0];
    if (first) expect(String((await run('intercom_get_ticket', { ticket_id: first.id })).id)).toBe(String(first.id));
  }, 60_000);

  it('reads Help Centers, collections and articles', async () => {
    expect(Array.isArray(list(await run('intercom_list_help_centers')))).toBe(true);
    const collections = list(await run('intercom_list_collections', { per_page: 5 }));
    if (collections[0]) expect(String((await run('intercom_get_collection', { collection_id: collections[0].id })).id)).toBe(String(collections[0].id));
    const articles = list(await run('intercom_list_articles', { per_page: 5 }));
    if (articles[0]) expect(String((await run('intercom_get_article', { article_id: articles[0].id })).id)).toBe(String(articles[0].id));
    const found = await run('intercom_search_articles', { phrase: 'help', state: 'all' });
    expect(found.type).toBe('list');
  }, 60_000);

  it('a wrong token is a 401', async () => {
    const wrong = { ...env, INTERCOM_ACCESS_TOKEN: 'dG9r' + 'x'.repeat(40) + '=' };
    await expect(execute('intercom_get_me', wrong, {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);

  (process.env.INTERCOM_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test tag, lead, company and inbound conversation, works on them, and removes everything',
    async () => {
      const stamp = Date.now();
      const problems: string[] = [];
      const cleanup = (what: string) => (e: Error) => problems.push(`${what}: ${e.message}`);
      let tagId: string | undefined;
      let contactId: string | undefined;
      let companyId: string | undefined;
      let conversationId: string | undefined;
      try {
        const tag = await run('intercom_create_tag', { name: `anythingmcp-live-${stamp}` });
        tagId = String(tag.id);

        const contact = await run('intercom_create_contact', { role: 'lead', email: `anythingmcp-live-${stamp}@example.com`, name: LABEL });
        contactId = contact.id as string;
        expect(contact.role).toBe('lead');
        expect((await run('intercom_get_contact', { contact_id: contactId })).email).toBe(`anythingmcp-live-${stamp}@example.com`);
        const updated = await run('intercom_update_contact', { contact_id: contactId, name: `${LABEL} updated` });
        expect(updated.name).toBe(`${LABEL} updated`);

        await run('intercom_tag_contact', { contact_id: contactId, tag_id: tagId });
        expect(list(await run('intercom_list_contact_tags', { contact_id: contactId })).map((t) => String(t.id))).toContain(tagId);
        await run('intercom_untag_contact', { contact_id: contactId, tag_id: tagId });

        const note = await run('intercom_add_contact_note', { contact_id: contactId, body: LABEL, admin_id: me.id });
        expect(note.type).toBe('note');
        expect(list(await run('intercom_list_contact_notes', { contact_id: contactId })).length).toBeGreaterThan(0);

        const company = await run('intercom_create_or_update_company', { company_id: `anythingmcp-live-${stamp}`, name: LABEL });
        companyId = company.id as string;
        await run('intercom_attach_contact_to_company', { contact_id: contactId, company_id: companyId });
        expect(list(await run('intercom_list_contact_companies', { contact_id: contactId })).map((c) => c.id)).toContain(companyId);
        expect((await run('intercom_get_company', { company_id: companyId })).company_id).toBe(`anythingmcp-live-${stamp}`);
        await run('intercom_detach_contact_from_company', { contact_id: contactId, company_id: companyId });

        // An inbound in-app message from the test lead; no tool starts conversations.
        const message = await raw('POST', '/conversations', { lead: contactId, body: `${LABEL}: test message` }, { from: { type: 'lead', id: '$lead' }, body: '$body' });
        conversationId = String(message.conversation_id);
        await run('intercom_add_conversation_note', { conversation_id: conversationId, admin_id: me.id, body: LABEL });
        const assigned = await run('intercom_assign_conversation', { conversation_id: conversationId, admin_id: me.id, assignee_type: 'admin', assignee_id: me.id });
        expect(String(assigned.admin_assignee_id)).toBe(String(me.id));
        await run('intercom_tag_conversation', { conversation_id: conversationId, tag_id: tagId, admin_id: me.id });
        await run('intercom_untag_conversation', { conversation_id: conversationId, tag_id: tagId, admin_id: me.id });
        const snoozed = await run('intercom_snooze_conversation', { conversation_id: conversationId, admin_id: me.id, snoozed_until: Math.floor(Date.now() / 1000) + 86400 });
        expect(snoozed.state).toBe('snoozed');
        expect((await run('intercom_open_conversation', { conversation_id: conversationId, admin_id: me.id })).state).toBe('open');
        if (process.env.INTERCOM_LIVE_REPLY === '1') {
          await run('intercom_reply_to_conversation', { conversation_id: conversationId, admin_id: me.id, body: `${LABEL}: reply to the test lead` });
        }
        expect((await run('intercom_close_conversation', { conversation_id: conversationId, admin_id: me.id })).state).toBe('closed');

        expect((await run('intercom_archive_contact', { contact_id: contactId })).archived).toBe(true);
        expect((await run('intercom_unarchive_contact', { contact_id: contactId })).archived).toBe(false);
      } finally {
        if (conversationId) await raw('DELETE', '/conversations/{id}', { id: conversationId }).catch(cleanup('delete conversation'));
        if (contactId) await run('intercom_delete_contact', { contact_id: contactId }).catch(cleanup('delete contact'));
        if (companyId) await raw('DELETE', '/companies/{id}', { id: companyId }).catch(cleanup('delete company'));
        if (tagId) await raw('DELETE', '/tags/{id}', { id: tagId }).catch(cleanup('delete tag'));
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );

  (process.env.INTERCOM_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test collection with a draft article, changes both, and deletes them',
    async () => {
      const helpCenters = list(await run('intercom_list_help_centers'));
      if (!helpCenters[0]) return; // a workspace without a Help Center
      const problems: string[] = [];
      let collectionId: string | undefined;
      let articleId: string | undefined;
      try {
        const collection = await run('intercom_create_collection', { name: LABEL, help_center_id: Number(helpCenters[0].id) });
        collectionId = String(collection.id);
        const changed = await run('intercom_update_collection', { collection_id: collectionId, description: 'Created by the AnythingMCP live spec' });
        expect(changed.description).toBe('Created by the AnythingMCP live spec');
        expect(String((await run('intercom_get_collection', { collection_id: collectionId })).id)).toBe(collectionId);

        const article = await run('intercom_create_article', {
          title: LABEL,
          author_id: Number(me.id),
          body: '<p>Created by the AnythingMCP live spec.</p>',
          parent_id: Number(collectionId),
          parent_type: 'collection',
        });
        articleId = String(article.id);
        expect(article.state).toBe('draft');
        const edited = await run('intercom_update_article', { article_id: articleId, description: 'Still a draft' });
        expect(edited.state).toBe('draft');
        expect((await run('intercom_get_article', { article_id: articleId })).description).toBe('Still a draft');
      } finally {
        if (articleId) await run('intercom_delete_article', { article_id: articleId }).catch((e: Error) => problems.push(`delete article: ${e.message}`));
        if (collectionId) await run('intercom_delete_collection', { collection_id: collectionId }).catch((e: Error) => problems.push(`delete collection: ${e.message}`));
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );
});
