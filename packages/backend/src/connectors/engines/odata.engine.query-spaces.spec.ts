import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ODataEngine, normalizeSettings } from './odata.engine';
import { RestEngine, serializeRepeatedParams, serializeRepeatedParamsSpaces20 } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { normalizeODataRecord, readODataPage } from '../odata/odata-values';
import { getAdapter } from '../../adapters/catalog';
import { interpolateDeep } from '../../common/env-interpolation.util';

/**
 * The opt-in OData wire and reading options, checked on the bytes axios would
 * send through the real RestEngine:
 *
 *   - `config.odata.querySpaces: "%20"` writes a space in a query option as
 *     `%20`. 1C:Enterprise answers 400 to `+` inside $filter / $orderby.
 *   - `config.odata.v3Json: true` reads OData V3 JSON paging (`odata.count`,
 *     `odata.nextLink`) and drops `odata.*` / `@navigationLinkUrl` keys.
 *
 * The first block pins what an existing SAP connector sends today, so the
 * options can never change a connector that does not set them.
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
const mockedAxios = axios as unknown as jest.Mock;

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'odata', '__fixtures__', name), 'utf8');

const SAP_SVC = '/sap/opu/odata/sap/C_GLREVENUEEXPENSES_CDS';
const SAP_HOST = 'https://s4.example.test:44300';
const sapAdapter = getAdapter('sap-s4hana-odata')!;
const sapSettings = (): Record<string, unknown> =>
  interpolateDeep(sapAdapter.connector.config!.odata, { SAP_CLIENT: '100', SAP_LANGUAGE: 'EN' }) as Record<string, unknown>;

const engine = () => new ODataEngine(new RestEngine({} as OAuth2TokenService, {} as LoginTokenService));
const sent = (i: number) => mockedAxios.mock.calls[i][0];
/** Path and query as they go on the wire. */
const wire = (cfg: { url: string; params?: Record<string, unknown>; paramsSerializer?: (p: any) => string }) => {
  const u = new URL(cfg.url);
  const extra = cfg.params && cfg.paramsSerializer ? cfg.paramsSerializer(cfg.params) : '';
  return `${u.pathname}${u.search}${extra ? (u.search ? '&' : '?') + extra : ''}`;
};

const sapQuery = (settings: Record<string, unknown>) =>
  engine().execute(
    { baseUrl: SAP_HOST, authType: 'BASIC_AUTH', authConfig: { username: 'u', password: 'p' }, connectorId: `sap-${Math.random()}` },
    { method: 'odata_query' },
    {
      service: SAP_SVC,
      entity_set: 'C_GLRevenueExpensesResults',
      select: 'CompanyCode,FiscalPeriod',
      filter: "CompanyCode eq '1000' and FiscalYear eq '2026'",
      orderby: 'FiscalPeriod asc',
      top: 3,
    },
    settings,
  ) as Promise<any>;

describe('OData query encoding: default unchanged', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends spaces as + for the SAP S/4HANA adapter, byte for byte', async () => {
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: fixture('sap-v2-analytical.xml'), headers: {} })
      .mockResolvedValueOnce({ status: 200, data: { d: { results: [{ CompanyCode: '1000' }] } }, headers: {} });
    const settings = sapSettings();
    expect(normalizeSettings(settings)).not.toHaveProperty('querySpaces');
    expect(normalizeSettings(settings)).not.toHaveProperty('v3Json');
    await sapQuery(settings);
    expect(sent(1).paramsSerializer).toBe(serializeRepeatedParams);
    expect(wire(sent(1))).toBe(
      `${SAP_SVC}/C_GLRevenueExpensesResults?` +
        '$select=CompanyCode,FiscalPeriod' +
        "&$filter=CompanyCode+eq+'1000'+and+FiscalYear+eq+'2026'" +
        '&$orderby=FiscalPeriod+asc&$top=3&$inlinecount=allpages&$format=json&sap-client=100&sap-language=EN',
    );
  });

  it('sends a ready SAP tool with + as well', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 200, data: { d: { results: [] } }, headers: {} });
    const t = sapAdapter.tools.find((x) => x.name === 's4_billing_documents')!;
    await engine().execute(
      { baseUrl: SAP_HOST, authType: 'BASIC_AUTH', authConfig: { username: 'u', password: 'p' } },
      t.endpointMapping as any,
      { top: 5, filter: "SalesOrganization eq '1000'" },
      sapSettings(),
    );
    expect(wire(sent(0))).toContain("$filter=SalesOrganization+eq+'1000'");
    expect(wire(sent(0))).not.toContain('%20');
  });

  it('keeps serializeRepeatedParams as it was, also when axios passes its options', () => {
    const p = { $filter: "a eq 'x y'", plus: 'a+b' };
    expect(serializeRepeatedParams(p)).toBe("$filter=a+eq+'x+y'&plus=a%2Bb");
    // axios calls a function serializer as serialize(params, options).
    expect((serializeRepeatedParams as any)(p, { serialize: serializeRepeatedParams })).toBe(
      "$filter=a+eq+'x+y'&plus=a%2Bb",
    );
    expect(serializeRepeatedParamsSpaces20(p)).toBe("$filter=a%20eq%20'x%20y'&plus=a%2Bb");
  });

  it('reads a V4 page as before: odata.count and @navigationLinkUrl are not touched', () => {
    const body = { 'odata.count': '7', 'odata.nextLink': 'x?$skip=1', value: [{ A: 1, 'B@navigationLinkUrl': 'y', 'odata.etag': 'e' }] };
    expect(readODataPage(body)).toEqual({ rows: [{ A: 1, 'B@navigationLinkUrl': 'y', 'odata.etag': 'e' }], count: undefined, nextLink: undefined });
    expect(normalizeODataRecord({ 'odata.metadata': 'm', A: 1 })).toEqual({ 'odata.metadata': 'm', A: 1 });
  });
});

describe('OData query encoding: opt-in options', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('validates and keeps the options only when set', () => {
    expect(normalizeSettings({ querySpaces: '%20', v3Json: true })).toMatchObject({ querySpaces: '%20', v3Json: true });
    expect(normalizeSettings({ querySpaces: '+' })).not.toHaveProperty('querySpaces');
    expect(normalizeSettings({ v3Json: 'yes' })).not.toHaveProperty('v3Json');
    expect(() => normalizeSettings({ querySpaces: '%2B' })).toThrow(/querySpaces/);
  });

  it('writes spaces as %20 with querySpaces "%20"', async () => {
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: fixture('sap-v2-analytical.xml'), headers: {} })
      .mockResolvedValueOnce({ status: 200, data: { d: { results: [] } }, headers: {} });
    await sapQuery({ ...sapSettings(), querySpaces: '%20' });
    expect(wire(sent(1))).toBe(
      `${SAP_SVC}/C_GLRevenueExpensesResults?` +
        '$select=CompanyCode,FiscalPeriod' +
        "&$filter=CompanyCode%20eq%20'1000'%20and%20FiscalYear%20eq%20'2026'" +
        '&$orderby=FiscalPeriod%20asc&$top=3&$inlinecount=allpages&$format=json&sap-client=100&sap-language=EN',
    );
  });

  it('keeps %20 on a followed next link and reads V3 JSON paging', async () => {
    const svc = '/odata/standard.odata';
    const meta = fixture('northwind-v2.xml');
    const set = /EntitySet Name="([^"]+)"/.exec(meta)![1];
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: meta, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          'odata.metadata': 'm',
          'odata.count': '3',
          'odata.nextLink': `https://1c.example.test${svc}/${set}?$filter=a eq 'b c'&$skiptoken=2`,
          value: [{ ID: 1, 'Owner@navigationLinkUrl': `${set}(1)/Owner` }, { ID: 2 }],
        },
        headers: {},
      })
      .mockResolvedValueOnce({ status: 200, data: { 'odata.metadata': 'm', value: [{ ID: 3, 'odata.etag': 'e' }] }, headers: {} });
    const out: any = await engine().execute(
      { baseUrl: `https://1c.example.test${svc}`, authType: 'NONE', connectorId: `v3-${Math.random()}` },
      { method: 'odata_query' },
      { entity_set: set, top: 10 },
      { version: 'v2', querySpaces: '%20', v3Json: true },
    );
    expect(out).toEqual({ entitySet: set, total: 3, returned: 3, rows: [{ ID: 1 }, { ID: 2 }, { ID: 3 }] });
    const next = wire(sent(2));
    expect(next).toContain("$filter=a%20eq%20'b%20c'");
    expect(next).not.toContain('+');
  });

  it('flattens a V3 single entity from a plain HTTP tool', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { 'odata.metadata': 'm#Catalog_X/@Element', Ref_Key: 'g', 'Parent@navigationLinkUrl': 'Catalog_X(guid\'g\')/Parent' },
      headers: {},
    });
    const out = await engine().execute(
      { baseUrl: 'https://1c.example.test/odata/standard.odata', authType: 'NONE' },
      { method: 'GET', path: '/Catalog_X(guid\'g\')' },
      {},
      { version: 'v2', querySpaces: '%20', v3Json: true },
    );
    expect(out).toEqual({ Ref_Key: 'g' });
  });
});
