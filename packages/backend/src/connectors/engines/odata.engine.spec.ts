import { readFileSync } from 'fs';
import { join } from 'path';
import { ODataEngine, normalizeSettings } from './odata.engine';
import { assertSafeServicePath, buildKeyPredicate, serviceAllowed } from '../odata/odata-values';
import { parseEdmx } from '../odata/edmx.parser';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'odata', '__fixtures__', name), 'utf8');

interface Call {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  rawBody?: boolean;
}

/**
 * A RestEngine stand-in: resolves the `$param` references in queryParams the
 * way RestEngine does and answers from a route table keyed by path.
 */
function fakeRest(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const executeWithMeta = jest.fn(async (_config: any, mapping: any, params: any) => {
    const query: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mapping.queryParams ?? {})) {
      query[k] = typeof v === 'string' && v.startsWith('$') ? params[v.slice(1)] : v;
      if (query[k] === undefined) delete query[k];
    }
    const call: Call = {
      method: mapping.method,
      path: mapping.path,
      query,
      headers: mapping.headers ?? {},
      rawBody: mapping.rawBody,
    };
    calls.push(call);
    const route = routes[mapping.path];
    if (!route) {
      const err: any = new Error(`404 ${mapping.path}`);
      err.response = { status: 404 };
      throw err;
    }
    const out = route(call);
    return out && typeof out === 'object' && 'body' in (out as object)
      ? (out as { body: unknown; headers: Record<string, string> })
      : { body: out, headers: {} };
  });
  return { rest: { executeWithMeta } as any, calls };
}

const sapConfig = {
  baseUrl: 'https://s4.example.test:44300',
  authType: 'BASIC_AUTH',
  authConfig: { username: 'u', password: 'p' },
  connectorId: 'c1',
};
const sap = { sapClient: '100', sapLanguage: 'EN' };
const SVC = '/sap/opu/odata/sap/C_GLREVENUEEXPENSES_CDS';

describe('ODataEngine', () => {
  describe('list services (SAP catalog)', () => {
    it('merges the V2 and V4 catalogs, keeps paths only, and searches', async () => {
      const { rest, calls } = fakeRest({
        '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection': () => ({
          d: {
            results: [
              {
                __metadata: {},
                ID: 'API_BUSINESS_PARTNER_0001',
                TechnicalServiceName: 'API_BUSINESS_PARTNER',
                Title: 'API_BUSINESS_PARTNER',
                Description: 'Business Partner (A2X)',
                ServiceUrl: 'https://s4.example.test:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/',
              },
              {
                TechnicalServiceName: 'C_GLREVENUEEXPENSES_CDS',
                Title: 'C_GLREVENUEEXPENSES_CDS',
                Description: 'GL Revenue and Expenses Overview',
                ServiceUrl: `https://s4.example.test:44300${SVC}/`,
              },
            ],
          },
        }),
        '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups': () => ({
          value: [
            {
              Description: 'Sales Order (A2X)',
              DefaultSystem: {
                Services: [
                  {
                    ServiceId: 'API_SALESORDER',
                    ServiceUrl: '/sap/opu/odata4/sap/api_salesorder/srvd_a2x/sap/salesorder/0001/',
                  },
                ],
              },
            },
          ],
        }),
      });
      const engine = new ODataEngine(rest);
      const all: any = await engine.execute(sapConfig, { method: 'odata_list_services' }, {}, sap);
      expect(all.total).toBe(3);
      expect(all.services.map((s: any) => s.service)).toEqual([
        '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
        SVC,
        '/sap/opu/odata4/sap/api_salesorder/srvd_a2x/sap/salesorder/0001',
      ]);
      expect(calls[0].query).toMatchObject({ 'sap-client': '100', 'sap-language': 'EN', $format: 'json' });

      const hits: any = await engine.execute(
        sapConfig,
        { method: 'odata_list_services' },
        { search: 'revenue expenses' },
        sap,
      );
      expect(hits.services).toEqual([
        expect.objectContaining({ service: SVC, description: 'GL Revenue and Expenses Overview', version: 'v2' }),
      ]);
      // cached: no second catalog fetch
      expect(calls.filter((c) => c.path.includes('CATALOGSERVICE'))).toHaveLength(1);
    });

    it('applies the services allow-list', async () => {
      const { rest } = fakeRest({
        '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection': () => ({
          d: {
            results: [
              { TechnicalServiceName: 'A', ServiceUrl: '/sap/opu/odata/sap/API_A' },
              { TechnicalServiceName: 'B', ServiceUrl: '/sap/opu/odata/sap/ZB' },
            ],
          },
        }),
      });
      const out: any = await new ODataEngine(rest).execute(
        sapConfig,
        { method: 'odata_list_services' },
        {},
        { ...sap, services: ['/sap/opu/odata/sap/API_*'] },
      );
      expect(out.services.map((s: any) => s.name)).toEqual(['A']);
    });
  });

  describe('describe and query', () => {
    const routes = (rows: unknown[], extra: Record<string, (c: Call) => unknown> = {}) => ({
      [`${SVC}/$metadata`]: () => fixture('sap-v2-analytical.xml'),
      [`${SVC}/C_GLRevenueExpensesResults`]: () => ({
        d: { __count: '3', results: rows, __next: `https://s4.example.test:44300${SVC}/C_GLRevenueExpensesResults?$skiptoken=2` },
      }),
      ...extra,
    });

    it('describes a service and an analytical entity with hints', async () => {
      const { rest, calls } = fakeRest(routes([]));
      const engine = new ODataEngine(rest);
      const svc: any = await engine.execute(sapConfig, { method: 'odata_describe_service' }, { service: SVC }, sap);
      expect(svc.version).toBe('v2');
      expect(svc.entitySets[0]).toMatchObject({
        name: 'C_GLRevenueExpensesResults',
        analytical: true,
        requiredInFilter: ['CompanyCode'],
        readOnly: true,
      });
      expect(calls[0]).toMatchObject({ path: `${SVC}/$metadata`, rawBody: true });
      expect(calls[0].query).toMatchObject({ 'sap-client': '100' });
      expect(calls[0].query.$format).toBeUndefined();

      const ent: any = await engine.execute(
        sapConfig,
        { method: 'odata_describe_entity' },
        { service: SVC, entity_set: 'c_glrevenueexpensesresults' },
        sap,
      );
      expect(ent.entitySet).toBe('C_GLRevenueExpensesResults');
      expect(ent.hints.join(' ')).toMatch(/Analytical set/);
      expect(ent.hints.join(' ')).toMatch(/AmountInCompanyCodeCurrency \(in CompanyCodeCurrency\)/);
      // metadata cached
      expect(calls.filter((c) => c.path.endsWith('$metadata'))).toHaveLength(1);
    });

    it('builds the query, follows the next link on the same host and flattens V2 rows', async () => {
      const page2 = { d: { results: [{ CompanyCode: '1000', FiscalPeriod: '003', AmountInCompanyCodeCurrency: '5.000', PostingDate: '/Date(1735689600000)/' }] } };
      const { rest, calls } = fakeRest(
        routes(
          [
            { __metadata: { uri: 'x' }, CompanyCode: '1000', FiscalPeriod: '001', AmountInCompanyCodeCurrency: '10.500' },
            { CompanyCode: '1000', FiscalPeriod: '002', AmountInCompanyCodeCurrency: '-3.250' },
          ],
          { [`https://s4.example.test:44300${SVC}/C_GLRevenueExpensesResults`]: () => page2 },
        ),
      );
      const out: any = await new ODataEngine(rest).execute(
        sapConfig,
        { method: 'odata_query' },
        {
          service: SVC,
          entity_set: 'C_GLRevenueExpensesResults',
          select: 'CompanyCode, FiscalPeriod,AmountInCompanyCodeCurrency,CompanyCodeCurrency',
          filter: "CompanyCode eq '1000' and FiscalYear eq '2026'",
          orderby: 'FiscalPeriod asc',
          top: 3,
        },
        sap,
      );
      const first = calls.find((c) => c.path === `${SVC}/C_GLRevenueExpensesResults`)!;
      expect(first.query).toEqual({
        $select: 'CompanyCode,FiscalPeriod,AmountInCompanyCodeCurrency,CompanyCodeCurrency',
        $filter: "CompanyCode eq '1000' and FiscalYear eq '2026'",
        $orderby: 'FiscalPeriod asc',
        $top: '3',
        $inlinecount: 'allpages',
        $format: 'json',
        'sap-client': '100',
        'sap-language': 'EN',
      });
      const next = calls.find((c) => c.path.startsWith('https://'))!;
      expect(next.query).toMatchObject({ $skiptoken: '2', 'sap-client': '100' });
      expect(out).toEqual({
        entitySet: 'C_GLRevenueExpensesResults',
        total: 3,
        returned: 3,
        rows: [
          { CompanyCode: '1000', FiscalPeriod: '001', AmountInCompanyCodeCurrency: '10.500' },
          { CompanyCode: '1000', FiscalPeriod: '002', AmountInCompanyCodeCurrency: '-3.250' },
          { CompanyCode: '1000', FiscalPeriod: '003', AmountInCompanyCodeCurrency: '5.000', PostingDate: '2025-01-01T00:00:00.000Z' },
        ],
      });
    });

    it('refuses a next link on another host', async () => {
      const { rest } = fakeRest({
        ...routes([{ CompanyCode: '1' }]),
        [`${SVC}/C_GLRevenueExpensesResults`]: () => ({
          d: { results: [{ CompanyCode: '1' }], __next: 'https://evil.example.test/steal' },
        }),
      });
      await expect(
        new ODataEngine(rest).execute(
          sapConfig,
          { method: 'odata_query' },
          { service: SVC, entity_set: 'C_GLRevenueExpensesResults', filter: "CompanyCode eq '1'", top: 50 },
          sap,
        ),
      ).rejects.toThrow(/another host/);
    });

    it('explains unknown fields and missing required filters before calling SAP', async () => {
      const { rest, calls } = fakeRest(routes([]));
      const engine = new ODataEngine(rest);
      await expect(
        engine.execute(
          sapConfig,
          { method: 'odata_query' },
          { service: SVC, entity_set: 'C_GLRevenueExpensesResults', select: 'CompanyCod', filter: "CompanyCode eq '1'" },
          sap,
        ),
      ).rejects.toThrow(/Unknown field "CompanyCod".*Did you mean: CompanyCode/);
      await expect(
        engine.execute(
          sapConfig,
          { method: 'odata_query' },
          { service: SVC, entity_set: 'C_GLRevenueExpensesResults', filter: "FiscalYear eq '2026'" },
          sap,
        ),
      ).rejects.toThrow(/requires a filter on CompanyCode/);
      await expect(
        engine.execute(sapConfig, { method: 'odata_query' }, { service: SVC, entity_set: 'Nope' }, sap),
      ).rejects.toThrow(/No entity set "Nope"/);
      expect(calls.filter((c) => !c.path.endsWith('$metadata'))).toHaveLength(0);
    });

    it('reads a parameterised view through its results navigation', async () => {
      const { rest, calls } = fakeRest({
        [`${SVC}/$metadata`]: () => fixture('sap-v2-analytical.xml'),
        [`${SVC}/C_GLRevenueExpenses(P_ExchangeRateType='M')/Set`]: () => ({ d: { results: [{ A: 1 }] } }),
      });
      const out: any = await new ODataEngine(rest).execute(
        sapConfig,
        { method: 'odata_query' },
        { service: SVC, entity_set: 'C_GLRevenueExpenses', parameters: { P_ExchangeRateType: 'M' } },
        sap,
      );
      expect(out.rows).toEqual([{ A: 1 }]);
      expect(calls.some((c) => c.path.endsWith("C_GLRevenueExpenses(P_ExchangeRateType='M')/Set"))).toBe(true);
    });

    it('rejects $apply on a V2 service', async () => {
      const { rest } = fakeRest(routes([]));
      await expect(
        new ODataEngine(rest).execute(
          sapConfig,
          { method: 'odata_query' },
          { service: SVC, entity_set: 'C_GLRevenueExpensesResults', filter: "CompanyCode eq '1'", apply: 'groupby((A))' },
          sap,
        ),
      ).rejects.toThrow(/needs an OData V4 service/);
    });
  });

  describe('generic (non-SAP) V4 service', () => {
    const cfg = { baseUrl: 'https://odata.example.test/TripPin', authType: 'NONE' };
    it('treats the base URL as the service and reads V4 pages', async () => {
      const { rest, calls } = fakeRest({
        '/$metadata': () => fixture('trippin-v4.xml'),
        '/People': () => ({ '@odata.count': 20, value: [{ '@odata.etag': 'x', UserName: 'russell' }] }),
        "/People('russell')": () => ({ UserName: 'russell', FirstName: 'Russell' }),
      });
      const engine = new ODataEngine(rest);
      const q: any = await engine.execute(cfg, { method: 'odata_query' }, { entity_set: 'People', top: 1 }, undefined);
      expect(q).toMatchObject({ total: 20, returned: 1, truncated: true, nextSkip: 1, rows: [{ UserName: 'russell' }] });
      const people = calls.find((c) => c.path === '/People')!;
      expect(people.query).toEqual({ $top: '1', $count: 'true' });

      const one: any = await engine.execute(cfg, { method: 'odata_get' }, { entity_set: 'People', key: 'russell' }, undefined);
      expect(one).toEqual({ UserName: 'russell', FirstName: 'Russell' });

      const list: any = await engine.execute(cfg, { method: 'odata_list_services' }, {}, undefined);
      expect(list.services[0].service).toBe('');
    });
  });

  describe('plain HTTP tools on an OData connector', () => {
    it('adds sap-client and JSON format, flattens the answer', async () => {
      const { rest, calls } = fakeRest({
        '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner': () => ({
          d: { results: [{ __metadata: {}, BusinessPartner: '1' }] },
        }),
      });
      const out: any = await new ODataEngine(rest).execute(
        sapConfig,
        { method: 'GET', path: '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner', queryParams: { $top: '$top' } },
        { top: 5 },
        sap,
      );
      expect(out).toEqual({ returned: 1, rows: [{ BusinessPartner: '1' }] });
      expect(calls[0].query).toMatchObject({ $top: 5, 'sap-client': '100', $format: 'json' });
    });

    it('fetches a CSRF token with session cookies before an SAP write', async () => {
      const { rest, calls } = fakeRest({
        '/sap/opu/odata/sap/API_X': () => ({
          body: {},
          headers: { 'x-csrf-token': 'tok123', 'set-cookie': 'SAP_SESSIONID_X=abc; path=/, sap-usercontext=sap-client=100; path=/' },
        }),
        '/sap/opu/odata/sap/API_X/Things': () => ({ d: { ID: '9' } }),
      });
      await new ODataEngine(rest).execute(
        sapConfig,
        { method: 'POST', path: '/sap/opu/odata/sap/API_X/Things', bodyMapping: { Name: '$name' } },
        { name: 'n' },
        sap,
      );
      expect(calls[0].headers['x-csrf-token']).toBe('Fetch');
      expect(calls[1].headers).toMatchObject({
        'x-csrf-token': 'tok123',
        Cookie: 'SAP_SESSIONID_X=abc; sap-usercontext=sap-client=100',
      });
    });
  });
});

describe('odata values', () => {
  it('refuses service paths that could leave the host', () => {
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/sap/../../etc', '/sap/x?y=1', 'relative/path', '/a#b']) {
      expect(() => assertSafeServicePath(bad)).toThrow();
    }
    expect(assertSafeServicePath('/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/')).toBe(
      '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2',
    );
  });

  it('matches the allow-list with globs, case-insensitively', () => {
    expect(serviceAllowed('/sap/opu/odata/sap/API_A', ['/SAP/OPU/ODATA/SAP/api_*'])).toBe(true);
    expect(serviceAllowed('/sap/opu/odata/sap/ZB', ['/sap/opu/odata/sap/API_*'])).toBe(false);
    expect(serviceAllowed('/x', [])).toBe(true);
  });

  it('builds key predicates for single, composite and typed keys', () => {
    const m = parseEdmx(fixture('sap-v4-annotated.xml'));
    const so = m.entityTypes['com.sap.gateway.srvd_a2x.api_salesorder.v0001.SalesOrderType'];
    const item = m.entityTypes['com.sap.gateway.srvd_a2x.api_salesorder.v0001.SalesOrderItemType'];
    expect(buildKeyPredicate("O'Brien", so, 'v4')).toBe("('O''Brien')");
    expect(buildKeyPredicate({ SalesOrder: '1', SalesOrderItem: '10' }, item, 'v4')).toBe(
      "(SalesOrder='1',SalesOrderItem='10')",
    );
    expect(buildKeyPredicate('{"SalesOrder":"1","SalesOrderItem":"10"}', item, 'v4')).toBe(
      "(SalesOrder='1',SalesOrderItem='10')",
    );
    expect(() => buildKeyPredicate({ SalesOrder: '1' }, item, 'v4')).toThrow(/missing SalesOrderItem/);
    expect(() => buildKeyPredicate("Foo='1'", item, 'v4')).toThrow(/has the key SalesOrder, SalesOrderItem/);
  });

  it('validates settings', () => {
    expect(normalizeSettings({ sapClient: '100' })).toMatchObject({ sap: true, sapClient: '100' });
    expect(normalizeSettings(undefined)).toMatchObject({ sap: false, version: 'auto' });
    expect(() => normalizeSettings({ sapClient: '1x' })).toThrow(/three-digit/);
  });
});
