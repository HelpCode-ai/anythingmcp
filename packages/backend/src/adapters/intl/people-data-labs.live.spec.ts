import axios from 'axios';
import * as adapter from './people-data-labs.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the People Data Labs adapter:
 *
 *   1. Static: always runs. Pins the X-Api-Key header on
 *      api.peopledatalabs.com/v5 and every tool's method, URL, query and body
 *      through the real RestEngine, checked against PDL's reference pages
 *      (docs.peopledatalabs.com, read 14 Oct 2026). Also the credit rules in
 *      the descriptions (enrichment charged only on a match, identify per
 *      call, search per record, cleaners and autocomplete free), the small
 *      default search size, the POST searches marked read-only, and the
 *      personal-data notice.
 *
 *   2. Live: skipped unless RUN_PEOPLE_DATA_LABS_LIVE=1. Without a key it
 *      checks that PDL answers 401 on every route (so each one exists). With
 *      PEOPLE_DATA_LABS_API_KEY it calls only the free endpoints (the three
 *      cleaners and autocomplete); PEOPLE_DATA_LABS_LIVE_PAID=1 adds one
 *      company enrichment and a company search of size 1 (up to 2 credits):
 *
 *        RUN_PEOPLE_DATA_LABS_LIVE=1 PEOPLE_DATA_LABS_API_KEY=... npx jest src/adapters/intl/people-data-labs.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
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

const BASE = 'https://api.peopledatalabs.com/v5';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef'].join('');
const ENV: Record<string, string> = { PEOPLE_DATA_LABS_API_KEY: FAKE_KEY };

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
const sent = () => mockedAxios.mock.calls[0][0];

const ALL = [
  'people_data_labs_autocomplete',
  'people_data_labs_clean_company',
  'people_data_labs_clean_location',
  'people_data_labs_clean_school',
  'people_data_labs_enrich_company',
  'people_data_labs_enrich_ip',
  'people_data_labs_enrich_job_title',
  'people_data_labs_enrich_person',
  'people_data_labs_identify_person',
  'people_data_labs_search_companies',
  'people_data_labs_search_people',
];

describe('people-data-labs adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified on a live account on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('enrichment');
    expect(a.icon).toBe('people-data-labs');
  });

  it('sends the API key as X-Api-Key, on api.peopledatalabs.com/v5', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{PEOPLE_DATA_LABS_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['PEOPLE_DATA_LABS_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'PEOPLE_DATA_LABS_API_KEY', kind: 'credential', secret: true, required: true });
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_clean_location', { location: 'berlin' });
    expect(sent().headers['X-Api-Key']).toBe(FAKE_KEY);
    expect(sent().params.api_key).toBeUndefined();
  });

  it('accepts a key and refuses pasted headers or spaces', () => {
    const key = new RegExp(a.envVarMeta.PEOPLE_DATA_LABS_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `X-Api-Key: ${FAKE_KEY}`, `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes and health-checks with the free autocomplete, never a paid lookup', () => {
    expect(a.probe).toEqual({ tool: 'people_data_labs_autocomplete', params: { field: 'country', text: 'germ', size: 1 } });
    expect(a.connector.healthcheckPath).toBe('/autocomplete?field=country&text=germ&size=1');
    expect(tool('people_data_labs_autocomplete').description).toMatch(/Free: does not use credits/);
    for (const status of ['401', '402', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with people_data_labs_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect([...mine].sort()).toEqual(ALL);
    for (const name of mine) expect(name).toMatch(/^people_data_labs_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every tool read-only, including the POST searches, and installs all of them switched on', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    expect(tool('people_data_labs_search_people').annotations).toEqual({ readOnlyHint: true });
    expect(tool('people_data_labs_search_companies').annotations).toEqual({ readOnlyHint: true });
    expect(a.tools.every((t) => t.enabled !== false)).toBe(true);
  });

  it('states the credit rule of every paid tool and the free ones', () => {
    for (const name of ['people_data_labs_enrich_person', 'people_data_labs_enrich_company', 'people_data_labs_enrich_ip', 'people_data_labs_enrich_job_title']) {
      expect(`${name}: ${tool(name).description}`).toMatch(/only (when|on) .*(found|match)/);
      expect(tool(name).description).toMatch(/404/);
    }
    expect(tool('people_data_labs_identify_person').description).toMatch(/per call, also when nothing is found/);
    for (const name of ['people_data_labs_search_people', 'people_data_labs_search_companies']) {
      expect(tool(name).description).toMatch(/credit per record returned/);
      expect(tool(name).parameters.properties!.size).toMatchObject({ default: 1, maximum: 100 });
    }
    for (const name of ['people_data_labs_clean_company', 'people_data_labs_clean_location', 'people_data_labs_clean_school', 'people_data_labs_autocomplete']) {
      expect(tool(name).description).toMatch(/Free: does not use credits/);
    }
    expect(a.instructions).toMatch(/Every lookup can cost credits/);
    expect(a.prerequisites).toMatch(/100 credits a month/);
  });

  it('warns about personal data on the person tools', () => {
    expect(a.instructions).toMatch(/GDPR/);
    expect(a.instructions).toMatch(/legitimate purpose/);
    for (const name of ['people_data_labs_enrich_person', 'people_data_labs_identify_person', 'people_data_labs_search_people']) {
      expect(tool(name).description).toMatch(/personal data.*legitimate purpose.*GDPR/);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpeople_data_labs_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpeople_data_labs_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['people_data_labs_enrich_person', { email: 'sean@example.com' }, 'GET', '/person/enrich'],
    ['people_data_labs_identify_person', { name: 'Sean Thorne', location: 'San Francisco' }, 'GET', '/person/identify'],
    ['people_data_labs_search_people', { sql: "SELECT * FROM person WHERE job_company_name='x'" }, 'POST', '/person/search'],
    ['people_data_labs_enrich_company', { website: 'google.com' }, 'GET', '/company/enrich'],
    ['people_data_labs_search_companies', { sql: "SELECT * FROM company WHERE name='x'" }, 'POST', '/company/search'],
    ['people_data_labs_clean_company', { name: 'people data labs' }, 'GET', '/company/clean'],
    ['people_data_labs_clean_location', { location: 'sf ca' }, 'GET', '/location/clean'],
    ['people_data_labs_clean_school', { name: 'uni freiburg' }, 'GET', '/school/clean'],
    ['people_data_labs_autocomplete', { field: 'title', text: 'sales dir' }, 'GET', '/autocomplete'],
    ['people_data_labs_enrich_job_title', { job_title: 'head of procurement' }, 'GET', '/job_title/enrich'],
    ['people_data_labs_enrich_ip', { ip: '72.212.42.169' }, 'GET', '/ip/enrich'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(ALL);
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
    if (method === 'GET') expect(sent().data).toBeUndefined();
  });

  it('enriches a person with the matching inputs and the cost controls in the query', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_enrich_person', {
      first_name: 'sean', last_name: 'thorne', company: 'people data labs', min_likelihood: 6,
      required: 'emails', data_include: 'full_name,job_title', titlecase: true,
    });
    expect(sent().params).toEqual({
      first_name: 'sean', last_name: 'thorne', company: 'people data labs', min_likelihood: 6,
      required: 'emails', data_include: 'full_name,job_title', titlecase: true,
    });
  });

  it('searches people with SQL or an Elasticsearch query in the JSON body, one record by default', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_search_people', { sql: "SELECT * FROM person WHERE location_country='germany'" });
    expect(sent().data).toEqual({ sql: "SELECT * FROM person WHERE location_country='germany'", size: 1 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    const query = { bool: { must: [{ term: { location_country: 'germany' } }] } };
    await call('people_data_labs_search_people', { query, size: 10, scroll_token: '104$14.27', dataset: 'all' });
    expect(sent().data).toEqual({ query, size: 10, scroll_token: '104$14.27', dataset: 'all' });
  });

  it('searches companies the same way', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_search_companies', { sql: "SELECT * FROM company WHERE size='51-200'", size: 3 });
    expect(sent().data).toEqual({ sql: "SELECT * FROM company WHERE size='51-200'", size: 3 });
  });

  it('enriches an IP with the optional location and metadata flags', async () => {
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_enrich_ip', { ip: '72.212.42.169', return_ip_location: true, return_ip_metadata: true, min_confidence: 'high' });
    expect(sent().params).toEqual({ ip: '72.212.42.169', return_ip_location: true, return_ip_metadata: true, min_confidence: 'high' });
  });

  it('autocompletes with the documented field values and ten suggestions by default', async () => {
    expect(tool('people_data_labs_autocomplete').parameters.properties!.field.enum).toEqual([
      'all_location', 'class', 'company', 'country', 'industry', 'location_name', 'major', 'region', 'role', 'school', 'skill', 'sub_role', 'title', 'website',
    ]);
    mockedAxios.mockResolvedValue({ data: { status: 200 } });
    await call('people_data_labs_autocomplete', { field: 'company', text: 'goog' });
    expect(sent().params).toEqual({ field: 'company', text: 'goog', size: 10 });
  });
});

const live = process.env.RUN_PEOPLE_DATA_LABS_LIVE === '1' ? describe : describe.skip;
const KEY = process.env.PEOPLE_DATA_LABS_API_KEY;

live('people-data-labs adapter: live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown>) => call(name, params, { PEOPLE_DATA_LABS_API_KEY: KEY as string });

  it('answers 401 with a wrong key on every route, so each one exists', async () => {
    const wrong = { PEOPLE_DATA_LABS_API_KEY: FAKE_KEY };
    const inputs: Record<string, Record<string, unknown>> = {
      people_data_labs_enrich_person: { email: 'nobody@example.com' },
      people_data_labs_identify_person: { email: 'nobody@example.com' },
      people_data_labs_search_people: { sql: "SELECT * FROM person WHERE job_company_name='x'" },
      people_data_labs_enrich_company: { website: 'example.com' },
      people_data_labs_search_companies: { sql: "SELECT * FROM company WHERE name='x'" },
      people_data_labs_clean_company: { name: 'x' },
      people_data_labs_clean_location: { location: 'berlin' },
      people_data_labs_clean_school: { name: 'x' },
      people_data_labs_autocomplete: { field: 'country', text: 'ger' },
      people_data_labs_enrich_job_title: { job_title: 'engineer' },
      people_data_labs_enrich_ip: { ip: '72.212.42.169' },
    };
    for (const name of ALL) {
      await expect(call(name, inputs[name], wrong)).rejects.toMatchObject({ response: { status: 401 } });
    }
  }, 90_000);

  (KEY ? it : it.skip)('calls the free cleaners and autocomplete', async () => {
    expect((await run('people_data_labs_autocomplete', { field: 'country', text: 'germ', size: 1 })).data.length).toBe(1);
    expect((await run('people_data_labs_clean_location', { location: 'freiburg germany' })).country).toBe('germany');
    expect((await run('people_data_labs_clean_company', { website: 'peopledatalabs.com' })).name).toBeTruthy();
    expect((await run('people_data_labs_clean_school', { name: 'university of freiburg' })).name).toBeTruthy();
  }, 60_000);

  (KEY && process.env.PEOPLE_DATA_LABS_LIVE_PAID === '1' ? it : it.skip)('enriches one company and searches one (up to 2 credits)', async () => {
    const company = await run('people_data_labs_enrich_company', { website: 'peopledatalabs.com', data_include: 'name,website,size' });
    expect(company.status).toBe(200);
    const search = await run('people_data_labs_search_companies', { sql: "SELECT * FROM company WHERE website='peopledatalabs.com'" });
    expect(search.total).toBeGreaterThan(0);
    expect(search.data.length).toBe(1);
  }, 60_000);
});
