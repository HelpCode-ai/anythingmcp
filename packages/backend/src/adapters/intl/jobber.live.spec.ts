import axios from 'axios';
import { Kind, OperationDefinitionNode, parse, print } from 'graphql';
import * as adapter from './jobber.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';

/**
 * Jobber GraphQL API (developer.getjobber.com): one endpoint, https://api.getjobber.com/api/graphql,
 * OAuth2 authorization code at api.getjobber.com/api/oauth/{authorize,token}, the required
 * X-JOBBER-GRAPHQL-VERSION header, Relay connections (nodes + pageInfo) and userErrors on mutations.
 * Jobber publishes no SDL outside the Developer Center, so type and argument names were checked against
 * the documents of clients verified on the live schema at version 2026-05-12 (getjobber-cli, jobber-mcp)
 * and the n8n and Pipedream integrations; the live part validates the documents against the real schema.
 * Live part (read-only: account, clients, jobs, and validation of every document by introspection):
 *   JOBBER_ACCESS_TOKEN=... RUN_JOBBER_LIVE=1 npx jest src/adapters/intl/jobber
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
  parameters: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; advanced?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; config: { graphqlBuiltinsOff: string[] } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const operation = (t: Tool) =>
  parse(t.endpointMapping.path).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)!;
const declared = (t: Tool) =>
  (operation(t).variableDefinitions ?? []).map((v) => ({ name: v.variable.name.value, nonNull: v.type.kind === Kind.NON_NULL_TYPE, type: print(v.type) }));
const VERSION = '2026-05-12';
const OFF = ['jobber_close_job'];

describe('jobber adapter: static spec conformance', () => {
  it('signs in with OAuth2 authorization code and sends the API version header', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.getjobber.com/api/graphql');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{JOBBER_CLIENT_ID}}',
      clientSecret: '{{JOBBER_CLIENT_SECRET}}',
      refreshToken: '{{JOBBER_REFRESH_TOKEN}}',
      authorizationUrl: 'https://api.getjobber.com/api/oauth/authorize',
      tokenUrl: 'https://api.getjobber.com/api/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.requiredEnvVars).toEqual(['JOBBER_CLIENT_ID', 'JOBBER_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['JOBBER_REFRESH_TOKEN']);
    expect(a.envVarMeta.JOBBER_REFRESH_TOKEN.advanced).toBe(true);
    expect(a.envVarMeta.JOBBER_CLIENT_SECRET.secret).toBe(true);
    expect(a.connector.headers).toEqual({ 'X-JOBBER-GRAPHQL-VERSION': VERSION });
    expect(a.connector.config.graphqlBuiltinsOff).toEqual(['mutation', 'subscription']);
  });

  it('every document parses, is a query or a mutation as declared, and its variables match queryParams one to one', () => {
    for (const t of a.tools) {
      const op = operation(t);
      expect(`${t.name}:${op.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const vars = declared(t).map((v) => v.name).sort();
      expect(`${t.name}:${vars.join(',')}`).toBe(`${t.name}:${Object.keys(t.endpointMapping.queryParams ?? {}).sort().join(',')}`);
    }
  });

  it('every tool parameter reaches a variable, and every non-null variable is a required parameter or has a default', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('jobber_')).toBe(true);
      const qp = t.endpointMapping.queryParams ?? {};
      const mapped = Object.values(qp).map((v) => v.slice(1));
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${mapped.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of mapped) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const v of declared(t).filter((d) => d.nonNull)) {
        const param = qp[v.name].slice(1);
        const ok = (t.parameters.required ?? []).includes(param) || t.parameters.properties?.[param]?.default !== undefined;
        expect(`${t.name}:${v.name}:${ok}`).toBe(`${t.name}:${v.name}:true`);
      }
    }
  });

  it('uses the type names of the current schema', () => {
    const types = (name: string) => Object.fromEntries(declared(tool(name)).map((v) => [v.name, v.type]));
    expect(types('jobber_get_client')).toEqual({ id: 'EncodedId!' });
    expect(types('jobber_list_clients')).toMatchObject({ filter: 'ClientFilterAttributes', searchTerm: 'String' });
    expect(types('jobber_list_jobs')).toMatchObject({ filter: 'JobFilterAttributes' });
    expect(types('jobber_list_visits')).toMatchObject({ filter: 'VisitFilterAttributes', sort: '[VisitsSortInput!]' });
    expect(types('jobber_list_invoices')).toMatchObject({ filter: 'InvoiceFilterAttributes', sort: '[InvoiceSortInput!]' });
    expect(types('jobber_list_quotes')).toMatchObject({ filter: 'QuoteFilterAttributes' });
    expect(types('jobber_create_client')).toEqual({ input: 'ClientCreateInput!' });
    expect(types('jobber_update_client')).toEqual({ clientId: 'EncodedId!', input: 'ClientEditInput!' });
    expect(types('jobber_create_job')).toMatchObject({ propertyId: 'EncodedId!', invoicingType: 'BillingStrategy!', invoicingSchedule: 'BillingFrequencyEnum!' });
    expect(types('jobber_close_job')).toEqual({ jobId: 'EncodedId!', modifyIncompleteVisitsBy: 'IncompleteVisitDecisionEnum!' });
    expect(types('jobber_create_quote')).toEqual({ attributes: 'QuoteCreateAttributes!' });
    expect(types('jobber_create_invoice')).toEqual({ input: 'InvoiceCreateInput!' });
    expect(tool('jobber_create_quote').endpointMapping.path).toContain('quoteCreate(attributes: $attributes)');
    expect(tool('jobber_mark_invoice_sent').endpointMapping.path).toContain('invoiceMarkAsSent(id: $id)');
    expect(tool('jobber_close_job').parameters.properties?.incomplete_visits.enum).toEqual(['DESTROY_ALL', 'COMPLETE_PAST_DESTROY_FUTURE']);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'mutation')) expect(t.endpointMapping.path).toContain('userErrors { message path }');
  });

  it('switches off exactly the irreversible write and annotates the writes', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'query') expect(t.annotations).toBeUndefined();
      else expect(t.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('query');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('**Switched off at install**: `jobber_close_job`');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

describe('jobber adapter: requests', () => {
  const call = (name: string, params: Record<string, unknown>) =>
    new GraphqlEngine({ getAccessToken: jest.fn().mockResolvedValue('tok') } as unknown as OAuth2TokenService, {} as LoginTokenService, {} as GraphqlSchemaService).execute(
      { baseUrl: a.connector.baseUrl, authType: 'OAUTH2', authConfig: { ...a.connector.authConfig, clientId: 'id', clientSecret: 'secret' }, headers: a.connector.headers } as any,
      tool(name).endpointMapping as any,
      applySchemaDefaults(tool(name).parameters as any, params),
    );

  beforeEach(() => mockedPost.mockReset().mockResolvedValue({ data: { data: {} } }));

  it('posts a list with the bearer token, the version header and the default page size', async () => {
    await call('jobber_list_jobs', { filter: { status: 'requires_invoicing' } });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('https://api.getjobber.com/api/graphql');
    expect(JSON.parse(JSON.stringify(body.variables))).toEqual({ filter: { status: 'requires_invoicing' }, first: 20 });
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.headers['X-JOBBER-GRAPHQL-VERSION']).toBe(VERSION);
  });

  it('builds the job input from flat parameters with the billing defaults', async () => {
    await call('jobber_create_job', { property_id: 'p1', title: 'Fall cleanup' });
    expect(JSON.parse(JSON.stringify(mockedPost.mock.calls[0][1].variables))).toEqual({
      propertyId: 'p1', title: 'Fall cleanup', invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION',
    });
  });

  it('passes a quote object through as the attributes variable', async () => {
    const quote = { clientId: 'c1', propertyId: 'p1', lineItems: [{ name: 'Mulch', quantity: 2, unitPrice: 40, saveToProductsAndServices: false }] };
    await call('jobber_create_quote', { quote });
    expect(mockedPost.mock.calls[0][1].variables).toEqual({ attributes: quote });
  });
});

const live = process.env.RUN_JOBBER_LIVE === '1' && process.env.JOBBER_ACCESS_TOKEN ? describe : describe.skip;
live('jobber adapter: live (read-only)', () => {
  const gql = async (query: string, variables: Record<string, unknown> = {}) => {
    const res = await actualAxios.post(a.connector.baseUrl, { query, variables }, {
      headers: { Authorization: `Bearer ${process.env.JOBBER_ACCESS_TOKEN}`, 'X-JOBBER-GRAPHQL-VERSION': VERSION, 'Content-Type': 'application/json' },
    });
    expect(res.data.errors).toBeUndefined();
    return res.data.data;
  };
  it('reads the account, clients and jobs', async () => {
    expect((await gql(tool('jobber_get_account').endpointMapping.path)).account.id).toBeTruthy();
    expect(Array.isArray((await gql(tool('jobber_list_clients').endpointMapping.path, { first: 2 })).clients.nodes)).toBe(true);
    expect(Array.isArray((await gql(tool('jobber_list_jobs').endpointMapping.path, { first: 2 })).jobs.nodes)).toBe(true);
  }, 60_000);
  it('every document validates against the live schema', async () => {
    const { buildClientSchema, getIntrospectionQuery, validate } = await import('graphql');
    const schema = buildClientSchema(await gql(getIntrospectionQuery()));
    for (const t of a.tools) expect(`${t.name}: ${validate(schema, parse(t.endpointMapping.path)).map((e) => e.message).join('; ')}`).toBe(`${t.name}: `);
  }, 60_000);
});
