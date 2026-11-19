import axios from 'axios';
import { buildClientSchema, getIntrospectionQuery, Kind, OperationDefinitionNode, parse, validate } from 'graphql';
import * as adapter from './hero-software.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * HERO Software adapter (external GraphQL API v7).
 *
 * Static checks always run: Bearer auth on the v7 endpoint, every operation
 * parses, its variables match the tool's queryParams one to one, each request
 * goes through the real GraphqlEngine with the documented variables, only the
 * four create and save tools write, nothing deletes, and the generic mutation
 * helper installs switched off. Every operation was validated on 19 Nov 2026
 * against an introspection result of the v7 schema (PartnerQuery and
 * PartnerMutation); the schema itself needs a key, so that check is repeated
 * here only in the live block.
 * https://hero-software.de/api-doku/graphql-guide
 *
 * Live checks run only with RUN_HERO_SOFTWARE_LIVE=1. Without a key they
 * confirm that a wrong key is answered with 403 invalid_token. With
 * HERO_API_TOKEN they validate every operation against the live schema and
 * read the account, contacts, projects and documents. Nothing is written.
 *
 *   RUN_HERO_SOFTWARE_LIVE=1 HERO_API_TOKEN=... \
 *     npx jest src/adapters/de/hero-software.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const post = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(Object.create(actual.default), actual.default, { post, __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedPost = (axios as unknown as { post: jest.Mock }).post;
const actualAxios = (axios as unknown as { __actual: typeof axios }).__actual;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    config: { graphqlBuiltinsOff: string[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const operation = (entry: Tool) =>
  parse(entry.endpointMapping.path).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)!;
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'GRAPHQL', endpointMapping: entry.endpointMapping, annotations: entry.annotations });

const URL = 'https://login.hero-software.de/api/external/v7/graphql';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['test', 'hero', 'key', '0'.repeat(16)].join('-');
const ENV: Record<string, string> = { HERO_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools for a GraphQL connector.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new GraphqlEngine({} as OAuth2TokenService, {} as LoginTokenService, {} as GraphqlSchemaService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    },
    endpointMapping as any,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};

const WRITES = [
  'hero_software_add_logbook_entry',
  'hero_software_create_contact',
  'hero_software_create_project',
  'hero_software_save_task',
];

describe('hero-software adapter: static contract', () => {
  beforeEach(() => mockedPost.mockReset());

  it('posts to the v7 GraphQL endpoint with the API key as Bearer', () => {
    expect(a.slug).toBe('hero-software');
    expect(a.region).toBe('de');
    expect(a.category).toBe('field-service');
    expect(a.icon).toBe('hero-software');
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe(URL);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{HERO_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['HERO_API_TOKEN']);
    expect(a.envVarMeta.HERO_API_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.HERO_API_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short']) expect(pattern.test(bad)).toBe(false);
  });

  it('probes the account query and explains a refused key', () => {
    expect(a.probe.tool).toBe('hero_software_get_account');
    expect(tool('hero_software_get_account').endpointMapping.method).toBe('query');
    for (const key of ['401', '403', 'invalid_token', 'auth_failed', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^hero_software_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
  });

  it('every operation parses, matches its method, and maps each variable to a parameter', () => {
    for (const entry of a.tools) {
      const op = operation(entry);
      expect(`${entry.name}:${op.operation}`).toBe(`${entry.name}:${entry.endpointMapping.method}`);
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      expect(`${entry.name}:${Object.keys(entry.endpointMapping.queryParams ?? {}).sort()}`).toBe(`${entry.name}:${declared}`);
      const properties = Object.keys(entry.parameters.properties ?? {});
      for (const value of Object.values(entry.endpointMapping.queryParams ?? {})) expect(properties).toContain(value.slice(1));
      for (const property of properties) expect(Object.values(entry.endpointMapping.queryParams ?? {})).toContain(`$${property}`);
      for (const required of entry.parameters.required ?? []) expect(properties).toContain(required);
    }
  });

  it('only the create and save tools write, nothing deletes, and no tool is switched off', () => {
    const writes = a.tools.filter((entry) => annotationsOf(entry).readOnlyHint !== true).map((entry) => entry.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((entry) => entry.enabled === false)).toEqual([]);
    const mutations = a.tools
      .filter((entry) => entry.endpointMapping.method === 'mutation')
      .flatMap((entry) => operation(entry).selectionSet.selections.map((s) => (s.kind === Kind.FIELD ? s.name.value : '')));
    expect(mutations.sort()).toEqual(['add_logbook_entry', 'create_contact', 'create_project_match', 'update_task']);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/delete_|create_payment|send_mail|is_deleted:\s*\$/);
    }
    for (const name of ['hero_software_create_contact', 'hero_software_create_project', 'hero_software_add_logbook_entry', 'hero_software_save_task']) {
      expect(tool(name).description).toMatch(/wait for their yes/);
    }
  });

  it('installs the generic mutation and subscription helpers switched off', () => {
    expect(a.connector.config.graphqlBuiltinsOff).toEqual(['mutation', 'subscription']);
    const tools = getAdapter('hero-software')!.tools as Array<{ name: string; enabled?: boolean }>;
    const byName = new Map(tools.map((entry) => [entry.name, entry]));
    expect(byName.get('hero-software_graphql_mutation')?.enabled).toBe(false);
    expect(byName.get('hero-software_graphql_subscription')?.enabled).toBe(false);
    expect(byName.get('hero-software_graphql_query')?.enabled).not.toBe(false);
  });

  it('names every tool in the instructions, points only at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    const builtins = [
      'hero-software_graphql_query',
      'hero-software_graphql_mutation',
      'hero-software_graphql_subscription',
      'hero-software_graphql_schema',
      'hero-software_graphql_schema_url',
    ];
    const mentioned = [
      ...a.instructions.matchAll(/\bhero_software_[a-z_]+/g),
      ...a.tools.flatMap((entry) => [...entry.description.matchAll(/\bhero_software_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect([...names, ...builtins]).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/installed switched off/);
    for (const entry of a.tools) {
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${param}:${typeof schema.description}`).toBe(`${entry.name}.${param}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['hero_software_get_account', {}, {}],
    ['hero_software_list_employees', {}, {}],
    ['hero_software_list_trades', {}, {}],
    ['hero_software_list_project_types', { is_active: true }, { isActive: true }],
    ['hero_software_list_countries', {}, {}],
    ['hero_software_list_contacts', { search: 'Mertens', category: 'customer', last: 20 }, { search: 'Mertens', category: 'customer', last: 20 }],
    ['hero_software_get_contact', { contact_id: 6804656 }, { id: 6804656 }],
    [
      'hero_software_list_projects',
      { customer_id: 6804656, step_ids: [11, 12], project_nr: 'UNB-123', offset: 50 },
      { customerId: 6804656, stepIds: [11, 12], projectNr: 'UNB-123', offset: 50 },
    ],
    ['hero_software_get_project', { project_id: 150798 }, { id: 150798 }],
    ['hero_software_list_project_history', { project_id: 150798, show_system_entries: false }, { projectId: 150798, showSystem: false }],
    [
      'hero_software_list_documents',
      { project_ids: [150798], invoice_style: 'full', order_by: 'created' },
      { projectIds: [150798], invoiceStyle: 'full', orderBy: 'created' },
    ],
    ['hero_software_get_document', { document_id: 77 }, { id: 77, expires: 3600 }],
    ['hero_software_list_document_types', { base_types: ['invoice'] }, { baseTypes: ['invoice'] }],
    ['hero_software_list_tasks', { project_id: 150798, is_done: false }, { projectId: 150798, isDone: false }],
    [
      'hero_software_list_calendar_events',
      { start: '2026-11-19T00:00:00+01:00', end: '2026-11-20T00:00:00+01:00', partner_ids: [3] },
      { start: '2026-11-19T00:00:00+01:00', end: '2026-11-20T00:00:00+01:00', partnerIds: [3] },
    ],
    ['hero_software_search_calendar_events', { search: 'Aufmass', start_date: '2026-11-01' }, { search: 'Aufmass', startDate: '2026-11-01' }],
    ['hero_software_list_calendar_event_categories', {}, {}],
    ['hero_software_list_field_service_jobs', { project_id: 150798, status_codes: [1] }, { projectId: 150798, statusCodes: [1] }],
    [
      'hero_software_list_time_entries',
      { start: '2026-11-01', end: '2026-11-30', show_all_employees: true, statuses: ['confirmed'] },
      { start: '2026-11-01', end: '2026-11-30', showAll: true, statuses: ['confirmed'] },
    ],
    ['hero_software_list_products', { search: 'Kartusche', first: 10 }, { search: 'Kartusche', first: 10 }],
    ['hero_software_list_services', { service_ids: [5] }, { serviceIds: [5] }],
    ['hero_software_search', { term: 'Mertens', category: 'contacts' }, { term: 'Mertens', category: 'contacts' }],
    [
      'hero_software_create_contact',
      { first_name: 'Erna', last_name: 'Mertens', email: 'erna@example.com', address: { street: 'Hauptstr. 1', zipcode: '79098', city: 'Freiburg' } },
      {
        findExisting: false,
        category: 'customer',
        firstName: 'Erna',
        lastName: 'Mertens',
        email: 'erna@example.com',
        address: { street: 'Hauptstr. 1', zipcode: '79098', city: 'Freiburg' },
      },
    ],
    [
      'hero_software_create_project',
      { customer_id: 6804656, name: 'Badmodernisierung', address_id: 14356616, type_id: 1, assigned_user_ids: [315200] },
      { customerId: 6804656, name: 'Badmodernisierung', addressId: 14356616, typeId: 1, assignedUserIds: [315200] },
    ],
    [
      'hero_software_add_logbook_entry',
      { target_id: 150798, text: 'Kunde ruft morgen zurueck.' },
      { targetId: 150798, text: 'Kunde ruft morgen zurueck.', target: 'project_match' },
    ],
    [
      'hero_software_save_task',
      { title: 'Angebot nachfassen', due_date: '2026-11-24T09:00:00+01:00', project_id: 150798 },
      { title: 'Angebot nachfassen', dueDate: '2026-11-24T09:00:00+01:00', projectId: 150798 },
    ],
  ];

  it('lists every tool in the request table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((entry) => entry.name).sort());
  });

  it.each(table)('%s posts its operation with the Bearer key and the right variables', async (name, params, variables) => {
    mockedPost.mockResolvedValue({ data: { data: {} } });
    await call(name, params);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(URL);
    expect(body.query).toBe(tool(name).endpointMapping.path);
    // undefined variables are dropped when the body is serialized.
    expect(JSON.parse(JSON.stringify(body.variables))).toEqual(variables);
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain('{{');
  });

  it('reads a single contact, project and document through the list arguments HERO documents', () => {
    expect(tool('hero_software_get_contact').endpointMapping.path).toContain('contacts(ids: [$id]');
    expect(tool('hero_software_get_project').endpointMapping.path).toContain('project_match(project_match_id: $id)');
    expect(tool('hero_software_get_document').endpointMapping.path).toContain('customer_documents(ids: [$id])');
    expect(tool('hero_software_get_document').endpointMapping.path).toContain('temporary_url(expires: $expires)');
  });

  it('reports a GraphQL error as a failed call', async () => {
    mockedPost.mockResolvedValue({ data: { errors: [{ message: 'Cannot query field "foo" on type "Customer".' }], data: null } });
    await expect(call('hero_software_list_contacts', {})).rejects.toThrow(/Cannot query field/);
  });
});

// Opt-in: RUN_HERO_SOFTWARE_LIVE=1. The refusal check needs no account; the
// schema validation and the reads need HERO_API_TOKEN. Nothing is written.
const live = process.env.RUN_HERO_SOFTWARE_LIVE === '1' ? describe : describe.skip;
live('hero-software adapter: live', () => {
  const real = !!process.env.HERO_API_TOKEN;
  const env = () => ({ HERO_API_TOKEN: process.env.HERO_API_TOKEN! });
  beforeAll(() => mockedPost.mockImplementation((url: string, data: unknown, opts: any) => actualAxios.post(url, data, opts)));
  afterAll(() => mockedPost.mockReset());

  it('answers a wrong key with 403 invalid_token', async () => {
    const res = await actualAxios.post(
      URL,
      { query: '{ echo(message: "x") }' },
      { headers: { Authorization: `Bearer ${FAKE_TOKEN}`, 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: 30000 },
    );
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('invalid_token');
  }, 30000);

  (real ? it : it.skip)('every operation is valid against the live schema', async () => {
    const res = await actualAxios.post(
      URL,
      { query: getIntrospectionQuery() },
      { headers: { Authorization: `Bearer ${env().HERO_API_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 60000 },
    );
    const schema = buildClientSchema(res.data.data);
    for (const entry of a.tools) {
      const errors = validate(schema, parse(entry.endpointMapping.path)).map((e) => e.message);
      expect(`${entry.name}:${errors.join('; ')}`).toBe(`${entry.name}:`);
    }
  }, 90000);

  (real ? it : it.skip)('reads the account, contacts, projects and documents', async () => {
    const account = await call('hero_software_get_account', {}, env());
    expect(account.user.id).toBeTruthy();
    const contacts = await call('hero_software_list_contacts', { last: 5 }, env());
    expect(Array.isArray(contacts.contacts)).toBe(true);
    const projects = await call('hero_software_list_projects', { last: 5 }, env());
    expect(Array.isArray(projects.project_matches)).toBe(true);
    const documents = await call('hero_software_list_documents', { last: 5 }, env());
    expect(Array.isArray(documents.customer_documents)).toBe(true);
  }, 120000);
});
