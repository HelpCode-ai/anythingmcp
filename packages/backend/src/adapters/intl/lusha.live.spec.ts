import axios from 'axios';
import * as adapter from './lusha.json';
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
 * Two layers of verification for the Lusha adapter (API v3):
 *
 *   1. Static: always runs. Pins the api_key header, every tool's method, URL
 *      and body through the real RestEngine, and the response shaping.
 *      Checked on 15 Oct 2026 against Lusha's OpenAPI document
 *      (docs.lusha.com/openapi.json, v3) and its guides.
 *
 *   2. Live: skipped unless RUN_LUSHA_LIVE=1. Without a key it checks that
 *      every route exists (401 with a wrong key, while a made-up route answers
 *      404 from the gateway). With LUSHA_API_KEY it runs the free calls
 *      (filters, signal types, account usage). RUN_LUSHA_LIVE_CREDITS=1 also
 *      searches and enriches one company (lusha.com), which spends credits:
 *
 *        RUN_LUSHA_LIVE=1 LUSHA_API_KEY=... npx jest src/adapters/intl/lusha.live.spec.ts
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

const HOST = 'https://api.lusha.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { LUSHA_API_KEY: FAKE_KEY };

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

const FILTERS = { contacts: { include: { jobTitles: ['head of procurement'], locations: [{ country: 'Germany' }] } } };
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['lusha_get_account_usage', {}, 'GET', '/v3/account/usage'],
  ['lusha_list_filters', { entity: 'contacts' }, 'GET', '/v3/contacts/prospecting/filters'],
  ['lusha_get_filter_values', { entity: 'companies', filter_type: 'sizes' }, 'GET', '/v3/companies/prospecting/filters/sizes'],
  ['lusha_search_contacts', { contacts: [{ email: 'someone@example.com' }] }, 'POST', '/v3/contacts/search'],
  ['lusha_search_companies', { companies: [{ domain: 'lusha.com' }] }, 'POST', '/v3/companies/search'],
  ['lusha_prospect_contacts', { filters: FILTERS }, 'POST', '/v3/contacts/prospecting'],
  ['lusha_prospect_companies', { filters: { companies: { include: { technologies: ['Salesforce'] } } } }, 'POST', '/v3/companies/prospecting'],
  ['lusha_enrich_contacts', { ids: ['670138733'] }, 'POST', '/v3/contacts/enrich'],
  ['lusha_get_enrich_job', { job_id: 'job_1' }, 'GET', '/v3/contacts/jobs/job_1'],
  ['lusha_enrich_companies', { ids: ['16303253'] }, 'POST', '/v3/companies/enrich'],
  ['lusha_list_signal_types', { entity: 'companies' }, 'GET', '/v3/companies/signals/types'],
  ['lusha_get_contact_signals', { ids: ['670138733'] }, 'POST', '/v3/contacts/signals'],
  ['lusha_get_company_signals', { ids: ['16303253'] }, 'POST', '/v3/companies/signals'],
];
const FREE = ['lusha_get_account_usage', 'lusha_list_filters', 'lusha_get_filter_values', 'lusha_get_enrich_job', 'lusha_list_signal_types'];

describe('lusha adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('enrichment');
    expect(a.icon).toBe('lusha');
  });

  it('sends the key as the api_key header to api.lusha.com and checks it on a free filter call', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'api_key', apiKey: '{{LUSHA_API_KEY}}' });
    // The usage endpoint is free but allows 5 calls a minute; the filter list is free too.
    expect(a.connector.healthcheckPath).toBe('/v3/contacts/prospecting/filters');
    expect(a.probe).toEqual({ tool: 'lusha_list_filters', params: { entity: 'contacts' } });
    expect(a.requiredEnvVars).toEqual(['LUSHA_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.LUSHA_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.LUSHA_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'short', 'api_key: 00000000-0000']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '402', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with lusha_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^lusha_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every call that returns records says it costs credits and is not read-only; the helpers are free GETs', () => {
    for (const t of a.tools) {
      if (FREE.includes(t.name)) {
        expect(`${t.name}:${/Free/.test(t.description)}`).toBe(`${t.name}:true`);
        expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
      } else {
        expect(`${t.name}:${/COSTS CREDITS/.test(t.description)}`).toBe(`${t.name}:true`);
        expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:false`);
        expect(annotationsOf(t).destructiveHint).toBe(false);
      }
    }
    for (const name of ['lusha_enrich_contacts', 'lusha_enrich_companies']) expect(tool(name).description).toMatch(/wait for their yes/);
    expect(a.tools.some((t) => ['PUT', 'PATCH', 'DELETE'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('explains personal data, credits and setup, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\blusha_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\blusha_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/GDPR/);
    expect(a.instructions).toMatch(/CAN-SPAM/);
    expect(a.instructions).toMatch(/never pull contact data in bulk/);
    expect(a.instructions).toMatch(/Manage API Keys/);
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

  it.each(table)('%s sends %s to the right URL with the api_key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.api_key).toBe(FAKE_KEY);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('builds the prospecting bodies with pagination, filters and options as the OpenAPI document names them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('lusha_prospect_contacts', { filters: FILTERS, page: 2, size: 25, exclude_dnc: true, max_contacts_per_company: 3, include_partial_profiles: false });
    expect(sent().data).toEqual({
      pagination: { page: 2, size: 25 },
      filters: FILTERS,
      options: { includePartialProfiles: false, excludeDnc: true, maxContactsPerCompany: 3 },
    });
    mockedAxios.mockClear();
    const companies = { companies: { include: { technologies: ['Salesforce'] } } };
    await call('lusha_prospect_companies', { filters: companies });
    // Lusha's smallest page is 10; that is also the default here.
    expect(sent().data).toEqual({ pagination: { page: 0, size: 10 }, filters: companies });
  });

  it('builds the search, enrich and signal bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('lusha_search_contacts', { contacts: [{ firstName: 'Anna', lastName: 'Schmidt', companyDomain: 'example.com', clientReferenceId: 'r1' }], include_partial_profiles: true });
    expect(sent().data).toEqual({
      contacts: [{ firstName: 'Anna', lastName: 'Schmidt', companyDomain: 'example.com', clientReferenceId: 'r1' }],
      options: { includePartialProfiles: true },
    });
    mockedAxios.mockClear();
    await call('lusha_enrich_contacts', { ids: ['1', '2'], reveal: ['emails'], waterfall_enabled: false });
    expect(sent().data).toEqual({ ids: ['1', '2'], reveal: ['emails'], waterfallEnabled: false });
    mockedAxios.mockClear();
    await call('lusha_enrich_companies', { ids: ['16303253'], reveal: ['competitors', 'ultimateParent'] });
    expect(sent().data).toEqual({ ids: ['16303253'], reveal: ['competitors', 'ultimateParent'] });
    mockedAxios.mockClear();
    await call('lusha_get_company_signals', { ids: ['16303253'], signal_types: ['surgeInHiring'], start_date: '2026-07-01', max_results_per_signal: 5 });
    expect(sent().data).toEqual({ ids: ['16303253'], signalTypes: ['surgeInHiring'], startDate: '2026-07-01', maxResultsPerSignal: 5 });
    mockedAxios.mockClear();
    await call('lusha_get_contact_signals', { ids: ['670138733'] });
    expect(sent().data).toEqual({ ids: ['670138733'], signalTypes: ['allSignals'] });
    mockedAxios.mockClear();
    await call('lusha_get_filter_values', { entity: 'contacts', filter_type: 'locations', query: 'Munich' });
    expect(sent().params).toEqual({ query: 'Munich' });
  });

  it('shapes enrichment results without tags, LinkedIn profile lists or coordinates, and the account usage', () => {
    const enriched = shape('lusha_enrich_contacts', {
      requestId: 'r',
      results: [
        {
          id: '670138733',
          fullName: 'Ting Tsou',
          emails: [{ email: 'ting@example.com', type: 'work', confidence: 'A+' }],
          phones: [{ number: '+49 761 555 0101', type: 'mobile', doNotCall: false }],
          location: { country: 'Germany', coordinates: [7.8, 48] },
          tags: [{ id: 't', name: 'x' }],
          profile: { skills: ['a'] },
        },
      ],
      billing: { creditsCharged: 2, resultsReturned: 1 },
    });
    expect(enriched).toEqual({
      results: [
        {
          id: '670138733',
          fullName: 'Ting Tsou',
          emails: [{ email: 'ting@example.com', type: 'work', confidence: 'A+' }],
          phones: [{ number: '+49 761 555 0101', type: 'mobile', doNotCall: false }],
          location: { country: 'Germany' },
        },
      ],
      billing: { creditsCharged: 2, resultsReturned: 1 },
    });
    const usage = shape('lusha_get_account_usage', {
      credits: { total: 10000, used: 1500, remaining: 8500 },
      rateLimits: { minute: { limit: 25, used: 1, remaining: 24 } },
      plan: { category: 'professional' },
      pricing: { api_search: { credits: 1, perQuantity: 1 }, phone: { credits: 5, perQuantity: 1 } },
      extra: 'dropped',
    });
    expect(usage).toEqual({
      credits: { total: 10000, used: 1500, remaining: 8500 },
      rateLimits: { minute: { limit: 25, used: 1, remaining: 24 } },
      plan: { category: 'professional' },
      pricing: { api_search: { credits: 1, perQuantity: 1 }, phone: { credits: 5, perQuantity: 1 } },
    });
    expect(shape('lusha_prospect_companies', { requestId: 'r', pagination: { page: 0, size: 10, total: 874 }, results: [{ id: '16303253', name: 'Lusha' }] })).toEqual({
      pagination: { page: 0, size: 10, total: 874 },
      results: [{ id: '16303253', name: 'Lusha' }],
    });
  });
});

const live = process.env.RUN_LUSHA_LIVE === '1' ? describe : describe.skip;
live('lusha adapter: live', () => {
  const real = !!process.env.LUSHA_API_KEY;
  const credits = real && process.env.RUN_LUSHA_LIVE_CREDITS === '1';
  const env = () => ({ LUSHA_API_KEY: process.env.LUSHA_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404 even with a wrong key, which is what makes the 401s above meaningful', async () => {
    for (const path of ['/v3/contacts/no-such-route', '/v3/companies/no-such-route']) {
      await expect(
        (mockedAxios.__actual as any).request({ method: 'POST', url: `${HOST}${path}`, data: {}, headers: { api_key: FAKE_KEY } }),
      ).rejects.toMatchObject({ response: { status: 404 } });
    }
  }, 30000);

  (real ? it : it.skip)('reads filters, filter values, signal types and the account usage (free)', async () => {
    const filters = await shaped('lusha_list_filters', { entity: 'contacts' }, env());
    expect(Array.isArray(filters.availableFilters)).toBe(true);
    const sizes = await shaped('lusha_get_filter_values', { entity: 'companies', filter_type: 'sizes' }, env());
    expect(sizes).toBeTruthy();
    const types = await shaped('lusha_list_signal_types', { entity: 'contacts' }, env());
    expect(types.signalTypes).toContain('promotion');
    const usage = await shaped('lusha_get_account_usage', {}, env());
    expect(typeof usage.credits.remaining).toBe('number');
  }, 60000);

  (credits ? it : it.skip)('searches and enriches one company (spends credits)', async () => {
    const found = await shaped('lusha_search_companies', { companies: [{ domain: 'lusha.com' }] }, env());
    const id = found.results[0].id;
    expect(id).toBeTruthy();
    const enriched = await shaped('lusha_enrich_companies', { ids: [id] }, env());
    expect(enriched.results[0].id).toBe(id);
  }, 60000);
});
