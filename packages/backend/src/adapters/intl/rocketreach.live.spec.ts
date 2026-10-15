import axios from 'axios';
import * as adapter from './rocketreach.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the RocketReach adapter (API v2):
 *
 *   1. Static: always runs. Pins the Api-Key header, every tool's method, URL,
 *      query and body through the real RestEngine, and the response shaping.
 *      Checked on 15 Oct 2026 against the OpenAPI documents embedded in
 *      docs.rocketreach.co and RocketReach's Python SDK
 *      (github.com/rocketreach/rocketreach_python).
 *
 *   2. Live: skipped unless RUN_ROCKETREACH_LIVE=1. It checks that every route
 *      exists (401 with a wrong key, while a made-up route answers 404), then
 *      runs the tools against RocketReach's public test key, the sandbox key
 *      their SDK ships with: account, search, a lookup of their sample
 *      profile and its status, company search. The test key charges nobody.
 *      With ROCKETREACH_API_KEY it also runs the free calls on that account;
 *      RUN_ROCKETREACH_LIVE_CREDITS=1 adds one person and one company lookup,
 *      which spend credits:
 *
 *        RUN_ROCKETREACH_LIVE=1 ROCKETREACH_API_KEY=... npx jest src/adapters/intl/rocketreach.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://api.rocketreach.co/api/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0'.repeat(32), 'abcd'].join('');
// RocketReach's public sandbox key, as published in their Python SDK.
const TEST_KEY = ['3e7k', '0123456789abcdef'.repeat(2)].join('');
const ENV: Record<string, string> = { ROCKETREACH_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
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
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => new URLSearchParams(sent().paramsSerializer(sent().params));

const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['rocketreach_get_account', {}, 'GET', '/account/'],
  ['rocketreach_search_people', { query: { name: ['Marc Benioff'] } }, 'POST', '/person/search'],
  ['rocketreach_lookup_person', { id: 5244 }, 'GET', '/person/lookup'],
  ['rocketreach_check_lookup_status', { ids: [5244] }, 'GET', '/person/checkStatus'],
  ['rocketreach_search_companies', { query: { name: ['Salesforce'] } }, 'POST', '/searchCompany'],
  ['rocketreach_lookup_company', { domain: 'salesforce.com' }, 'GET', '/company/lookup/'],
];

describe('rocketreach adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('enrichment');
    expect(a.icon).toBe('rocketreach');
  });

  it('sends the API key as Api-Key to api.rocketreach.co/api/v2 and checks it on the free account call', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Api-Key', apiKey: '{{ROCKETREACH_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/account/');
    expect(a.probe).toEqual({ tool: 'rocketreach_get_account', params: {} });
    expect(a.requiredEnvVars).toEqual(['ROCKETREACH_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.ROCKETREACH_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.ROCKETREACH_API_KEY.pattern!);
    for (const good of [FAKE_KEY, TEST_KEY]) expect(pattern.test(good)).toBe(true);
    for (const bad of ['', 'short', 'Api-Key: 0123456789abcdef0123']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with rocketreach_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^rocketreach_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('the two lookups spend credits: they say so, ask first, and are not read-only although they are GETs', () => {
    const paid = ['rocketreach_lookup_person', 'rocketreach_lookup_company'];
    for (const name of paid) {
      expect(tool(name).description).toMatch(/COSTS CREDITS/);
      expect(tool(name).description).toMatch(/wait for their yes/);
      // A lookup adds the record to My Contacts / My Companies and spends a
      // credit, so the verify run that exercises read-only tools skips it.
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    for (const t of a.tools.filter((x) => !paid.includes(x.name))) {
      expect(`${t.name}:${/Free/.test(t.description)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('explains personal data, credits and setup, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\brocketreach_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\brocketreach_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/GDPR/);
    expect(a.instructions).toMatch(/CAN-SPAM/);
    expect(a.instructions).toMatch(/never pull contact data in bulk/);
    expect(a.instructions).toMatch(/Generate New API Key/);
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

  it.each(table)('%s sends %s to the right URL with the Api-Key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['Api-Key']).toBe(FAKE_KEY);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('builds the search body like the SDK: query facets, start, page_size, order_by', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('rocketreach_search_people', {
      query: { current_title: ['CFO'], geo: ['Germany'], exclude_current_employer: ['"IBM"'] },
      start: 11,
      page_size: 25,
      order_by: 'popularity',
    });
    expect(sent().data).toEqual({
      query: { current_title: ['CFO'], geo: ['Germany'], exclude_current_employer: ['"IBM"'] },
      start: 11,
      page_size: 25,
      order_by: 'popularity',
    });
    mockedAxios.mockClear();
    await call('rocketreach_search_companies', { query: { name: ['Salesforce'] } });
    // Ten records unless the user asks for more.
    expect(sent().data).toEqual({ query: { name: ['Salesforce'] }, page_size: 10 });
  });

  it('sends lookup identifiers as query parameters and the status ids repeated (ids=1&ids=2)', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('rocketreach_lookup_person', { name: 'Marc Benioff', current_employer: 'Salesforce', lookup_type: 'standard' });
    expect(sent().params).toEqual({ name: 'Marc Benioff', current_employer: 'Salesforce', lookup_type: 'standard' });
    mockedAxios.mockClear();
    await call('rocketreach_check_lookup_status', { ids: [5244, 5245] });
    expect(query().getAll('ids')).toEqual(['5244', '5245']);
    mockedAxios.mockClear();
    await call('rocketreach_lookup_company', { domain: 'salesforce.com' });
    expect(sent().params).toEqual({ domain: 'salesforce.com' });
  });

  it('shapes a lookup and a status check to the contact data, without job history or education', () => {
    const profile = {
      profile_list: { id: 9713, name: 'API Contacts' },
      id: 5244,
      status: 'complete',
      name: 'Marc Benioff',
      linkedin_url: 'https://www.linkedin.com/in/marcbenioff',
      location: 'San Francisco, CA, US',
      current_title: 'Chair and CEO',
      current_employer: 'Salesforce',
      current_employer_domain: 'salesforce.com',
      job_history: [{ company: 'Oracle' }],
      education: [{ school: 'USC' }],
      recommended_email: 'marc.benioff@salesforce.com',
      recommended_professional_email: 'marc.benioff@salesforce.com',
      emails: [{ email: 'marc.benioff@salesforce.com', smtp_valid: 'valid', type: 'professional', last_validation_check: '2026-10-15', grade: 'A' }],
      phones: [{ number: '+1 415-555-0101', e164: '+14155550101', type: 'mobile', grade: 'A', recommended: true, premium: true }],
      current_employer_phone: { number: '+1 415-555-0100', type: 'other' },
    };
    const contact = {
      id: 5244,
      status: 'complete',
      name: 'Marc Benioff',
      current_title: 'Chair and CEO',
      current_employer: 'Salesforce',
      linkedin_url: 'https://www.linkedin.com/in/marcbenioff',
      recommended_email: 'marc.benioff@salesforce.com',
      recommended_professional_email: 'marc.benioff@salesforce.com',
      emails: [{ email: 'marc.benioff@salesforce.com', type: 'professional', grade: 'A', smtp_valid: 'valid' }],
      phones: [{ number: '+1 415-555-0101', type: 'mobile', grade: 'A', recommended: true }],
    };
    expect(shape('rocketreach_lookup_person', profile)).toEqual({
      ...contact,
      current_employer_domain: 'salesforce.com',
      location: 'San Francisco, CA, US',
      current_employer_phone: '+1 415-555-0100',
    });
    expect(shape('rocketreach_check_lookup_status', [profile])).toEqual({ lookups: [contact] });
  });

  it('shapes searches and the account', () => {
    const people = shape('rocketreach_search_people', {
      pagination: { start: 1, next: 11, total: 4242 },
      profiles: [
        {
          id: 5244,
          status: 'complete',
          name: 'Marc Benioff',
          links: { twitter: 'x' },
          linkedin_url: 'https://www.linkedin.com/in/marcbenioff',
          location: 'San Francisco, CA, US',
          current_title: 'Chair and CEO',
          current_employer: 'Salesforce',
          current_employer_domain: 'salesforce.com',
          current_employer_id: 3185,
          teaser: { professional_emails: ['salesforce.com'], personal_emails: ['gmail.com'], phones: [{ number: '+1 415-260-XXXX', is_premium: true }] },
          birth_year: 1964,
          suppressed: false,
        },
      ],
    });
    expect(people).toEqual({
      pagination: { start: 1, next: 11, total: 4242 },
      profiles: [
        {
          id: 5244,
          name: 'Marc Benioff',
          current_title: 'Chair and CEO',
          current_employer: 'Salesforce',
          current_employer_domain: 'salesforce.com',
          current_employer_id: 3185,
          location: 'San Francisco, CA, US',
          linkedin_url: 'https://www.linkedin.com/in/marcbenioff',
          professional_email_domains: ['salesforce.com'],
          personal_email_domains: ['gmail.com'],
          phones: [{ number: '+1 415-260-XXXX', is_premium: true }],
          suppressed: false,
        },
      ],
    });
    const companies = shape('rocketreach_search_companies', {
      pagination: { total: 754, thisPage: 1, nextPage: 3, pageSize: 2 },
      companies: [{ id: 3185, name: 'Salesforce', email_domain: 'salesforce.com', ticker_symbol: 'CRM', industry_str: 'Internet', city: 'San Francisco', region: 'California', country_code: 'US' }],
    });
    expect(companies.pagination.nextPage).toBe(3);
    expect(companies.companies[0].id).toBe(3185);
    const account = shape('rocketreach_get_account', { id: 999, first_name: 'A', state: 'registered', credit_usage: [{ credit_type: 'premium_lookup', allocated: 10, used: 1, remaining: 9 }], rate_limits: [], api_key: FAKE_KEY });
    // The key itself never goes back to the model.
    expect(account).toEqual({ id: 999, first_name: 'A', state: 'registered', credit_usage: [{ credit_type: 'premium_lookup', allocated: 10, used: 1, remaining: 9 }], rate_limits: [] });
    expect(shape('rocketreach_lookup_company', { id: 3185, name: 'Salesforce', company_growth: [{ q: 1 }] })).toEqual({ id: 3185, name: 'Salesforce' });
  });
});

const live = process.env.RUN_ROCKETREACH_LIVE === '1' ? describe : describe.skip;
live('rocketreach adapter: live', () => {
  const real = !!process.env.ROCKETREACH_API_KEY;
  const credits = real && process.env.RUN_ROCKETREACH_LIVE_CREDITS === '1';
  const sandbox = { ROCKETREACH_API_KEY: TEST_KEY };
  const env = () => ({ ROCKETREACH_API_KEY: process.env.ROCKETREACH_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404 even with a wrong key, which is what makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${HOST}/no-such-route`, headers: { 'Api-Key': FAKE_KEY } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  it('runs account, search, lookup, status and company search with the public test key', async () => {
    const account = await shaped('rocketreach_get_account', {}, sandbox);
    expect(account.state).toBe('test_user');
    expect(Array.isArray(account.credit_usage)).toBe(true);
    const people = await shaped('rocketreach_search_people', { query: { name: ['Marc Benioff'] }, page_size: 1 }, sandbox);
    expect(people.profiles[0].id).toBe(5244);
    expect(typeof people.pagination.total).toBe('number');
    const lookup = await shaped('rocketreach_lookup_person', { id: 5244 }, sandbox);
    expect(lookup.id).toBe(5244);
    expect(['complete', 'progress', 'searching', 'waiting', 'failed']).toContain(lookup.status);
    const status = await shaped('rocketreach_check_lookup_status', { ids: [5244] }, sandbox);
    expect(status.lookups[0].id).toBe(5244);
    const companies = await shaped('rocketreach_search_companies', { query: { name: ['Salesforce'] }, page_size: 2 }, sandbox);
    expect(companies.companies.length).toBeGreaterThan(0);
    expect(typeof companies.pagination.nextPage).toBe('number');
    // The test key has no company lookups.
    await expect(call('rocketreach_lookup_company', { domain: 'salesforce.com' }, sandbox)).rejects.toMatchObject({ response: { status: 403 } });
  }, 60000);

  (real ? it : it.skip)('reads the account and searches people and companies on the real key (free)', async () => {
    const account = await shaped('rocketreach_get_account', {}, env());
    expect(Array.isArray(account.credit_usage)).toBe(true);
    const people = await shaped('rocketreach_search_people', { query: { current_employer: ['Salesforce'], current_title: ['CEO'] }, page_size: 2 }, env());
    expect(Array.isArray(people.profiles)).toBe(true);
    const companies = await shaped('rocketreach_search_companies', { query: { name: ['Salesforce'] }, page_size: 2 }, env());
    expect(Array.isArray(companies.companies)).toBe(true);
  }, 60000);

  (credits ? it : it.skip)('looks up one person and one company on the real key (spends credits)', async () => {
    const lookup = await shaped('rocketreach_lookup_person', { linkedin_url: 'https://www.linkedin.com/in/marcbenioff' }, env());
    expect(lookup.id).toBeTruthy();
    const status = await shaped('rocketreach_check_lookup_status', { ids: [lookup.id] }, env());
    expect(status.lookups[0].id).toBe(lookup.id);
    const company = await shaped('rocketreach_lookup_company', { domain: 'salesforce.com' }, env());
    expect(company.name).toBeTruthy();
  }, 60000);
});
