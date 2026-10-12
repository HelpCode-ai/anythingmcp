import axios from 'axios';
import * as adapter from './dynamics365-sales.json';
import { RestEngine, serializeRepeatedParams } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Dynamics 365 Sales (Dataverse Web API)
 * adapter:
 *
 *   1. Static: always runs. Pins the Entra sign-in with the environment's own
 *      user_impersonation scope, the OData headers (formatted values, page
 *      size), lookups written as @odata.bind, the If-Match that keeps an update
 *      from turning into an upsert, the QualifyLead / WinOpportunity /
 *      LoseOpportunity bodies, next-page and FetchXML encoding, the metadata
 *      paths, and which tools install switched off.
 *
 *   2. Live: skipped unless DATAVERSE_ACCESS_TOKEN and DYNAMICS_ORG_HOST are
 *      set (a delegated token for https://<host>, e.g. from `az account
 *      get-access-token --resource https://<host>`), against a trial or test
 *      environment:
 *
 *        DATAVERSE_ACCESS_TOKEN=eyJ... DYNAMICS_ORG_HOST=contoso.crm4.dynamics.com \
 *          npx jest src/adapters/intl/dynamics365-sales.live.spec.ts
 *
 *      With D365_LIVE_WRITE=1 as well, a test account, contact, lead, task,
 *      phone call and note are created, the lead is qualified into an
 *      opportunity that is then won, and every row is deleted in `finally`.
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
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

const HOST = 'contoso.crm4.dynamics.com';
const BASE = `https://${HOST}/api/data/v9.2`;
const ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const ID2 = 'cccccccc-4444-5555-6666-dddddddddddd';
const FORMATTED = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';
// Built at run time so no token-shaped literal sits in the source.
const FAKE_TOKEN = ['unit', 'test', 'token'].join('-');

const baseFor = (host: string) => a.connector.baseUrl.replace('{{DYNAMICS_ORG_HOST}}', host);
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(FAKE_TOKEN) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: baseFor(HOST),
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('dynamics365-sales adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live', () => {
    expect(a.unlisted).toBe(true);
  });

  it('says up front that it needs an Entra app, a licence and a security role', () => {
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/user_impersonation/);
    expect(a.prerequisites).toMatch(/security role/);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it("asks for the environment's own user_impersonation scope and calls Web API v9.2 on that host", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'DYNAMICS_ORG_HOST']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'https://{{DYNAMICS_ORG_HOST}}/user_impersonation offline_access',
    });
    expect(a.connector.baseUrl).toBe('https://{{DYNAMICS_ORG_HOST}}/api/data/v9.2');
    expect(a.connector.headers).toMatchObject({
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: FORMATTED,
    });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
  });

  it('takes only a bare environment host, in any region or government cloud', () => {
    const host = new RegExp(a.envVarMeta.DYNAMICS_ORG_HOST.pattern!);
    for (const ok of ['contoso.crm.dynamics.com', 'contoso.crm4.dynamics.com', 'org1a2b3c.crm11.dynamics.com', 'agency.crm9.dynamics.com', 'agency.crm.microsoftdynamics.us', 'agency.crm.appsplatform.us', 'firma.crm.dynamics.cn']) {
      expect(`${ok}:${host.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['https://contoso.crm4.dynamics.com', 'contoso.crm4.dynamics.com/', 'contoso.crm4.dynamics.com/main.aspx', 'contoso', 'contoso.api.crm4.dynamics.com']) {
      expect(`${bad}:${host.test(bad)}`).toBe(`${bad}:false`);
    }
  });

  it('probes with WhoAmI, which needs no arguments', () => {
    expect(a.probe.tool).toBe('d365_who_am_i');
    expect(tool('d365_who_am_i').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/WhoAmI');
  });

  it('prefixes every tool with d365_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^d365_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('installs every delete switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['d365_delete_account', 'd365_delete_contact', 'd365_delete_lead', 'd365_delete_opportunity', 'd365_delete_record']);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(t.enabled).toBe(false);
    for (const name of off) expect(a.instructions).toContain(`\`${name}\``);
  });

  it('marks reads read-only, and qualifying a lead or closing an opportunity destructive with a confirmation', () => {
    for (const t of a.tools) {
      const readOnly = annotationsOf(t).readOnlyHint === true;
      expect(`${t.name}:${readOnly}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    for (const name of ['d365_qualify_lead', 'd365_win_opportunity', 'd365_lose_opportunity', 'd365_disqualify_lead']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('d365_create_account')).destructiveHint).toBe(false);
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}: ${/confirm/i.test(t.description)}`).toBe(`${t.name}: true`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bd365_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...JSON.stringify(t).matchAll(/\bd365_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('sends If-Match on every PATCH, so an update never creates a row', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'PATCH')) {
      expect(`${t.name}:${t.endpointMapping.headers?.['If-Match']}`).toBe(`${t.name}:$etag`);
      expect(t.parameters.properties!.etag.default).toBe('*');
    }
  });

  it.each([
    ['d365_who_am_i', {}, 'GET', '/WhoAmI'],
    ['d365_list_accounts', {}, 'GET', '/accounts'],
    ['d365_get_account', { account_id: ID }, 'GET', `/accounts(${ID})`],
    ['d365_create_account', { name: 'X' }, 'POST', '/accounts'],
    ['d365_update_account', { account_id: ID, fields: { name: 'Y' } }, 'PATCH', `/accounts(${ID})`],
    ['d365_delete_account', { account_id: ID }, 'DELETE', `/accounts(${ID})`],
    ['d365_list_contacts', {}, 'GET', '/contacts'],
    ['d365_get_contact', { contact_id: ID }, 'GET', `/contacts(${ID})`],
    ['d365_create_contact', { lastname: 'Meyer' }, 'POST', '/contacts'],
    ['d365_update_contact', { contact_id: ID, fields: { jobtitle: 'CEO' } }, 'PATCH', `/contacts(${ID})`],
    ['d365_delete_contact', { contact_id: ID }, 'DELETE', `/contacts(${ID})`],
    ['d365_list_leads', {}, 'GET', '/leads'],
    ['d365_get_lead', { lead_id: ID }, 'GET', `/leads(${ID})`],
    ['d365_create_lead', { subject: 'S', lastname: 'L' }, 'POST', '/leads'],
    ['d365_update_lead', { lead_id: ID, fields: { subject: 'S2' } }, 'PATCH', `/leads(${ID})`],
    ['d365_qualify_lead', { lead_id: ID }, 'POST', `/leads(${ID})/Microsoft.Dynamics.CRM.QualifyLead`],
    ['d365_disqualify_lead', { lead_id: ID }, 'PATCH', `/leads(${ID})`],
    ['d365_delete_lead', { lead_id: ID }, 'DELETE', `/leads(${ID})`],
    ['d365_list_opportunities', {}, 'GET', '/opportunities'],
    ['d365_get_opportunity', { opportunity_id: ID }, 'GET', `/opportunities(${ID})`],
    ['d365_create_opportunity', { name: 'O' }, 'POST', '/opportunities'],
    ['d365_update_opportunity', { opportunity_id: ID, fields: { estimatedvalue: 1 } }, 'PATCH', `/opportunities(${ID})`],
    ['d365_win_opportunity', { opportunity_id: ID }, 'POST', '/WinOpportunity'],
    ['d365_lose_opportunity', { opportunity_id: ID }, 'POST', '/LoseOpportunity'],
    ['d365_delete_opportunity', { opportunity_id: ID }, 'DELETE', `/opportunities(${ID})`],
    ['d365_list_activities', {}, 'GET', '/activitypointers'],
    ['d365_get_email', { activity_id: ID }, 'GET', `/emails(${ID})`],
    ['d365_create_task', { subject: 'T' }, 'POST', '/tasks'],
    ['d365_create_phone_call', { subject: 'C' }, 'POST', '/phonecalls'],
    ['d365_create_note', { notetext: 'N' }, 'POST', '/annotations'],
    ['d365_complete_task', { task_id: ID }, 'PATCH', `/tasks(${ID})`],
    ['d365_query', { entity_set: 'salesorders' }, 'GET', '/salesorders'],
    ['d365_next_page', { entity_set: 'accounts', next_query: '$select=name' }, 'GET', '/accounts'],
    ['d365_fetchxml_query', { entity_set: 'accounts', fetch_xml: '<fetch/>' }, 'GET', '/accounts'],
    ['d365_get_record', { entity_set: 'quotes', record_id: ID }, 'GET', `/quotes(${ID})`],
    ['d365_create_record', { entity_set: 'quotes', fields: { name: 'Q' } }, 'POST', '/quotes'],
    ['d365_update_record', { entity_set: 'quotes', record_id: ID, fields: { name: 'Q2' } }, 'PATCH', `/quotes(${ID})`],
    ['d365_delete_record', { entity_set: 'quotes', record_id: ID }, 'DELETE', `/quotes(${ID})`],
    ['d365_list_tables', {}, 'GET', '/EntityDefinitions'],
    ['d365_describe_table', { table: 'account' }, 'GET', "/EntityDefinitions(LogicalName='account')"],
    ['d365_list_lookups', { table: 'contact' }, 'GET', "/EntityDefinitions(LogicalName='contact')/ManyToOneRelationships"],
    ['d365_get_choice_options', { table: 'opportunity', column: 'statuscode', column_type: 'StatusAttributeMetadata' }, 'GET', "/EntityDefinitions(LogicalName='opportunity')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata"],
  ])('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_TOKEN}`, 'OData-Version': '4.0' }),
      }),
    );
  });

  it('has a URL test for every tool', () => {
    expect(a.tools.length).toBe(42);
  });

  it('lists with a short default $select, formatted values and a page size', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('d365_list_accounts', { filter: "contains(name,'Contoso')" });
    expect(sent().params).toEqual({
      $filter: "contains(name,'Contoso')",
      $select: expect.stringMatching(/^accountid,name,/),
    });
    expect(sent().headers.Prefer).toBe(`${FORMATTED},odata.maxpagesize=50`);
    mockedAxios.mockClear();
    await call('d365_query', { entity_set: 'salesorders', select: 'name,totalamount', top: 10, count: true, page_size: 200 });
    expect(sent().params).toEqual({ $select: 'name,totalamount', $top: 10, $count: true });
    expect(sent().headers.Prefer).toBe(`${FORMATTED},odata.maxpagesize=200`);
  });

  it('reads the next page from the query part of @odata.nextLink without encoding it twice', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    const next =
      '$select=name&$skiptoken=%3Ccookie%20pagenumber=%222%22%20pagingcookie=%22%253ccookie%2520page%253d%25221%2522%253e%253caccountid%2520last%253d%2522%257bA1%257d%2522%2520%252f%253e%253c%252fcookie%253e%22%20istracking=%22False%22%20/%3E';
    await call('d365_next_page', { entity_set: 'accounts', next_query: next });
    expect(sent().params).toEqual({
      $select: 'name',
      $skiptoken:
        '<cookie pagenumber="2" pagingcookie="%3ccookie%20page%3d%221%22%3e%3caccountid%20last%3d%22%7bA1%7d%22%20%2f%3e%3c%2fcookie%3e" istracking="False" />',
    });
    // What goes on the wire decodes back to exactly the token Dataverse issued.
    const wire = new URLSearchParams(serializeRepeatedParams(sent().params));
    expect(wire.get('$skiptoken')).toBe(new URLSearchParams(next).get('$skiptoken'));
    expect(sent().headers.Prefer).toBe(`${FORMATTED},odata.maxpagesize=50`);
  });

  it('sends FetchXML as the fetchXml query parameter', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    const xml = '<fetch aggregate="true"><entity name="opportunity"><attribute name="estimatedvalue" alias="total" aggregate="sum"/></entity></fetch>';
    await call('d365_fetchxml_query', { entity_set: 'opportunities', fetch_xml: xml });
    expect(sent().params).toEqual({ fetchXml: xml });
    expect(new URLSearchParams(serializeRepeatedParams(sent().params)).get('fetchXml')).toBe(xml);
  });

  it('writes lookups as @odata.bind, leaves them out when not given, and asks for the row back', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('d365_create_contact', { firstname: 'Ana', lastname: 'Meyer', account_id: ID, fields: { gendercode: 2 } });
    expect(sent().data).toEqual({
      firstname: 'Ana',
      lastname: 'Meyer',
      'parentcustomerid_account@odata.bind': `/accounts(${ID})`,
      gendercode: 2,
    });
    expect(sent().headers.Prefer).toBe(`return=representation,${FORMATTED}`);
    mockedAxios.mockClear();
    await call('d365_create_account', { name: 'Contoso' });
    expect(sent().data).toEqual({ name: 'Contoso' });
    mockedAxios.mockClear();
    await call('d365_create_opportunity', { name: 'Chairs', contact_id: ID2, estimatedvalue: 0 });
    expect(sent().data).toEqual({ name: 'Chairs', 'customerid_contact@odata.bind': `/contacts(${ID2})`, estimatedvalue: 0 });
  });

  it('ties activities and notes to the row they are about', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('d365_create_task', { subject: 'Call back', regarding_lead_id: ID, prioritycode: 2 });
    expect(sent().data).toEqual({ subject: 'Call back', prioritycode: 2, 'regardingobjectid_lead_task@odata.bind': `/leads(${ID})` });
    mockedAxios.mockClear();
    await call('d365_create_phone_call', { subject: 'Follow-up', directioncode: false, regarding_account_id: ID });
    expect(sent().data).toEqual({ subject: 'Follow-up', directioncode: false, 'regardingobjectid_account_phonecall@odata.bind': `/accounts(${ID})` });
    mockedAxios.mockClear();
    await call('d365_create_note', { notetext: 'Met at the fair', regarding_opportunity_id: ID });
    expect(sent().data).toEqual({ notetext: 'Met at the fair', 'objectid_opportunity@odata.bind': `/opportunities(${ID})` });
  });

  it('updates with If-Match * by default or the given etag, and merges the columns into the body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('d365_update_opportunity', { opportunity_id: ID, fields: { estimatedvalue: 25000, description: null } });
    expect(sent().headers['If-Match']).toBe('*');
    expect(sent().data).toEqual({ estimatedvalue: 25000, description: null });
    mockedAxios.mockClear();
    await call('d365_update_record', { entity_set: 'quotes', record_id: ID, fields: { name: 'Q' }, etag: 'W/"123456"' });
    expect(sent().headers['If-Match']).toBe('W/"123456"');
    mockedAxios.mockClear();
    await call('d365_disqualify_lead', { lead_id: ID });
    expect(sent().data).toEqual({ statecode: 2, statuscode: 6 });
    mockedAxios.mockClear();
    await call('d365_complete_task', { task_id: ID });
    expect(sent().data).toEqual({ statecode: 1, statuscode: 5 });
  });

  it('qualifies a lead with the documented parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('d365_qualify_lead', { lead_id: ID });
    expect(sent().data).toEqual({ CreateAccount: true, CreateContact: true, CreateOpportunity: true, Status: 3 });
    mockedAxios.mockClear();
    await call('d365_qualify_lead', { lead_id: ID, create_account: false, currency_id: ID2 });
    expect(sent().data).toEqual({
      CreateAccount: false,
      CreateContact: true,
      CreateOpportunity: true,
      Status: 3,
      'OpportunityCurrencyId@odata.bind': `/transactioncurrencies(${ID2})`,
    });
  });

  it('closes an opportunity through WinOpportunity and LoseOpportunity with an opportunity close', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('d365_win_opportunity', { opportunity_id: ID, actual_revenue: 18000, close_date: '2026-10-12' });
    expect(sent().data).toEqual({
      Status: 3,
      OpportunityClose: {
        subject: 'Won',
        'opportunityid@odata.bind': `/opportunities(${ID})`,
        actualrevenue: 18000,
        actualend: '2026-10-12',
      },
    });
    mockedAxios.mockClear();
    await call('d365_lose_opportunity', { opportunity_id: ID, status: 5, description: 'Lost on price' });
    expect(sent().data).toEqual({
      Status: 5,
      OpportunityClose: { subject: 'Lost', 'opportunityid@odata.bind': `/opportunities(${ID})`, description: 'Lost on price' },
    });
  });

  it('keeps metadata answers small with fixed selects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('d365_describe_table', { table: 'account' });
    expect(sent().params).toEqual({
      $select: 'LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute',
      $expand: 'Attributes($select=LogicalName,AttributeType,RequiredLevel,IsValidForCreate,IsValidForUpdate)',
    });
    mockedAxios.mockClear();
    await call('d365_list_tables', { filter: 'IsCustomEntity eq true' });
    expect(sent().params).toEqual({ $select: 'LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute', $filter: 'IsCustomEntity eq true' });
    mockedAxios.mockClear();
    await call('d365_get_choice_options', { table: 'account', column: 'industrycode' });
    expect(sent().url).toBe(`${BASE}/EntityDefinitions(LogicalName='account')/Attributes(LogicalName='industrycode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`);
    expect(sent().params).toEqual({ $select: 'LogicalName', $expand: 'OptionSet' });
  });
});

const TOKEN = process.env.DATAVERSE_ACCESS_TOKEN;
const LIVE_HOST = process.env.DYNAMICS_ORG_HOST;
const live = TOKEN && LIVE_HOST ? describe : describe.skip;

live('dynamics365-sales adapter: live Dataverse Web API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: baseFor(LIVE_HOST as string), authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('identifies the user and reads the sales tables with formatted values', async () => {
    const me = await run('d365_who_am_i');
    expect(typeof me.UserId).toBe('string');
    for (const name of ['d365_list_accounts', 'd365_list_contacts', 'd365_list_leads', 'd365_list_opportunities', 'd365_list_activities']) {
      const page = await run(name, { top: 3 });
      expect(Array.isArray(page.value)).toBe(true);
      if (page.value.length) expect(page.value[0]['statecode@OData.Community.Display.V1.FormattedValue']).toBeDefined();
    }
  }, 120_000);

  it('pages through accounts with nextLink and runs FetchXML', async () => {
    const first = await run('d365_query', { entity_set: 'accounts', select: 'name', page_size: 2 });
    if (first['@odata.nextLink']) {
      const next = String(first['@odata.nextLink']).split('?')[1];
      const second = await run('d365_next_page', { entity_set: 'accounts', next_query: next, page_size: 2 });
      expect(second.value.length).toBeGreaterThan(0);
      expect(second.value[0].accountid).not.toBe(first.value[0].accountid);
    }
    const count = await run('d365_fetchxml_query', {
      entity_set: 'accounts',
      fetch_xml: '<fetch aggregate="true"><entity name="account"><attribute name="accountid" alias="n" aggregate="count"/></entity></fetch>',
    });
    expect(typeof count.value[0].n).toBe('number');
  }, 120_000);

  it('reads table metadata, lookups and choice options', async () => {
    const account = await run('d365_describe_table', { table: 'account' });
    expect(account.EntitySetName).toBe('accounts');
    expect(account.Attributes.some((x: { LogicalName: string }) => x.LogicalName === 'name')).toBe(true);
    const lookups = await run('d365_list_lookups', { table: 'contact' });
    expect(lookups.value.map((r: { ReferencingEntityNavigationPropertyName: string }) => r.ReferencingEntityNavigationPropertyName)).toContain('parentcustomerid_account');
    const status = await run('d365_get_choice_options', { table: 'opportunity', column: 'statuscode', column_type: 'StatusAttributeMetadata' });
    expect(status.OptionSet.Options.length).toBeGreaterThan(2);
    const tables = await run('d365_list_tables', { filter: "LogicalName eq 'opportunity'" });
    expect(tables.value[0].EntitySetName).toBe('opportunities');
  }, 120_000);

  (process.env.D365_LIVE_WRITE === '1' ? it : it.skip)(
    'creates test rows, logs activities, qualifies a lead, wins the opportunity, then deletes everything',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const created: Array<[string, string]> = [];
      try {
        const account = await run('d365_create_account', { name: `AnythingMCP test ${stamp}`, address1_city: 'Freiburg' });
        created.push(['accounts', account.accountid]);
        const contact = await run('d365_create_contact', { firstname: 'Test', lastname: `AnythingMCP ${stamp}`, account_id: account.accountid });
        created.push(['contacts', contact.contactid]);
        expect(contact._parentcustomerid_value).toBe(account.accountid);

        const updated = await run('d365_update_account', { account_id: account.accountid, fields: { telephone1: '0761 000000' }, etag: account['@odata.etag'] });
        expect(updated.telephone1).toBe('0761 000000');
        await expect(
          run('d365_update_account', { account_id: account.accountid, fields: { telephone1: 'x' }, etag: account['@odata.etag'] }),
        ).rejects.toMatchObject({ response: { status: 412 } });
        await expect(run('d365_update_account', { account_id: 'aaaaaaaa-0000-0000-0000-000000000000', fields: { name: 'x' } })).rejects.toMatchObject({
          response: { status: 404 },
        });

        const task = await run('d365_create_task', { subject: 'AnythingMCP test task', regarding_account_id: account.accountid });
        created.push(['tasks', task.activityid]);
        await run('d365_complete_task', { task_id: task.activityid });
        const call = await run('d365_create_phone_call', { subject: 'AnythingMCP test call', regarding_contact_id: contact.contactid });
        created.push(['phonecalls', call.activityid]);
        const note = await run('d365_create_note', { subject: 'AnythingMCP', notetext: 'test note', regarding_account_id: account.accountid });
        created.push(['annotations', note.annotationid]);

        const lead = await run('d365_create_lead', { subject: `AnythingMCP test lead ${stamp}`, lastname: 'Lead', companyname: 'AnythingMCP test' });
        created.push(['leads', lead.leadid]);
        const qualified = await run('d365_qualify_lead', { lead_id: lead.leadid, create_account: false, create_contact: false });
        const opportunity = (qualified.value as Array<Record<string, string>>).find((r) => r.opportunityid);
        expect(opportunity).toBeDefined();
        created.unshift(['opportunities', opportunity!.opportunityid]);
        await run('d365_update_opportunity', { opportunity_id: opportunity!.opportunityid, fields: { 'customerid_account@odata.bind': `/accounts(${account.accountid})` } });
        await run('d365_win_opportunity', { opportunity_id: opportunity!.opportunityid, actual_revenue: 1000 });
        const won = await run('d365_get_opportunity', { opportunity_id: opportunity!.opportunityid, select: 'statecode' });
        expect(won.statecode).toBe(1);
      } finally {
        for (const [entitySet, id] of created) {
          await run('d365_delete_record', { entity_set: entitySet, record_id: id }).catch(() => undefined);
        }
      }
    },
    240_000,
  );
});
