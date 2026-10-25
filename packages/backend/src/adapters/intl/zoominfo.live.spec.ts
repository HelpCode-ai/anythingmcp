import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './zoominfo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the ZoomInfo adapter (GTM API, Data API v1):
 *
 *   1. Static: always runs. Pins the client-credentials token request (HTTP
 *      Basic at api.zoominfo.com/gtm/oauth/v1/token), the JSON:API envelope
 *      of every search and enrich body, the page[...] and filter[...] query
 *      names, and the response shaping. Checked on 15 Oct 2026 against
 *      ZoomInfo's OpenAPI document (openapi-data-v1.yaml) and ZoomInfo's own
 *      n8n node (github.com/Zoominfo/n8n-nodes-zoominfo).
 *
 *   2. Live: skipped unless RUN_ZOOMINFO_LIVE=1. Without credentials it checks
 *      that the token endpoint refuses an unknown client and that every route
 *      exists (401 with a wrong bearer token, while a made-up route answers
 *      404). With ZOOMINFO_CLIENT_ID and ZOOMINFO_CLIENT_SECRET it runs the
 *      free calls (usage, lookups, searches). RUN_ZOOMINFO_LIVE_CREDITS=1 also
 *      enriches one contact and one company, which can spend 2 credits:
 *
 *        RUN_ZOOMINFO_LIVE=1 ZOOMINFO_CLIENT_ID=... ZOOMINFO_CLIENT_SECRET=... \
 *          npx jest src/adapters/intl/zoominfo.live.spec.ts
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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios; post: jest.Mock };

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; items?: any }>; required?: string[] };
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

const HOST = 'https://api.zoominfo.com/gtm';
const TOKEN_URL = 'https://api.zoominfo.com/gtm/oauth/v1/token';
// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = { ZOOMINFO_CLIENT_ID: ['0oa', 'x'.repeat(17)].join(''), ZOOMINFO_CLIENT_SECRET: 's'.repeat(40) };
const newTokenService = () =>
  new OAuth2TokenService({} as PrismaService, { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService);

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, tokens: OAuth2TokenService, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['zoominfo_get_usage', {}, 'GET', '/data/v1/users/usage'],
  ['zoominfo_lookup_values', { field_name: 'industries' }, 'GET', '/data/v1/lookup/industries'],
  ['zoominfo_list_search_fields', { entity: 'contact' }, 'GET', '/data/v1/lookup/search'],
  ['zoominfo_list_enrich_fields', { entity: 'contact' }, 'GET', '/data/v1/lookup/enrich'],
  ['zoominfo_search_contacts', { filters: { jobTitle: 'CFO' } }, 'POST', '/data/v1/contacts/search'],
  ['zoominfo_search_companies', { filters: { companyName: 'ZoomInfo' } }, 'POST', '/data/v1/companies/search'],
  ['zoominfo_enrich_contacts', { contacts: [{ personId: 1 }] }, 'POST', '/data/v1/contacts/enrich'],
  ['zoominfo_enrich_companies', { companies: [{ companyId: 1 }] }, 'POST', '/data/v1/companies/enrich'],
];

const stubTokens = () => ({ getAccessToken: jest.fn().mockResolvedValue('test-token') }) as unknown as OAuth2TokenService;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

describe('zoominfo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('enrichment');
    expect(a.icon).toBe('zoominfo');
  });

  it('signs in with the client-credentials grant at the GTM token endpoint, HTTP Basic', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{ZOOMINFO_CLIENT_ID}}',
      clientSecret: '{{ZOOMINFO_CLIENT_SECRET}}',
      tokenUrl: TOKEN_URL,
      tokenAuthMethod: 'client_secret_basic',
    });
    // No scope: ZoomInfo then grants exactly the scopes chosen for the app.
    expect(a.connector.authConfig.scope).toBeUndefined();
    expect(a.connector.headers).toMatchObject({ Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' });
    // Free and authenticated: the usage endpoint spends no credits.
    expect(a.connector.healthcheckPath).toBe('/data/v1/users/usage');
    expect(a.probe).toEqual({ tool: 'zoominfo_get_usage', params: {} });
  });

  it('sends client id and secret as HTTP Basic and grant_type=client_credentials in the body', async () => {
    const service = newTokenService();
    const post = jest.spyOn(mockedAxios, 'post').mockResolvedValue({ data: { access_token: 'eyJ.zi', expires_in: 1000, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.zi');
    const [url, body, options] = post.mock.calls[0] as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(TOKEN_URL);
    expect(body).toBe('grant_type=client_credentials');
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ENV.ZOOMINFO_CLIENT_ID}:${ENV.ZOOMINFO_CLIENT_SECRET}`).toString('base64')}`,
    );
    post.mockRestore();
  });

  it('describes both credentials, keeps the secret secret and has hints for refusals', () => {
    expect(a.requiredEnvVars).toEqual(['ZOOMINFO_CLIENT_ID', 'ZOOMINFO_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.ZOOMINFO_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.ZOOMINFO_CLIENT_ID).toMatchObject({ kind: 'credential', secret: false, required: true });
    expect(new RegExp(a.envVarMeta.ZOOMINFO_CLIENT_ID.pattern!).test(ENV.ZOOMINFO_CLIENT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.ZOOMINFO_CLIENT_ID.pattern!).test('two words')).toBe(false);
    expect(new RegExp(a.envVarMeta.ZOOMINFO_CLIENT_SECRET.pattern!).test(ENV.ZOOMINFO_CLIENT_SECRET)).toBe(true);
    expect(new RegExp(a.envVarMeta.ZOOMINFO_CLIENT_SECRET.pattern!).test('short')).toBe(false);
    for (const key of ['400', '401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/Client Credentials Flow/);
  });

  it('prefixes every tool with zoominfo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^zoominfo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only the two enrichments spend credits: they say so, ask first, and are not read-only', () => {
    const paid = ['zoominfo_enrich_contacts', 'zoominfo_enrich_companies'];
    for (const name of paid) {
      expect(tool(name).description).toMatch(/COSTS CREDITS/);
      expect(tool(name).description).toMatch(/wait for their yes/);
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    }
    for (const t of a.tools.filter((x) => !paid.includes(x.name))) {
      expect(`${t.name}:${/Free: uses no credits/.test(t.description)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.some((t) => ['PUT', 'PATCH', 'DELETE'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('explains personal data, credits and setup, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bzoominfo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzoominfo_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/GDPR/);
    expect(a.instructions).toMatch(/CAN-SPAM/);
    expect(a.instructions).toMatch(/never pull contact data in bulk/);
    expect(a.instructions).toMatch(/under management/);
    expect(a.instructions).toMatch(/Developer Portal/);
    expect(a.instructions).toMatch(/GTM\.ai/);
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

  it.each(table)('%s sends %s to the right URL with the bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params, stubTokens());
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe('Bearer test-token');
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    // The secret never leaves for the API itself.
    expect(JSON.stringify(req)).not.toContain(ENV.ZOOMINFO_CLIENT_SECRET);
  });

  it('wraps searches in the JSON:API envelope with page[...] and sort in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoominfo_search_contacts', { filters: { jobTitle: 'CFO', country: 'Germany' }, page: 2, page_size: 25, sort: '-contactAccuracyScore' }, stubTokens());
    expect(sent().data).toEqual({ data: { type: 'ContactSearch', attributes: { jobTitle: 'CFO', country: 'Germany' } } });
    expect(sent().params).toEqual({ 'page[number]': 2, 'page[size]': 25, sort: '-contactAccuracyScore' });
    mockedAxios.mockClear();
    await call('zoominfo_search_companies', { filters: { companyName: 'ZoomInfo' } }, stubTokens());
    expect(sent().data).toEqual({ data: { type: 'CompanySearch', attributes: { companyName: 'ZoomInfo' } } });
    // Ten records unless the user asks for more.
    expect(sent().params).toEqual({ 'page[size]': 10 });
  });

  it('sends the lookup filters as filter[...] query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoominfo_lookup_values', { field_name: 'tech-products', vendor: 'microsoft corporation' }, stubTokens());
    expect(sent().params).toEqual({ 'filter[vendor]': 'microsoft corporation' });
    mockedAxios.mockClear();
    await call('zoominfo_list_search_fields', { entity: 'company' }, stubTokens());
    expect(sent().params).toEqual({ 'filter[entity]': 'company', 'filter[fieldType]': 'input' });
    mockedAxios.mockClear();
    await call('zoominfo_list_enrich_fields', { entity: 'contact' }, stubTokens());
    expect(sent().params).toEqual({ 'filter[entity]': 'contact', 'filter[fieldType]': 'output' });
  });

  it('enriches with matchPersonInput / matchCompanyInput and default output fields from the OpenAPI enums', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zoominfo_enrich_contacts', { contacts: [{ personId: 4191419698 }], required_fields: ['email'] }, stubTokens());
    const contact = sent().data.data;
    expect(contact.type).toBe('ContactEnrich');
    expect(contact.attributes.matchPersonInput).toEqual([{ personId: 4191419698 }]);
    expect(contact.attributes.requiredFields).toEqual(['email']);
    expect(contact.attributes.outputFields).toEqual(tool('zoominfo_enrich_contacts').parameters.properties!.output_fields.default);
    mockedAxios.mockClear();
    await call('zoominfo_enrich_companies', { companies: [{ companyWebsite: 'http://www.zoominfo.com' }], output_fields: ['id', 'name'] }, stubTokens());
    expect(sent().data).toEqual({
      data: { type: 'CompanyEnrich', attributes: { matchCompanyInput: [{ companyWebsite: 'http://www.zoominfo.com' }], outputFields: ['id', 'name'] } },
    });
    for (const name of ['zoominfo_enrich_contacts', 'zoominfo_enrich_companies']) {
      const p = tool(name).parameters.properties!.output_fields;
      for (const f of p.default as string[]) expect(p.items.enum).toContain(f);
    }
  });

  it('shapes searches to ids, names and the has-hints, and never passes contact data from a search', () => {
    const contacts = shape('zoominfo_search_contacts', {
      data: [
        {
          id: '4191419698',
          type: 'Contact',
          attributes: {
            firstName: 'Filip',
            lastName: 'Popovic',
            jobTitle: 'Chief Technology Officer',
            company: { id: 344589814, name: 'ZoomInfo' },
            contactAccuracyScore: 95,
            hasEmail: true,
            hasDirectPhone: false,
            hasMobilePhone: true,
            lastUpdatedDate: '2025-04-04T18:13:00Z',
            hasCompanyRevenue: true,
          },
        },
      ],
      links: { first: '/data/v1/contacts/search?page[number]=1&page[size]=25' },
      meta: { page: { number: 1, total: 1 }, totalResults: 1 },
    });
    expect(contacts).toEqual({
      totalResults: 1,
      page: 1,
      totalPages: 1,
      contacts: [
        {
          id: '4191419698',
          firstName: 'Filip',
          lastName: 'Popovic',
          jobTitle: 'Chief Technology Officer',
          company: { id: 344589814, name: 'ZoomInfo' },
          accuracyScore: 95,
          hasEmail: true,
          hasDirectPhone: false,
          hasMobilePhone: true,
          lastUpdated: '2025-04-04T18:13:00Z',
        },
      ],
    });
    const companies = shape('zoominfo_search_companies', {
      data: [{ id: '344589814', type: 'Company', attributes: { name: 'ZoomInfo', website: 'www.zoominfo.com', country: 'United States', employeeCount: '3508', logo: 'x', managementStatus: { underManagement: false } } }],
      meta: { page: { number: 1, total: 1 }, totalResults: 1 },
    });
    expect(companies.companies).toEqual([{ id: '344589814', name: 'ZoomInfo', website: 'www.zoominfo.com', country: 'United States', employeeCount: '3508', underManagement: false }]);
  });

  it('shapes usage, lookups and enrichments', () => {
    expect(
      shape('zoominfo_get_usage', {
        data: [{ id: 'u', type: 'UserUsage', attributes: { usage: [{ limitType: 'record', description: 'Records', totalLimit: 1000, currentUsage: 10, usageRemaining: 990 }] } }],
      }),
    ).toEqual({ usage: [{ limitType: 'record', description: 'Records', totalLimit: 1000, used: 10, remaining: 990 }] });
    expect(
      shape('zoominfo_lookup_values', {
        data: [
          { id: 'software', type: 'Industry', attributes: { name: 'Software' }, links: { self: 'x' } },
          { id: '7', type: 'BuyingGroup', attributes: { name: 'IT', isDefault: true } },
        ],
      }),
    ).toEqual({ values: [{ id: 'software', name: 'Software' }, { id: '7', name: 'IT', isDefault: true }] });
    expect(
      shape('zoominfo_list_enrich_fields', {
        data: [{ id: 'email', type: 'ContactEnrichOutput', attributes: { fieldName: 'email', fieldType: 'String', description: 'Business email', accessGranted: true } }],
      }),
    ).toEqual({ fields: [{ name: 'email', type: 'String', description: 'Business email', accessGranted: true }] });
    const enriched = shape('zoominfo_enrich_contacts', {
      data: [
        {
          id: '344589814',
          type: 'Contact',
          attributes: { email: 'henry@zoominfo.com', jobTitle: 'CEO', directPhoneDoNotCall: false },
          meta: { input: { personId: 344589814 }, matchStatus: 'FULL_MATCH' },
        },
      ],
    });
    expect(enriched.contacts).toEqual([
      { id: '344589814', matchStatus: 'FULL_MATCH', input: { personId: 344589814 }, data: { email: 'henry@zoominfo.com', jobTitle: 'CEO', directPhoneDoNotCall: false } },
    ]);
  });
});

const live = process.env.RUN_ZOOMINFO_LIVE === '1' ? describe : describe.skip;
live('zoominfo adapter: live', () => {
  const real = !!(process.env.ZOOMINFO_CLIENT_ID && process.env.ZOOMINFO_CLIENT_SECRET);
  const credits = real && process.env.RUN_ZOOMINFO_LIVE_CREDITS === '1';
  const env = () => ({ ZOOMINFO_CLIENT_ID: process.env.ZOOMINFO_CLIENT_ID!, ZOOMINFO_CLIENT_SECRET: process.env.ZOOMINFO_CLIENT_SECRET! });
  // A token ZoomInfo never issued; renewing it after the 401 gets nothing new.
  const wrongBearer = () =>
    ({
      getAccessToken: jest.fn().mockResolvedValue('eyJ.not.valid'),
      renewAfterRejection: jest.fn().mockResolvedValue(null),
      renewalFailedError: jest.fn().mockReturnValue(null),
    }) as unknown as OAuth2TokenService;
  let tokens: OAuth2TokenService;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg));
    tokens = newTokenService();
  });
  afterAll(() => mockedAxios.mockReset());
  const shaped = async (name: string, params: Record<string, unknown>) =>
    applyResponseTransform(await call(name, params, tokens, env()), tool(name).responseMapping as any).value as any;

  it('refuses an unknown client at the token endpoint before any API call', async () => {
    await expect(newTokenService().getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).rejects.toMatchObject({ status: 401 });
  }, 30000);

  // The gateway checks the token before routing, but answers a made-up route
  // with 404 even then, so a 401 here shows the route exists.
  it.each(table)('%s reaches a real route and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params, wrongBearer())).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404, which is what makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${HOST}/data/v1/no-such-route`, headers: { Authorization: 'Bearer eyJ.not.valid' } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads usage, lookups and both searches (free)', async () => {
    const usage = await shaped('zoominfo_get_usage', {});
    expect(Array.isArray(usage.usage)).toBe(true);
    const levels = await shaped('zoominfo_lookup_values', { field_name: 'management-levels' });
    expect(levels.values.length).toBeGreaterThan(0);
    const fields = await shaped('zoominfo_list_enrich_fields', { entity: 'contact' });
    expect(fields.fields.some((f: any) => f.name === 'email')).toBe(true);
    const companies = await shaped('zoominfo_search_companies', { filters: { companyWebsite: 'https://www.zoominfo.com' }, page_size: 1 });
    expect(typeof companies.totalResults).toBe('number');
    const contacts = await shaped('zoominfo_search_contacts', { filters: { companyName: 'ZoomInfo', managementLevel: 'C Level Exec' }, page_size: 2 });
    expect(Array.isArray(contacts.contacts)).toBe(true);
  }, 60000);

  (credits ? it : it.skip)('enriches one contact and one company (up to 2 credits)', async () => {
    const companies = await shaped('zoominfo_search_companies', { filters: { companyWebsite: 'https://www.zoominfo.com' }, page_size: 1 });
    const company = await shaped('zoominfo_enrich_companies', { companies: [{ companyId: Number(companies.companies[0].id) }], output_fields: ['id', 'name', 'website'] });
    expect(company.companies[0].data.name).toBeTruthy();
    const contacts = await shaped('zoominfo_search_contacts', { filters: { companyName: 'ZoomInfo', managementLevel: 'C Level Exec' }, page_size: 1 });
    const contact = await shaped('zoominfo_enrich_contacts', { contacts: [{ personId: Number(contacts.contacts[0].id) }], output_fields: ['id', 'firstName', 'lastName', 'jobTitle'] });
    expect(contact.contacts[0].matchStatus).toBeTruthy();
  }, 60000);
});
