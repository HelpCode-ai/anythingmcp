import axios from 'axios';
import * as adapter from './affinity.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Affinity adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with one API key for both API
 *      versions, the pinned v2 version header (sent on v2 calls only), every
 *      tool's method and URL through the real RestEngine, the request bodies
 *      of the searches and writes, the response mappings against the shapes of
 *      Affinity's OpenAPI spec and v1 docs, and the read-only, write and
 *      switched-off sets.
 *
 *   2. Live: skipped unless RUN_AFFINITY_LIVE=1 and AFFINITY_API_KEY (a key
 *      from Settings, Manage Apps) are set.
 *
 *        RUN_AFFINITY_LIVE=1 AFFINITY_API_KEY=... npx jest src/adapters/intl/affinity.live.spec.ts
 *
 *      Runs every read tool and applies each tool's responseMapping the way
 *      the MCP layer does. Calls the key's permissions do not allow are
 *      accepted as 403 (or 400/404/422 for data the account does not have);
 *      a crash or a 401 is not.
 *
 *      AFFINITY_LIVE_WRITE=1 also creates a note "AnythingMCP live spec (safe
 *      to delete)" on the key owner's own person record, reads it back and
 *      deletes it again. No field value is changed.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
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

const BASE = 'https://api.affinity.co';
const VERSION = '2026-09-17';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, key: string, params: Record<string, unknown>) => {
  const env = { AFFINITY_API_KEY: key };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    // authConfig is {"token": "{{AFFINITY_API_KEY}}"} (pinned below), filled from the env var at runtime.
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { token: key }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, 'test-key-0123456789abcdef', params);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const V1_TOOLS = ['affinity_list_interactions', 'affinity_search_opportunities'];
const POST_READS = ['affinity_search_companies', 'affinity_search_list_entries', 'affinity_search_persons'];
const WRITES = [
  'affinity_create_note',
  'affinity_delete_note',
  'affinity_update_company_field',
  'affinity_update_list_entry_field',
  'affinity_update_person_field',
];
const OFF = ['affinity_delete_note'];

describe('affinity adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('affinity');
    expect(a.icon).toBe('affinity');
    expect(a.category).toBe('crm');
  });

  it('sends one API key as a Bearer token, which Affinity accepts on v1 and v2', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{AFFINITY_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/v2/auth/whoami');
    expect(a.probe.tool).toBe('affinity_whoami');
    expect(tool('affinity_whoami').parameters.required).toBeUndefined();
  });

  it('asks for the key as a secret, with a pattern', () => {
    expect(a.requiredEnvVars).toEqual(['AFFINITY_API_KEY']);
    const meta = a.envVarMeta.AFFINITY_API_KEY;
    expect(meta.kind).toBe('credential');
    expect(meta.secret).toBe(true);
    expect(meta.link).toMatch(/^https:\/\/support\.affinity\.co\//);
    const re = new RegExp(meta.pattern!);
    for (const ok of ['AbCdEf0123456789xyzAbCdEf0123456789', 'a1b2c3d4e5f6a7b8c9d0e1f2']) expect(re.test(ok)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${'a'.repeat(30)}`, `${'a'.repeat(30)} `]) expect(re.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'AFFINITY_API_KEY')!.secret).toBe(true);
  });

  it('pins the v2 API version on every v2 tool and leaves it off the v1 tools', () => {
    for (const t of a.tools) {
      const isV1 = V1_TOOLS.includes(t.name);
      expect(`${t.name}:${t.endpointMapping.path.startsWith('/v2/')}`).toBe(`${t.name}:${!isV1}`);
      expect(`${t.name}:${t.endpointMapping.headers?.['X-Affinity-Api-Version']}`).toBe(`${t.name}:${isV1 ? undefined : VERSION}`);
    }
    expect(a.instructions).toContain(`X-Affinity-Api-Version: ${VERSION}`);
  });

  it('prefixes every tool with affinity_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^affinity_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks GETs and the POST searches read-only, asks for confirmation on every write, and installs the delete switched off', () => {
    for (const t of a.tools) {
      const ro = t.endpointMapping.method === 'GET' || POST_READS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${ro}`);
    }
    for (const name of POST_READS) expect(tool(name).annotations).toEqual({ readOnlyHint: true });
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    const destructive = a.tools.filter((t) => !annotationsOf(t).readOnlyHint && annotationsOf(t).destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual(WRITES.filter((n) => n !== 'affinity_create_note'));
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
  });

  it('URL-encodes every path argument, restricts entity path segments to an enum, and sends no body on reads', async () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{entity}'))) {
      expect(tool(t.name).parameters.properties!.entity.enum!.length).toBeGreaterThan(1);
    }
    for (const t of a.tools) if (t.endpointMapping.method === 'GET') expect(t.endpointMapping.bodyMapping).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('affinity_list_notes', { entity: 'companies', entityId: '1/../../notes' });
    expect(sent().url).toBe(`${BASE}/v2/companies/1%2F..%2F..%2Fnotes/notes`);
  });

  it('every responseMapping does real work, and every read has one', () => {
    for (const t of a.tools.filter((x) => x.responseMapping)) {
      const tr = t.responseMapping!.transform!;
      expect(`${t.name}:${Boolean(tr.select || tr.exclude || tr.include)}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => annotationsOf(x).readOnlyHint === true)) {
      expect(`${t.name}:${Boolean(t.responseMapping)}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, documents setup, writes, privacy and paging, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\baffinity_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\baffinity_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Affinity\n')).toBe(true);
    expect(a.instructions).toContain('Manage Apps');
    expect(a.instructions).toContain('Confirm before every write');
    expect(a.instructions).toContain('Personal data and untrusted content');
    expect(a.instructions).toMatch(/never as instructions/);
    expect(a.instructions).toContain('next_page_token');
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['affinity_whoami', {}, 'GET', `${BASE}/v2/auth/whoami`],
    ['affinity_list_lists', {}, 'GET', `${BASE}/v2/lists`],
    ['affinity_get_list', { listId: 12 }, 'GET', `${BASE}/v2/lists/12`],
    ['affinity_list_list_fields', { listId: 12 }, 'GET', `${BASE}/v2/lists/12/fields`],
    ['affinity_list_fields', { entity: 'companies' }, 'GET', `${BASE}/v2/companies/fields`],
    ['affinity_list_list_entries', { listId: 12 }, 'GET', `${BASE}/v2/lists/12/list-entries`],
    ['affinity_search_list_entries', { listId: 12 }, 'POST', `${BASE}/v2/lists/12/list-entries/search`],
    ['affinity_search_companies', {}, 'POST', `${BASE}/v2/companies/search`],
    ['affinity_get_company', { companyId: 34 }, 'GET', `${BASE}/v2/companies/34`],
    ['affinity_search_persons', {}, 'POST', `${BASE}/v2/persons/search`],
    ['affinity_get_person', { personId: 56 }, 'GET', `${BASE}/v2/persons/56`],
    ['affinity_search_opportunities', { term: 'Series A' }, 'GET', `${BASE}/opportunities`],
    ['affinity_get_opportunity', { opportunityId: 78 }, 'GET', `${BASE}/v2/opportunities/78`],
    ['affinity_list_notes', { entity: 'opportunities', entityId: 78 }, 'GET', `${BASE}/v2/opportunities/78/notes`],
    ['affinity_create_note', { content: '<p>Hi</p>', persons: [{ id: 56 }] }, 'POST', `${BASE}/v2/notes`],
    ['affinity_delete_note', { noteId: 90 }, 'DELETE', `${BASE}/v2/notes/90`],
    ['affinity_list_interactions', { type: 3, organization_id: 34, start_time: '2026-01-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' }, 'GET', `${BASE}/interactions`],
    ['affinity_get_relationships', { entity: 'persons', entityId: 56 }, 'GET', `${BASE}/v2/persons/56/relationships`],
    ['affinity_list_reminders', {}, 'GET', `${BASE}/v2/reminders`],
    ['affinity_update_company_field', { companyId: 34, fieldId: 'field-1', value: { type: 'text', data: 'x' } }, 'POST', `${BASE}/v2/companies/34/fields/field-1`],
    ['affinity_update_person_field', { personId: 56, fieldId: 'field-2', value: { type: 'text', data: 'x' } }, 'POST', `${BASE}/v2/persons/56/fields/field-2`],
    ['affinity_update_list_entry_field', { listId: 12, listEntryId: 99, fieldId: 'field-3', value: { type: 'number', data: 5 } }, 'POST', `${BASE}/v2/lists/12/list-entries/99/fields/field-3`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the key as Bearer', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe('Bearer test-key-0123456789abcdef');
  });

  it('sends a search body only with what was given, and the paging in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('affinity_search_companies', { search: { term: 'acme' }, fieldIds: ['affinity-data-location'] });
    expect(sent().data).toEqual({ search: { term: 'acme' } });
    expect(sent().params).toEqual({ fieldIds: ['affinity-data-location'], limit: 25 });
    expect(sent().paramsSerializer(sent().params)).toBe('fieldIds=affinity-data-location&limit=25');
    expect(sent().headers['X-Affinity-Api-Version']).toBe(VERSION);
    mockedAxios.mockClear();
    const filters = { operator: 'and', filters: [{ fieldId: 'field-9', valueType: 'dropdown', operator: 'is-any-of', value: [{ dropdownOptionId: 1 }] }] };
    const sorts = [{ fieldId: 'last-contact', attributeId: 'date-of-activity', direction: 'desc' }];
    await call('affinity_search_list_entries', { listId: 12, filters, sorts, cursor: 'abc' });
    expect(sent().data).toEqual({ filters, sorts });
    expect(sent().params).toEqual({ limit: 25, cursor: 'abc' });
    mockedAxios.mockClear();
    // No criteria at all: an empty body, which Affinity treats like the plain list.
    await call('affinity_search_persons', {});
    expect(sent().data).toEqual({});
  });

  it('creates an entities note with HTML content and only the given attachments', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('affinity_create_note', { content: '<p>Call recap</p>', companies: [{ id: 34 }], opportunities: [{ id: 78 }] });
    expect(sent().data).toEqual({ type: 'entities', content: { html: '<p>Call recap</p>' }, companies: [{ id: 34 }], opportunities: [{ id: 78 }] });
    expect(tool('affinity_create_note').parameters.required).toEqual(['content']);
  });

  it('updates a field with the typed value object Affinity expects', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const value = { type: 'dropdown', data: { dropdownOptionId: 5 } };
    await call('affinity_update_list_entry_field', { listId: 12, listEntryId: 99, fieldId: 'field-3', value });
    expect(sent().data).toEqual({ value });
    mockedAxios.mockClear();
    await call('affinity_update_person_field', { personId: 56, fieldId: 'field-2', value: { type: 'text', data: null } });
    expect(sent().data).toEqual({ value: { type: 'text', data: null } });
  });

  it('sends the v1 interaction and opportunity queries with their defaults and no version header', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('affinity_list_interactions', { type: 0, person_id: 56, start_time: '2026-01-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ type: 0, person_id: 56, start_time: '2026-01-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z', page_size: 25 });
    expect(sent().headers['X-Affinity-Api-Version']).toBeUndefined();
    expect(tool('affinity_list_interactions').parameters.required).toEqual(['type', 'start_time', 'end_time']);
    mockedAxios.mockClear();
    await call('affinity_search_opportunities', { term: 'Series A', page_token: 't1' });
    expect(sent().params).toEqual({ term: 'Series A', page_size: 25, page_token: 't1' });
  });

  it('sends filters, ordering and default page sizes on the v2 lists', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('affinity_list_reminders', { filter: 'status=overdue' });
    expect(sent().params).toEqual({ filter: 'status=overdue', limit: 25 });
    mockedAxios.mockClear();
    await call('affinity_get_relationships', { entity: 'companies', entityId: 34, filter: 'interactionScore>=0.5' });
    expect(sent().params).toEqual({ filter: 'interactionScore>=0.5', limit: 20 });
    mockedAxios.mockClear();
    await call('affinity_list_list_entries', { listId: 12, fieldTypes: ['list'] });
    expect(sent().params).toEqual({ fieldTypes: ['list'], limit: 25 });
  });

  // Shapes from the examples in Affinity's OpenAPI spec (version 2026-09-17) and v1 docs.
  it('shapes whoami, lists and list entries', () => {
    const who = shape('affinity_whoami', {
      tenant: { id: 1, name: 'Northpoint VC', subdomain: 'northpoint.affinity.co' },
      user: { id: 7, firstName: 'Jane', lastName: 'Smith', emailAddress: 'jane@northpoint.vc' },
      grant: { type: 'api-key', scopes: ['api'], createdAt: '2026-01-01T00:00:00Z' },
    }).value;
    expect(who).toEqual({
      tenant: { id: 1, name: 'Northpoint VC', subdomain: 'northpoint.affinity.co' },
      user: { id: 7, firstName: 'Jane', lastName: 'Smith', emailAddress: 'jane@northpoint.vc' },
      grantType: 'api-key',
      scopes: ['api'],
    });
    const entries = shape('affinity_list_list_entries', {
      data: [
        {
          id: 1, type: 'company', listId: 12, createdAt: '2023-01-01T00:00:00Z', creatorId: 7,
          entity: {
            id: 34, name: 'Horizon Technologies', domain: 'horizontech.com', domains: ['horizontech.com'], isGlobal: true,
            fields: [{ id: 'field-3', name: 'Stage', type: 'list', enrichmentSource: null, value: { type: 'dropdown', data: { dropdownOptionId: 5, text: 'Due Diligence' } } }],
          },
        },
      ],
      pagination: { prevUrl: null, nextUrl: 'https://api.affinity.co/v2/lists/12/list-entries?cursor=ICAgICAgIGFmdGVyOjo6NA' },
    }).value as any;
    expect(entries).toEqual({
      data: [
        {
          id: 1, type: 'company', listId: 12, createdAt: '2023-01-01T00:00:00Z', creatorId: 7,
          entity: { id: 34, name: 'Horizon Technologies', domain: 'horizontech.com', fields: [{ id: 'field-3', name: 'Stage', value: { type: 'dropdown', data: { dropdownOptionId: 5, text: 'Due Diligence' } } }] },
        },
      ],
      nextUrl: 'https://api.affinity.co/v2/lists/12/list-entries?cursor=ICAgICAgIGFmdGVyOjo6NA',
    });
  });

  it('shapes companies, persons and opportunities', () => {
    const company = { id: 34, name: 'Horizon', domain: 'horizon.com', domains: ['horizon.com'], isGlobal: false, fields: [{ id: 'affinity-data-location', name: 'Location', type: 'enriched', enrichmentSource: 'affinity-data', value: { type: 'location', data: { city: 'Berlin' } } }] };
    expect(shape('affinity_get_company', company).value).toEqual({ ...company, fields: [{ id: 'affinity-data-location', name: 'Location', type: 'enriched', value: { type: 'location', data: { city: 'Berlin' } } }] });
    const found = shape('affinity_search_companies', { data: [company], pagination: { nextUrl: null, totalCount: 1 } }).value as any;
    expect(found.data[0].name).toBe('Horizon');
    expect(found.totalCount).toBe(1);
    const person = { id: 56, firstName: 'Ana', lastName: 'Lopez', primaryEmailAddress: 'ana@horizon.com', emailAddresses: ['ana@horizon.com'], type: 'external', fields: [] };
    expect(shape('affinity_get_person', person).value).toEqual(person);
    expect((shape('affinity_search_persons', { data: [person], pagination: { nextUrl: null } }).value as any).data).toEqual([person]);
    expect(shape('affinity_get_opportunity', { id: 78, name: 'Horizon Series A', listId: 3, listName: 'Pipeline', isRestricted: false, isRedacted: false }).value).toEqual({ id: 78, name: 'Horizon Series A', listId: 3, listName: 'Pipeline', isRestricted: false, isRedacted: false });
    const opps = shape('affinity_search_opportunities', {
      opportunities: [{ id: 121, name: 'Affinity Opportunity', person_ids: [3526824], organization_ids: [128367168], list_entries: [{ id: 442313, creator_id: 1124736, list_id: 4974, entity_id: 121, entity_type: 8, created_at: '2018-03-03T23:02:46.412-08:00' }] }],
      next_page_token: 'eyJwYXJhbXMiOnt9fQ',
    }).value;
    expect(opps).toEqual({
      opportunities: [{ id: 121, name: 'Affinity Opportunity', person_ids: [3526824], organization_ids: [128367168], list_entries: [{ id: 442313, list_id: 4974, created_at: '2018-03-03T23:02:46.412-08:00' }] }],
      next_page_token: 'eyJwYXJhbXMiOnt9fQ',
    });
  });

  it('shapes notes, relationships, reminders and the created note', () => {
    const note = {
      id: 1, type: 'entities', content: { html: '<p>This is a note!</p>' },
      creator: { id: 1, firstName: 'Jane', lastName: 'Smith', primaryEmailAddress: 'jane.smith@northpointvc.com', type: 'internal' },
      mentions: [], createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-21T00:00:00Z',
    };
    expect(shape('affinity_list_notes', { data: [note], pagination: { nextUrl: null } }).value).toEqual({
      data: [{ id: 1, type: 'entities', content: '<p>This is a note!</p>', creator: { id: 1, firstName: 'Jane', lastName: 'Smith' }, createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-21T00:00:00Z' }],
      nextUrl: null,
    });
    expect(shape('affinity_create_note', note).value).toEqual({ id: 1, type: 'entities', content: '<p>This is a note!</p>', createdAt: '2023-01-01T00:00:00Z', creator: { id: 1, firstName: 'Jane', lastName: 'Smith' } });
    const p1 = { id: 7, firstName: 'Jane', lastName: 'Smith', primaryEmailAddress: 'jane@northpoint.vc' };
    const p2 = { id: 56, firstName: 'Ana', lastName: 'Lopez', primaryEmailAddress: 'ana@horizon.com' };
    expect(shape('affinity_get_relationships', { data: [{ person1: p1, person2: p2, interactionScore: 0.82, linkedIn: null }], pagination: {} }).value).toEqual({
      data: [{ person1: p1, person2: p2, interactionScore: 0.82, linkedIn: null }],
    });
    const reminder = {
      id: 1, type: 'one-time', status: 'active', content: 'Follow up about the funding round', dueDate: '2026-06-01T17:00:00Z', completedAt: null, recurrence: null,
      creator: { id: 7 }, owner: { id: 7 }, completer: null, company: { id: 34 }, person: null, opportunity: null, createdAt: '2026-05-01T00:00:00Z', updatedAt: null,
    };
    const { completer: _c, updatedAt: _u, ...kept } = reminder;
    expect(shape('affinity_list_reminders', { data: [reminder], pagination: { nextUrl: null } }).value).toEqual({ data: [kept], nextUrl: null });
  });

  it('drops the repeated address lists from v1 interactions and keeps every interaction kind', () => {
    const someone = (id: number) => ({ id, type: 0, first_name: 'A', last_name: 'B', primary_email: 'a@b.co', emails: ['a@b.co', 'a2@b.co'] });
    const out = shape('affinity_list_interactions', {
      emails: [{ date: '2021-02-04T09:43:39.717-08:00', id: 417, subject: 'John <-> Alice', type: 3, from: someone(443), to: [someone(2021)], cc: [someone(5)], direction: 0 }],
      next_page_token: 'tok',
    }).value as any;
    expect(out.next_page_token).toBe('tok');
    expect(out.emails[0].subject).toBe('John <-> Alice');
    expect(out.emails[0].from.emails).toBeUndefined();
    expect(out.emails[0].to[0].emails).toBeUndefined();
    expect(out.emails[0].to[0].primary_email).toBe('a@b.co');
    const events = shape('affinity_list_interactions', { events: [{ id: 3007, title: 'Manually logged event', type: 0, attendees: ['john@affinity.co'], persons: [someone(443)], notes: [7] }] }).value as any;
    expect(events.events[0].title).toBe('Manually logged event');
    expect(events.events[0].persons[0].emails).toBeUndefined();
    const chats = shape('affinity_list_interactions', { chat_messages: [{ id: 7267, type: 2, direction: 0, persons: [someone(443)], notes: [] }] }).value as any;
    expect(chats.chat_messages[0].persons[0].emails).toBeUndefined();
  });
});

const KEY = process.env.AFFINITY_API_KEY;
const live = process.env.RUN_AFFINITY_LIVE === '1' && KEY ? describe : describe.skip;

type Refused = { refused: number; message?: unknown };
const isRefused = (x: unknown): x is Refused => typeof x === 'object' && x !== null && 'refused' in x;

live('affinity adapter: live REST API', () => {
  const write = process.env.AFFINITY_LIVE_WRITE === '1';
  const key = KEY || '';

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, key, params), tool(name).responseMapping as never).value;
  // A call the key's permissions or the account's data do not allow comes back
  // as 400, 403, 404 or 422; that is an answer, not a broken tool.
  const maybe = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    run(name, params).catch((e: { response?: { status: number; data?: unknown } }) => {
      const status = e.response?.status;
      if (status && [400, 403, 404, 422].includes(status)) return { refused: status, message: e.response?.data } as Refused;
      throw e;
    });
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('reads who the key belongs to', async () => {
    const me = await run('affinity_whoami');
    expect(typeof me.user.id).toBe('number');
    expect(typeof me.tenant.name).toBe('string');
  }, 30_000);

  it('lists lists, a list with its fields and entries, and searches the entries', async () => {
    const lists = await run('affinity_list_lists', { limit: 5 });
    expect(Array.isArray(lists.data)).toBe(true);
    const first = lists.data[0];
    if (!first) return;
    const one = await run('affinity_get_list', { listId: first.id });
    expect(one.id).toBe(first.id);
    const fields = await run('affinity_list_list_fields', { listId: first.id });
    expect(Array.isArray(fields.data)).toBe(true);
    const entries = await maybe('affinity_list_list_entries', { listId: first.id, limit: 3, fieldTypes: ['list'] });
    if (!isRefused(entries)) expect(Array.isArray(entries.data)).toBe(true);
    const search = await maybe('affinity_search_list_entries', { listId: first.id, limit: 3 });
    if (!isRefused(search)) expect(Array.isArray(search.data)).toBe(true);
  }, 90_000);

  it('reads field metadata, searches companies and persons and reads one of each with their relationships and notes', async () => {
    for (const entity of ['companies', 'persons']) {
      const f = await run('affinity_list_fields', { entity, limit: 10 });
      expect(Array.isArray(f.data)).toBe(true);
    }
    const companies = await maybe('affinity_search_companies', { limit: 3 });
    if (!isRefused(companies)) {
      expect(Array.isArray(companies.data)).toBe(true);
      const c = companies.data[0];
      if (c) {
        const term = String(c.name).slice(0, 5);
        if (term.length >= 3) {
          const byName = await run('affinity_search_companies', { search: { term }, limit: 5 });
          expect(Array.isArray(byName.data)).toBe(true);
        }
        const one = await run('affinity_get_company', { companyId: c.id, fieldTypes: ['relationship-intelligence'] });
        expect(one.id).toBe(c.id);
        const rel = await maybe('affinity_get_relationships', { entity: 'companies', entityId: c.id, limit: 3 });
        if (!isRefused(rel)) expect(Array.isArray(rel.data)).toBe(true);
        const notes = await maybe('affinity_list_notes', { entity: 'companies', entityId: c.id, limit: 3 });
        if (!isRefused(notes)) expect(Array.isArray(notes.data)).toBe(true);
        const mails = await maybe('affinity_list_interactions', { type: 3, organization_id: c.id, start_time: iso(-360), end_time: iso(0), page_size: 3 });
        if (!isRefused(mails)) expect(Array.isArray(mails.emails ?? [])).toBe(true);
        const meetings = await maybe('affinity_list_interactions', { type: 0, organization_id: c.id, start_time: iso(-360), end_time: iso(0), page_size: 3 });
        if (!isRefused(meetings)) expect(Array.isArray(meetings.events ?? [])).toBe(true);
      }
    }
    const persons = await maybe('affinity_search_persons', { limit: 3 });
    if (!isRefused(persons)) {
      expect(Array.isArray(persons.data)).toBe(true);
      const p = persons.data[0];
      if (p) {
        const one = await run('affinity_get_person', { personId: p.id });
        expect(one.id).toBe(p.id);
        const rel = await maybe('affinity_get_relationships', { entity: 'persons', entityId: p.id, limit: 3 });
        if (!isRefused(rel)) expect(Array.isArray(rel.data)).toBe(true);
      }
    }
  }, 120_000);

  it('searches opportunities and reads one with its notes, and lists reminders', async () => {
    const opps = await maybe('affinity_search_opportunities', { page_size: 3 });
    if (!isRefused(opps)) {
      expect(Array.isArray(opps.opportunities)).toBe(true);
      const o = opps.opportunities[0];
      if (o) {
        const one = await run('affinity_get_opportunity', { opportunityId: o.id });
        expect(one.id).toBe(o.id);
        const notes = await maybe('affinity_list_notes', { entity: 'opportunities', entityId: o.id, limit: 3 });
        if (!isRefused(notes)) expect(Array.isArray(notes.data)).toBe(true);
      }
    }
    const reminders = await maybe('affinity_list_reminders', { limit: 5 });
    if (!isRefused(reminders)) expect(Array.isArray(reminders.data)).toBe(true);
  }, 90_000);

  (write ? it : it.skip)('creates a note on the key owner, reads it back and deletes it', async () => {
    const me = await run('affinity_whoami');
    const created = await run('affinity_create_note', {
      content: '<p>AnythingMCP live spec (safe to delete)</p>',
      persons: [{ id: me.user.id }],
    });
    expect(typeof created.id).toBe('number');
    try {
      const notes = await run('affinity_list_notes', { entity: 'persons', entityId: me.user.id, limit: 20 });
      expect(notes.data.map((n: { id: number }) => n.id)).toContain(created.id);
    } finally {
      await execute('affinity_delete_note', key, { noteId: created.id });
    }
  }, 90_000);

  it('a wrong key is a 401 on v2 and on v1', async () => {
    await expect(execute('affinity_whoami', 'wrong-key-0123456789abcdef', {})).rejects.toMatchObject({ response: { status: 401 } });
    await expect(execute('affinity_search_opportunities', 'wrong-key-0123456789abcdef', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
