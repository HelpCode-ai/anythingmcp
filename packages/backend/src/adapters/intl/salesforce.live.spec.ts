import * as adapter from './salesforce.json';
import axios, { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { normalizeSubdomainVariables } from '../../common/base-url-variable.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers of verification for the Salesforce adapter:
 *
 *   1. Static, always runs. Pins the request each tool sends (through the real
 *      RestEngine with axios mocked), the trimmed describe responses, the My
 *      Domain normalisation, and the token handling Salesforce needs: its token
 *      endpoint answers without `expires_in`, so the engine's one-hour default
 *      applies and an earlier session timeout is caught by the 401 retry.
 *
 *   2. Live, skipped unless both variables are set. Needs a Salesforce org
 *      (a free Developer Edition works) and an access token for it, e.g. from
 *      the Salesforce CLI: `sf org login web` then `sf org display` shows the
 *      Access Token and the Instance Url.
 *
 *        SALESFORCE_MY_DOMAIN=acme-dev-ed.develop SALESFORCE_ACCESS_TOKEN=00D... \
 *          npx jest src/adapters/intl/salesforce.live.spec.ts
 *
 *      The live block only reads; it creates and updates nothing.
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
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Mapping;
  responseMapping?: Record<string, unknown>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string }>;
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
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
    for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

const BASE = 'https://acme.my.salesforce.com/services/data/v67.0';
const newEngine = (tokens?: Partial<OAuth2TokenService>) =>
  new RestEngine(
    {
      getAccessToken: jest.fn().mockResolvedValue('test-token'),
      ...tokens,
    } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const config = () => ({
  baseUrl: BASE,
  authType: 'OAUTH2',
  authConfig: {
    clientId: 'ck',
    clientSecret: 'cs',
    tokenUrl: 'https://acme.my.salesforce.com/services/oauth2/token',
    accessToken: 'test-token',
    refreshToken: 'rt',
  },
  headers: a.connector.headers,
});
const call = async (name: string, params: Record<string, unknown>) => {
  mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
  await newEngine().execute(config(), tool(name).endpointMapping, params);
  return mockedAxios.mock.calls[0][0] as {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    data?: unknown;
    headers: Record<string, string>;
  };
};

describe('salesforce adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 8 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in and renews tokens on the org own My Domain, so sandboxes work', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual([
      'SALESFORCE_MY_DOMAIN',
      'SALESFORCE_CLIENT_ID',
      'SALESFORCE_CLIENT_SECRET',
    ]);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{SALESFORCE_CLIENT_ID}}',
      clientSecret: '{{SALESFORCE_CLIENT_SECRET}}',
      authorizationUrl: 'https://{{SALESFORCE_MY_DOMAIN}}.my.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://{{SALESFORCE_MY_DOMAIN}}.my.salesforce.com/services/oauth2/token',
      scopes: 'api refresh_token offline_access',
    });
    expect(a.connector.baseUrl).toBe(
      'https://{{SALESFORCE_MY_DOMAIN}}.my.salesforce.com/services/data/v67.0',
    );
    expect(a.envVarMeta.SALESFORCE_MY_DOMAIN.kind).toBe('address');
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it.each([
    ['acme', 'acme'],
    ['https://acme.my.salesforce.com/lightning/page/home', 'acme'],
    ['acme--uat.sandbox.my.salesforce.com', 'acme--uat.sandbox'],
    ['https://acme-dev-ed.develop.my.salesforce.com/', 'acme-dev-ed.develop'],
  ])('keeps the My Domain label of %s', (typed, stored) => {
    const out = normalizeSubdomainVariables(a.connector.baseUrl, { SALESFORCE_MY_DOMAIN: typed });
    expect(out.SALESFORCE_MY_DOMAIN).toBe(stored);
  });

  it('probes on the API root, which every API user can read', async () => {
    expect(a.probe.tool).toBe('salesforce_get_api_resources');
    expect(a.connector.healthcheckPath).toBe('/');
    const req = await call('salesforce_get_api_resources', {});
    expect(req.url).toBe(`${BASE}/`);
    expect(req.headers.Authorization).toBe('Bearer test-token');
  });

  it('has no DELETE tool and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      refs(m.headers, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of t.parameters?.required ?? []) {
        expect(Object.keys(t.parameters.properties ?? {})).toContain(p);
      }
    }
  });

  it('names the API in the description of the free-form query tools', () => {
    for (const n of ['salesforce_query', 'salesforce_search_sosl']) {
      expect(tool(n).description).toMatch(
        /Queries the Salesforce REST API, see https:\/\/developer\.salesforce\.com\/docs\//,
      );
    }
  });

  it('sends SOQL as q and the batch size only when asked', async () => {
    const q = 'SELECT Id, Name FROM Account LIMIT 5';
    let req = await call('salesforce_query', { q });
    expect(req.url).toBe(`${BASE}/query`);
    expect(req.params).toEqual({ q });
    expect(req.headers['Sforce-Query-Options']).toBeUndefined();
    mockedAxios.mockReset();
    req = await call('salesforce_query', { q, batch_size: 500 });
    expect(req.headers['Sforce-Query-Options']).toBe('batchSize=500');
  });

  it('pages with the locator from nextRecordsUrl', async () => {
    const req = await call('salesforce_query_more', { locator: '01gRO0000016PIAYA2-500' });
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}/query/01gRO0000016PIAYA2-500`);
  });

  it('encodes path values, so an id cannot climb out of the resource', async () => {
    const req = await call('salesforce_get_record', {
      sobject: 'Account',
      record_id: '../../limits',
      fields: 'Name,Industry',
    });
    expect(req.url).toBe(`${BASE}/sobjects/Account/..%2F..%2Flimits`);
    expect(req.params).toEqual({ fields: 'Name,Industry' });
  });

  it('searches with repeated sobject parameters', async () => {
    const req = await call('salesforce_search_text', {
      q: 'Acme',
      sobject: ['Account', 'Contact'],
      fields: 'Id,Name',
      overall_limit: 10,
    });
    expect(req.url).toBe(`${BASE}/parameterizedSearch`);
    expect(req.params).toEqual({ q: 'Acme', sobject: ['Account', 'Contact'], fields: 'Id,Name', overallLimit: 10 });
    const sosl = await (async () => {
      mockedAxios.mockReset();
      return call('salesforce_search_sosl', { q: 'FIND {Acme*} RETURNING Account(Id)' });
    })();
    expect(sosl.url).toBe(`${BASE}/search`);
    expect(sosl.params).toEqual({ q: 'FIND {Acme*} RETURNING Account(Id)' });
  });

  it('creates and updates with the fields object as the body', async () => {
    const fields = { LastName: 'Rossi', Email: 'ana@example.com' };
    let req = await call('salesforce_create_record', { sobject: 'Contact', fields });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${BASE}/sobjects/Contact`);
    expect(req.data).toEqual(fields);
    mockedAxios.mockReset();
    req = await call('salesforce_update_record', {
      sobject: 'Opportunity',
      record_id: '006RO000001abcdYAA',
      fields: { StageName: 'Closed Won' },
    });
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe(`${BASE}/sobjects/Opportunity/006RO000001abcdYAA`);
    expect(req.data).toEqual({ StageName: 'Closed Won' });
  });

  it('creates record trees under records', async () => {
    const records = [{ attributes: { type: 'Account', referenceId: 'a1' }, Name: 'Acme' }];
    const req = await call('salesforce_create_record_tree', { sobject: 'Account', records });
    expect(req.url).toBe(`${BASE}/composite/tree/Account`);
    expect(req.data).toEqual({ records });
  });

  it('reads list views and recent items', async () => {
    let req = await call('salesforce_get_list_view_results', {
      sobject: 'Lead',
      list_view_id: '00BRO000000abcd',
      limit: 5,
      offset: 10,
    });
    expect(req.url).toBe(`${BASE}/sobjects/Lead/listviews/00BRO000000abcd/results`);
    expect(req.params).toEqual({ limit: 5, offset: 10 });
    mockedAxios.mockReset();
    req = await call('salesforce_list_recently_viewed', { limit: 20 });
    expect(req.url).toBe(`${BASE}/recent`);
    expect(req.params).toEqual({ limit: 20 });
  });

  it('marks reads read-only and writes as writes', () => {
    const ann = (t: Tool) =>
      deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping });
    const writes = a.tools.filter((t) => ann(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual([
      'salesforce_create_record',
      'salesforce_create_record_tree',
      'salesforce_update_record',
    ]);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsalesforce_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsalesforce_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const n of mentioned) expect(names).toContain(n);
  });

  it('trims the global describe to queryable objects without companion objects', () => {
    const raw = {
      encoding: 'UTF-8',
      maxBatchSize: 200,
      sobjects: [
        { name: 'Account', label: 'Account', custom: false, queryable: true, createable: true, updateable: true, keyPrefix: '001', urls: {} },
        { name: 'AccountShare', label: 'Account Share', custom: false, queryable: true },
        { name: 'AccountHistory', label: 'Account History', custom: false, queryable: true },
        { name: 'AccountFeed', label: 'Account Feed', custom: false, queryable: true },
        { name: 'AccountChangeEvent', label: 'Account Change Event', custom: false, queryable: true },
        { name: 'Invoice__c', label: 'Invoice', custom: true, queryable: true, createable: true, updateable: true, keyPrefix: 'a00' },
        { name: 'Hidden', label: 'Hidden', custom: false, queryable: false },
      ],
    };
    const out = applyResponseTransform(raw, tool('salesforce_list_objects').responseMapping);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      encoding: 'UTF-8',
      maxBatchSize: 200,
      sobjects: [
        { name: 'Account', label: 'Account', custom: false, createable: true, updateable: true, keyPrefix: '001' },
        { name: 'Invoice__c', label: 'Invoice', custom: true, createable: true, updateable: true, keyPrefix: 'a00' },
      ],
    });
  });

  it('trims an object describe to what queries and writes need', () => {
    const raw = {
      name: 'Account', label: 'Account', labelPlural: 'Accounts', keyPrefix: '001', custom: false,
      createable: true, updateable: true, queryable: true, searchable: true, urls: {},
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false, createable: true, updateable: true, defaultedOnCreate: false, custom: false, calculated: false, unique: false, nameField: true, referenceTo: [], relationshipName: null, restrictedPicklist: false, picklistValues: [], soapType: 'xsd:string' },
        { name: 'OwnerId', label: 'Owner ID', type: 'reference', length: 18, nillable: false, createable: true, updateable: true, defaultedOnCreate: true, custom: false, calculated: false, unique: false, nameField: false, referenceTo: ['User'], relationshipName: 'Owner', restrictedPicklist: false, picklistValues: [] },
        { name: 'Industry', label: 'Industry', type: 'picklist', length: 255, nillable: true, createable: true, updateable: true, defaultedOnCreate: false, custom: false, calculated: false, unique: false, nameField: false, referenceTo: [], relationshipName: null, restrictedPicklist: false, picklistValues: [{ active: true, value: 'Banking', label: 'Banking' }, { active: false, value: 'Old', label: 'Old' }] },
      ],
      childRelationships: [
        { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', cascadeDelete: false },
        { childSObject: 'AccountShare', field: 'AccountId', relationshipName: null },
      ],
      recordTypeInfos: [{ name: 'Master', developerName: 'Master', recordTypeId: '012000000000000AAA', active: true, available: true, defaultRecordTypeMapping: true, master: true, urls: {} }],
    };
    const out = applyResponseTransform(raw, tool('salesforce_describe_object').responseMapping);
    expect(out.error).toBeUndefined();
    const v = out.value as any;
    expect(v.fields.map((f: any) => [f.name, f.required])).toEqual([
      ['Name', true],
      ['OwnerId', false],
      ['Industry', false],
    ]);
    expect(v.fields[2].picklistValues).toEqual(['Banking']);
    expect(v.fields[1]).toMatchObject({ referenceTo: ['User'], relationshipName: 'Owner' });
    expect(v.fields[0].soapType).toBeUndefined();
    expect(v.childRelationships).toEqual([
      { relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' },
    ]);
    expect(v.recordTypeInfos[0].recordTypeId).toBe('012000000000000AAA');
    expect(v.urls).toBeUndefined();
  });
});

describe('salesforce adapter: token lifecycle without expires_in', () => {
  const salesforceTokenResponse = {
    access_token: '00Dxx!new-session',
    signature: 'sig',
    scope: 'refresh_token api',
    instance_url: 'https://acme.my.salesforce.com',
    id: 'https://login.salesforce.com/id/00Dxx0000001gPLEAY/005xx000001SwiUAAS',
    token_type: 'Bearer',
    issued_at: '1791442264000',
  };
  let post: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    post = jest.spyOn(axios, 'post');
  });
  afterEach(() => post.mockRestore());

  const tokenService = () => {
    const prisma = { connector: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() } };
    const cfg = { get: jest.fn().mockReturnValue('test-encryption-key-32-chars!!!!') };
    return new OAuth2TokenService(prisma as any, cfg as unknown as ConfigService);
  };

  it('treats a renewed token as valid for an hour and keeps the refresh token', async () => {
    post.mockResolvedValue({ data: salesforceTokenResponse });
    const svc = tokenService();
    const auth = { ...config().authConfig };
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    expect(await svc.refreshToken(auth)).toBe('00Dxx!new-session');
    const body = new URLSearchParams(post.mock.calls[0][1]);
    expect(post.mock.calls[0][0]).toBe('https://acme.my.salesforce.com/services/oauth2/token');
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: 'ck',
      client_secret: 'cs',
    });
    // No expires_in: the token counts as valid for an hour. 50 minutes later
    // the cached one is reused; 56 minutes later (inside the 5-minute
    // window) it is renewed before use.
    now.mockReturnValue(t0 + 50 * 60_000);
    expect(await svc.getAccessToken(auth)).toBe('00Dxx!new-session');
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValue({ data: { ...salesforceTokenResponse, access_token: '00Dxx!second' } });
    now.mockReturnValue(t0 + 56 * 60_000);
    expect(await svc.getAccessToken(auth)).toBe('00Dxx!second');
    expect(post).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('renews and retries once when Salesforce answers 401 INVALID_SESSION_ID', async () => {
    post.mockResolvedValue({ data: salesforceTokenResponse });
    const svc = tokenService();
    jest.spyOn(svc, 'getAccessToken').mockResolvedValue('expired-session');
    const expired = new AxiosError('Request failed with status code 401');
    (expired as any).response = {
      status: 401,
      data: [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }],
      headers: {},
    };
    mockedAxios
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce({ status: 200, data: { totalSize: 0, done: true, records: [] }, headers: {} });

    const engine = new RestEngine(svc, {} as LoginTokenService);
    const out = (await engine.execute(config(), tool('salesforce_query').endpointMapping, {
      q: 'SELECT Id FROM Account LIMIT 1',
    })) as any;

    expect(out).toEqual({ totalSize: 0, done: true, records: [] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(mockedAxios.mock.calls[0][0].headers.Authorization).toBe('Bearer expired-session');
    expect(mockedAxios.mock.calls[1][0].headers.Authorization).toBe('Bearer 00Dxx!new-session');
  });
});

const DOMAIN = process.env.SALESFORCE_MY_DOMAIN;
const TOKEN = process.env.SALESFORCE_ACCESS_TOKEN;
const live = DOMAIN && TOKEN ? describe : describe.skip;

live('salesforce adapter: live read-only calls', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const liveBase = a.connector.baseUrl.replace('{{SALESFORCE_MY_DOMAIN}}', DOMAIN ?? '');
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    newEngine().execute(
      {
        baseUrl: liveBase,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  it('lists the API resources with the identity URL', async () => {
    const res = await run('salesforce_get_api_resources');
    expect(res.sobjects).toBe('/services/data/v67.0/sobjects');
    expect(res.identity).toMatch(/\/id\/00D\w+\/005\w+$/);
  }, 30000);

  it('lists objects and describes Account through the trimmed shape', async () => {
    const list = applyResponseTransform(await run('salesforce_list_objects'), tool('salesforce_list_objects').responseMapping);
    expect(list.error).toBeUndefined();
    expect((list.value as any).sobjects.map((o: any) => o.name)).toContain('Account');
    const desc = applyResponseTransform(
      await run('salesforce_describe_object', { sobject: 'Account' }),
      tool('salesforce_describe_object').responseMapping,
    );
    expect(desc.error).toBeUndefined();
    const name = (desc.value as any).fields.find((f: any) => f.name === 'Name');
    expect(name.required).toBe(true);
  }, 30000);

  it('queries, pages and reads a record', async () => {
    const res = await run('salesforce_query', { q: 'SELECT Id, Name FROM Account ORDER BY CreatedDate', batch_size: 200 });
    expect(typeof res.totalSize).toBe('number');
    if (!res.done) {
      const locator = String(res.nextRecordsUrl).split('/').pop();
      const more = await run('salesforce_query_more', { locator });
      expect(Array.isArray(more.records)).toBe(true);
    }
    if (res.records.length) {
      const rec = await run('salesforce_get_record', { sobject: 'Account', record_id: res.records[0].Id, fields: 'Name' });
      expect(rec.Name).toBe(res.records[0].Name);
    }
  }, 30000);

  it('searches, lists views and recent items', async () => {
    const found = await run('salesforce_search_text', { q: 'Ed*', sobject: ['Account'], fields: 'Id,Name', overall_limit: 5 });
    expect(Array.isArray(found.searchRecords)).toBe(true);
    const views = await run('salesforce_list_list_views', { sobject: 'Account' });
    expect(Array.isArray(views.listviews)).toBe(true);
    if (views.listviews.length) {
      const rows = await run('salesforce_get_list_view_results', { sobject: 'Account', list_view_id: views.listviews[0].id, limit: 5 });
      expect(Array.isArray(rows.records)).toBe(true);
    }
    const recent = await run('salesforce_list_recently_viewed', { limit: 5 });
    expect(Array.isArray(recent)).toBe(true);
  }, 30000);
});
