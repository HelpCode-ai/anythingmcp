import axios from 'axios';
import * as adapter from './google-contacts.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Contacts (People API) adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, the contacts and contacts.other.readonly scopes, the
 *      field masks every People call needs, the warm-up request with an
 *      empty query that Google asks for before searching, the etag and
 *      updatePersonFields of an update, the per-entry metadata stripped from
 *      answers, and that deleting installs switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (contacts.readonly and
 *      contacts.other.readonly for reads, contacts for the write round-trip):
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-contacts.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP Test" contact and
 *      label are created, updated, linked and read back, and both are deleted
 *      in `finally`.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
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
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
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
const shaped = (name: string, raw: unknown): any => applyResponseTransform(raw, tool(name).responseMapping).value;

const BASE = 'https://people.googleapis.com/v1';
const WARM_UP = 'google_contacts_warm_up_search';
const READS = [
  'google_contacts_get_contact',
  'google_contacts_get_contact_group',
  'google_contacts_list_contact_groups',
  'google_contacts_list_contacts',
  'google_contacts_list_other_contacts',
  'google_contacts_search_contacts',
  'google_contacts_search_other_contacts',
  WARM_UP,
];
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

const meta = { primary: true, source: { type: 'CONTACT', id: '1a' } };
// A person as People API returns it: every entry carries its own metadata.
const PERSON = {
  resourceName: 'people/c1',
  etag: '%EgUBAi43PRoEAQIFByIMR',
  metadata: { sources: [{ type: 'CONTACT', id: '1a', etag: '#abc' }], objectType: 'PERSON' },
  names: [{ metadata: meta, displayName: 'Ana García', givenName: 'Ana', familyName: 'García' }],
  emailAddresses: [{ metadata: meta, value: 'ana@example.com', type: 'work', formattedType: 'Work' }],
  memberships: [{ metadata: { source: { type: 'CONTACT', id: '1a' } }, contactGroupMembership: { contactGroupId: 'myContacts', contactGroupResourceName: 'contactGroups/myContacts' } }],
};
const LEAN = {
  resourceName: 'people/c1',
  etag: '%EgUBAi43PRoEAQIFByIMR',
  metadata: PERSON.metadata,
  names: [{ displayName: 'Ana García', givenName: 'Ana', familyName: 'García' }],
  emailAddresses: [{ value: 'ana@example.com', type: 'work', formattedType: 'Work' }],
  memberships: [{ contactGroupMembership: { contactGroupId: 'myContacts', contactGroupResourceName: 'contactGroups/myContacts' } }],
};

describe('google-contacts adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real Google account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and the contacts scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/contacts.other.readonly',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('enable **Google People API**');
    expect(a.instructions).toMatch(/read-only setup[^\n]*contacts\.readonly/);
  });

  it('probes by listing one contact, which works for any account', () => {
    expect(a.probe).toEqual({ tool: 'google_contacts_list_contacts', params: { page_size: 1 } });
    expect(tool('google_contacts_list_contacts').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/people/me/connections?personFields=names&pageSize=1');
  });

  it('prefixes every tool with google_contacts_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_contacts_[a-z_]+$/);
    for (const metaAdapter of listAdapters()) {
      if (metaAdapter.slug === a.slug) continue;
      for (const t of getAdapter(metaAdapter.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids placed in the path; only the warm-up picks one of two fixed endpoints', () => {
    for (const t of a.tools) {
      if (t.name === WARM_UP) continue;
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    expect(tool(WARM_UP).endpointMapping).toMatchObject({ method: 'GET', path: '/{search}' });
    expect(tool(WARM_UP).parameters.properties!.search.enum).toEqual(['people:searchContacts', 'otherContacts:search']);
  });

  it('installs only deleting a contact switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['google_contacts_delete_contact']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `google_contacts_delete_contact`/);
    expect(annotationsOf(tool('google_contacts_delete_contact')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('google_contacts_update_contact')).destructiveHint).toBe(true);
  });

  it('marks the reads read-only and asks for confirmation before every write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READS);
    for (const t of a.tools) {
      if (READS.includes(t.name)) continue;
      expect(`${t.name}: ${t.description}`).toMatch(/[Cc]onfirm (the change )?with the user|get a yes/);
    }
    expect(annotationsOf(tool('google_contacts_modify_group_members'))).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_contacts_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_contacts_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['google_contacts_list_contacts', {}, 'GET', '/people/me/connections'],
    ['google_contacts_get_contact', { person_id: 'c/1' }, 'GET', '/people/c%2F1'],
    ['google_contacts_search_contacts', { query: 'ana' }, 'GET', '/people:searchContacts'],
    [WARM_UP, {}, 'GET', '/people:searchContacts'],
    [WARM_UP, { search: 'otherContacts:search' }, 'GET', '/otherContacts:search'],
    ['google_contacts_create_contact', { names: [{ givenName: 'Ana' }] }, 'POST', '/people:createContact'],
    ['google_contacts_update_contact', { person_id: 'c1', etag: 'e', update_person_fields: 'names' }, 'PATCH', '/people/c1:updateContact'],
    ['google_contacts_delete_contact', { person_id: 'c1' }, 'DELETE', '/people/c1:deleteContact'],
    ['google_contacts_list_contact_groups', {}, 'GET', '/contactGroups'],
    ['google_contacts_get_contact_group', { group_id: 'myContacts' }, 'GET', '/contactGroups/myContacts'],
    ['google_contacts_create_contact_group', { name: 'Kunden' }, 'POST', '/contactGroups'],
    ['google_contacts_modify_group_members', { group_id: 'g1' }, 'POST', '/contactGroups/g1/members:modify'],
    ['google_contacts_list_other_contacts', {}, 'GET', '/otherContacts'],
    ['google_contacts_search_other_contacts', { query: 'ana' }, 'GET', '/otherContacts:search'],
    ['google_contacts_save_other_contact', { other_contact_id: 'c9' }, 'POST', '/otherContacts/c9:copyOtherContactToMyContactsGroup'],
  ])('%s sends %s to the right People API URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('always sends the field mask People API requires', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const params = async (name: string, args: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, args);
      return sent().params;
    };
    expect(await params('google_contacts_list_contacts', {})).toEqual({ personFields: 'names,emailAddresses,phoneNumbers,organizations', pageSize: 100 });
    expect(await params('google_contacts_list_contacts', { sort_order: 'LAST_MODIFIED_DESCENDING', page_token: 't' })).toMatchObject({
      sortOrder: 'LAST_MODIFIED_DESCENDING',
      pageToken: 't',
    });
    expect((await params('google_contacts_get_contact', { person_id: 'c1' })).personFields).toContain('memberships');
    expect(await params('google_contacts_search_contacts', { query: 'acme' })).toEqual({
      query: 'acme',
      readMask: 'names,emailAddresses,phoneNumbers,organizations',
      pageSize: 10,
    });
    expect(await params('google_contacts_list_other_contacts', {})).toEqual({ readMask: 'names,emailAddresses,phoneNumbers', pageSize: 100 });
    expect(await params('google_contacts_search_other_contacts', { query: 'bo' })).toEqual({
      query: 'bo',
      readMask: 'names,emailAddresses,phoneNumbers',
      pageSize: 10,
    });
    expect(await params('google_contacts_get_contact_group', { group_id: 'g1' })).toEqual({ maxMembers: 200, groupFields: 'name,groupType,memberCount' });
  });

  it('warms the search cache up with the empty query Google asks for', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(WARM_UP, {});
    expect(sent().params).toEqual({ query: '', readMask: 'names' });
    expect(sent().paramsSerializer(sent().params)).toBe('query=&readMask=names');
  });

  it('creates a contact from People API lists and leaves out what was not given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_contacts_create_contact', {
      names: [{ givenName: 'Ana', familyName: 'García' }],
      email_addresses: [{ value: 'ana@example.com', type: 'work' }],
      phone_numbers: [{ value: '+49 761 1234567', type: 'mobile' }],
    });
    expect(sent().data).toEqual({
      names: [{ givenName: 'Ana', familyName: 'García' }],
      emailAddresses: [{ value: 'ana@example.com', type: 'work' }],
      phoneNumbers: [{ value: '+49 761 1234567', type: 'mobile' }],
    });
    expect(sent().params.personFields).toContain('emailAddresses');
  });

  it('updates with the etag and the fields to replace', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_contacts_update_contact', {
      person_id: 'c1',
      etag: '%Eg',
      update_person_fields: 'phoneNumbers',
      phone_numbers: [{ value: '+49 1' }, { value: '+49 2' }],
    });
    expect(sent().params).toMatchObject({ updatePersonFields: 'phoneNumbers' });
    expect(sent().data).toEqual({ etag: '%Eg', phoneNumbers: [{ value: '+49 1' }, { value: '+49 2' }] });
    expect(tool('google_contacts_update_contact').parameters.required).toEqual(['person_id', 'etag', 'update_person_fields']);
  });

  it('adds and removes group members and creates labels', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_contacts_modify_group_members', { group_id: 'g1', add: ['people/c1'], remove: ['people/c2'] });
    expect(sent().data).toEqual({ resourceNamesToAdd: ['people/c1'], resourceNamesToRemove: ['people/c2'] });
    mockedAxios.mockClear();
    await call('google_contacts_create_contact_group', { name: 'Kunden' });
    expect(sent().data).toEqual({ contactGroup: { name: 'Kunden' } });
    mockedAxios.mockClear();
    await call('google_contacts_save_other_contact', { other_contact_id: 'c9' });
    expect(sent().data).toEqual({ copyMask: 'names,emailAddresses,phoneNumbers', readMask: 'names,emailAddresses,phoneNumbers' });
  });

  it("strips Google's per-entry metadata from every person it returns, and nothing else", () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['google_contacts_get_contact', PERSON, LEAN],
      ['google_contacts_create_contact', PERSON, LEAN],
      ['google_contacts_update_contact', PERSON, LEAN],
      ['google_contacts_save_other_contact', PERSON, LEAN],
      ['google_contacts_list_contacts', { connections: [PERSON], totalItems: 1, nextPageToken: 'n' }, { connections: [LEAN], totalItems: 1, nextPageToken: 'n' }],
      ['google_contacts_search_contacts', { results: [{ person: PERSON }] }, { results: [{ person: LEAN }] }],
      ['google_contacts_list_other_contacts', { otherContacts: [PERSON], totalSize: 1 }, { otherContacts: [LEAN], totalSize: 1 }],
      ['google_contacts_search_other_contacts', { results: [{ person: PERSON }] }, { results: [{ person: LEAN }] }],
    ];
    for (const [name, raw, expected] of cases) {
      expect(validateTransform(tool(name).responseMapping!.transform)).toBeNull();
      expect([name, shaped(name, raw)]).toEqual([name, expected]);
    }
    // An empty answer stays empty.
    expect(shaped('google_contacts_list_contacts', {})).toEqual({});
    expect(shaped('google_contacts_search_contacts', {})).toEqual({});
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-contacts adapter: live People API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const exec = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
  const read = async (name: string, params: Record<string, unknown> = {}) => shaped(name, await exec(name, params));

  it('runs the probe, warms up and searches, and lists groups and other contacts', async () => {
    const page = await read(a.probe.tool, a.probe.params);
    expect(typeof page).toBe('object');
    await exec(WARM_UP);
    const groups = await exec('google_contacts_list_contact_groups');
    expect(groups.contactGroups.some((g: any) => g.resourceName === 'contactGroups/myContacts')).toBe(true);
    const mine = await exec('google_contacts_get_contact_group', { group_id: 'myContacts', max_members: 1 });
    expect(mine.resourceName).toBe('contactGroups/myContacts');
    if (page.connections?.length) {
      const first = page.connections[0];
      const one = await read('google_contacts_get_contact', { person_id: first.resourceName.replace('people/', '') });
      expect(one.resourceName).toBe(first.resourceName);
      expect(typeof one.etag).toBe('string');
      const name = first.names?.[0]?.givenName;
      if (name) {
        const found = await read('google_contacts_search_contacts', { query: name });
        expect(Array.isArray(found.results ?? [])).toBe(true);
      }
    }
    await exec(WARM_UP, { search: 'otherContacts:search' });
    const others = await read('google_contacts_list_other_contacts', { page_size: 5 });
    expect(typeof others).toBe('object');
    await read('google_contacts_search_other_contacts', { query: 'a' });
  }, 60_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates, updates, labels and deletes a test contact',
    async () => {
      const created = await read('google_contacts_create_contact', {
        names: [{ givenName: 'AnythingMCP', familyName: `Test ${Date.now()}` }],
        email_addresses: [{ value: 'amcp-test@example.com', type: 'work' }],
        biographies: [{ value: 'Grüße, perché 👋', contentType: 'TEXT_PLAIN' }],
      });
      const personId = (created.resourceName as string).replace('people/', '');
      let groupResource: string | undefined;
      try {
        expect(created.emailAddresses[0]).not.toHaveProperty('metadata');
        const updated = await read('google_contacts_update_contact', {
          person_id: personId,
          etag: created.etag,
          update_person_fields: 'phoneNumbers,organizations',
          phone_numbers: [{ value: '+49 761 0000000', type: 'mobile' }],
          organizations: [{ name: 'AnythingMCP', title: 'Test' }],
        });
        expect(updated.phoneNumbers[0].value).toBe('+49 761 0000000');
        expect(updated.biographies[0].value).toBe('Grüße, perché 👋');
        const group = await exec('google_contacts_create_contact_group', { name: `AnythingMCP test ${Date.now()}` });
        groupResource = group.resourceName as string;
        const groupId = groupResource.replace('contactGroups/', '');
        const modified = await exec('google_contacts_modify_group_members', { group_id: groupId, add: [created.resourceName] });
        expect(modified.notFoundResourceNames ?? []).toEqual([]);
        const read2 = await read('google_contacts_get_contact', { person_id: personId });
        expect(read2.memberships.map((m: any) => m.contactGroupMembership?.contactGroupResourceName)).toContain(groupResource);
        await exec('google_contacts_modify_group_members', { group_id: groupId, remove: [created.resourceName] });
      } finally {
        await exec('google_contacts_delete_contact', { person_id: personId }).catch(() =>
          console.warn(`Could not delete test contact people/${personId}: delete it by hand.`),
        );
        if (groupResource) {
          await engine()
            .execute(bearer(), { method: 'DELETE', path: '/contactGroups/{id}', encodePathParams: true }, { id: groupResource.replace('contactGroups/', '') })
            .catch(() => console.warn(`Could not delete test label ${groupResource}: delete it by hand.`));
        }
      }
    },
    90_000,
  );
});
