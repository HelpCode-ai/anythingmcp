import axios from 'axios';
import * as adapter from './onec-enterprise.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { ODataEngine } from '../../connectors/engines/odata.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { buildODataBuiltinTools, odataToolPrefix } from '../../connectors/odata/odata-builtins';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { searchCatalog } from '../catalog-search';
import { listAdapters } from '../catalog';

/**
 * 1C:Enterprise through the platform's standard OData interface (OData v3).
 *
 * Static only: no 1C server is reachable from CI and no customer of ours has
 * a working one. Pinned against the platform documentation (its.1c.ru,
 * "Стандартный интерфейс OData"): the service root
 * <publication>/odata/standard.odata, Basic auth, $format=json, EDMX 1.0
 * with DataServiceVersion 3.0, guid'...' keys, virtual tables of registers
 * as Register/Balance(Period=..., Condition='...').
 *
 * 1C does not read "+" as a space inside $filter / $orderby: the query has
 * to reach it with %20. The connector sets config.odata.querySpaces "%20"
 * for the built-in query tool, and config.odata.v3Json so the OData V3 JSON
 * paging (odata.count, odata.nextLink) is read and @navigationLinkUrl keys
 * are left out of rows. onec_enterprise_get stays for register virtual
 * tables and navigation, which have no entity set in $metadata; its written
 * out path gets %20 from the URL parser.
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

type Tool = {
  name: string;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: Record<string, any>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  aliases: string[];
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    config: { odata: Record<string, unknown> };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const HOST = 'https://1c.example.com/trade';
const ENV = { ONEC_BASE_URL: HOST, ONEC_USER: 'ОДата', ONEC_PASSWORD: ['pa', 'ss', '-1c'].join('') };
const ROOT = `${HOST}/odata/standard.odata`;

const engine = () => new ODataEngine(new RestEngine({} as OAuth2TokenService, {} as LoginTokenService));
const run = (endpointMapping: Record<string, unknown>, params: Record<string, unknown>) => {
  const { config, endpointMapping: mapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    endpointMapping as never,
    ENV,
  );
  return engine().execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, ENV),
      headers: config.headers,
      connectorId: `onec-${Math.random()}`,
    },
    mapping as never,
    { ...params, ...ENV },
    a.connector.config.odata,
  ) as Promise<any>;
};
const sent = (i = 0) => mockedAxios.mock.calls[i][0];
/** The URL axios would put on the wire: path and query, percent-encoded. */
const wire = (cfg: { url: string; params?: Record<string, unknown>; paramsSerializer?: (p: any) => string }) => {
  const u = new URL(cfg.url);
  const extra = cfg.params && cfg.paramsSerializer ? cfg.paramsSerializer(cfg.params) : '';
  return `${u.pathname}${u.search}${extra ? (u.search ? '&' : '?') + extra : ''}`;
};

const METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
 <edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="3.0">
  <Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA">
   <EntityType Name="Catalog_Контрагенты">
    <Key><PropertyRef Name="Ref_Key"/></Key>
    <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
    <Property Name="DataVersion" Type="Edm.String" Nullable="true"/>
    <Property Name="DeletionMark" Type="Edm.Boolean" Nullable="true"/>
    <Property Name="Code" Type="Edm.String" Nullable="true"/>
    <Property Name="Description" Type="Edm.String" Nullable="true"/>
    <Property Name="ИНН" Type="Edm.String" Nullable="true"/>
   </EntityType>
   <EntityType Name="Document_РеализацияТоваровУслуг">
    <Key><PropertyRef Name="Ref_Key"/></Key>
    <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
    <Property Name="Number" Type="Edm.String" Nullable="true"/>
    <Property Name="Date" Type="Edm.DateTime" Nullable="true"/>
    <Property Name="Posted" Type="Edm.Boolean" Nullable="true"/>
    <Property Name="Контрагент_Key" Type="Edm.Guid" Nullable="true"/>
    <Property Name="СуммаДокумента" Type="Edm.Double" Nullable="true"/>
   </EntityType>
   <EntityContainer Name="EnterpriseV8" m:IsDefaultEntityContainer="true">
    <EntitySet Name="Catalog_Контрагенты" EntityType="StandardODATA.Catalog_Контрагенты"/>
    <EntitySet Name="Document_РеализацияТоваровУслуг" EntityType="StandardODATA.Document_РеализацияТоваровУслуг"/>
   </EntityContainer>
  </Schema>
 </edmx:DataServices>
</edmx:Edmx>`;
const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('onec-enterprise adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is an OData connector on the publication root with Basic auth', () => {
    expect(a.slug).toBe('onec-enterprise');
    expect(a.connector.type).toBe('ODATA');
    expect(a.connector.baseUrl).toBe('{{ONEC_BASE_URL}}/odata/standard.odata');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{ONEC_USER}}', password: '{{ONEC_PASSWORD}}' });
    expect(a.requiredEnvVars).toEqual(['ONEC_BASE_URL', 'ONEC_USER', 'ONEC_PASSWORD']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'ONEC_PASSWORD')!.secret).toBe(true);
  });

  it('accepts the publication address only', () => {
    const re = new RegExp(a.envVarMeta.ONEC_BASE_URL.pattern!);
    for (const ok of [HOST, 'http://203.0.113.7:8081/SBS', 'https://srv.scloud.ru/12345/buh']) expect(re.test(ok)).toBe(true);
    for (const bad of [`${HOST}/`, `${HOST}/odata/standard.odata`, `${HOST}/odata/standard.odata/`, '1c.example.com/trade', `${HOST}?x=1`]) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('is found by 1C, the Cyrillic 1С and 1С:Предприятие', () => {
    // The generated catalog index is rebuilt by the release script; add this
    // adapter to it here so the test does not depend on that step.
    const entries = [
      ...listAdapters().filter((x: any) => x.slug !== a.slug).map((x: any) => ({ slug: x.slug, name: x.name, aliases: x.aliases })),
      { slug: a.slug, name: a.name, aliases: a.aliases },
    ];
    for (const q of ['1c', '1С', '1с предприятие', '1С:Предприятие', '1c odata']) {
      expect(`${q}:${searchCatalog(entries, q).hits[0]?.entry.slug}`).toBe(`${q}:onec-enterprise`);
    }
  });

  it('carries the OData built-ins under one prefix, read-only', () => {
    const prefix = odataToolPrefix({ toolPrefix: a.connector.config.odata.toolPrefix as string, name: a.name });
    expect(prefix).toBe('onec_enterprise');
    const builtins = buildODataBuiltinTools({ prefix, displayName: a.name, sap: false }).map((t) => t.name);
    expect(builtins).toEqual([
      'onec_enterprise_list_services',
      'onec_enterprise_describe_service',
      'onec_enterprise_describe_entity',
      'onec_enterprise_query',
      'onec_enterprise_get_entity',
    ]);
    expect(builtins).toContain(a.probe.tool);
    for (const t of a.tools) expect(['static', 'GET']).toContain(t.endpointMapping.method);
    expect(a.instructions).toMatch(/Read-only/);
  });

  it('reads $metadata (EDMX 1.0, OData v3) with Cyrillic entity sets', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: METADATA, headers: {} });
    const out = await run({ method: 'odata_describe_service', path: '' }, {});
    expect(sent().url).toBe(`${ROOT}/$metadata`);
    expect(sent().headers.Accept).toBe('application/xml');
    // axios hands auth to Node's http client, which writes the header from
    // the UTF-8 bytes: Cyrillic 1C user names sign in.
    expect(sent().auth).toEqual({ username: ENV.ONEC_USER, password: ENV.ONEC_PASSWORD });
    expect(out.version).toBe('v2');
    expect(out.entitySets.map((s: any) => [s.name, s.keys])).toEqual([
      ['Catalog_Контрагенты', ['Ref_Key']],
      ['Document_РеализацияТоваровУслуг', ['Ref_Key']],
    ]);
  });

  it('opts in to %20 spaces and V3 JSON reading', () => {
    expect(a.connector.config.odata).toMatchObject({ version: 'v2', querySpaces: '%20', v3Json: true });
  });

  it('sends the built-in query with %20 and reads odata.count', async () => {
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: METADATA, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          'odata.metadata': `${ROOT}/$metadata#Document_РеализацияТоваровУслуг`,
          'odata.count': '41',
          value: [{ Ref_Key: GUID, Number: '0000-000123', 'Контрагент@navigationLinkUrl': `Document_РеализацияТоваровУслуг(guid'${GUID}')/Контрагент` }],
        },
        headers: {},
      });
    const out = await run(
      { method: 'odata_query', path: '' },
      {
        entity_set: 'Document_РеализацияТоваровУслуг',
        filter: "Posted eq true and Date ge datetime'2026-10-01T00:00:00'",
        orderby: 'Date desc',
        select: 'Ref_Key,Number',
        top: 1,
      },
    );
    const url = wire(sent(1));
    expect(url).not.toContain('+');
    expect(url).toContain("$filter=Posted%20eq%20true%20and%20Date%20ge%20datetime'2026-10-01T00:00:00'");
    expect(url).toContain('$orderby=Date%20desc');
    expect(url).toContain('$inlinecount=allpages&$format=json');
    expect(out).toEqual({
      entitySet: 'Document_РеализацияТоваровУслуг',
      total: 41,
      returned: 1,
      truncated: true,
      nextSkip: 1,
      rows: [{ Ref_Key: GUID, Number: '0000-000123' }],
    });
  });

  it('reads one object by its GUID key and flattens the v3 JSON', async () => {
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: METADATA, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { 'odata.metadata': `${ROOT}/$metadata#Catalog_Контрагенты/@Element`, Ref_Key: GUID, Description: 'ООО Ромашка', ИНН: '7707083893' },
        headers: {},
      });
    const out = await run({ method: 'odata_get', path: '' }, { entity_set: 'Catalog_Контрагенты', key: GUID });
    expect(wire(sent(1))).toBe(
      `/trade/odata/standard.odata/${encodeURIComponent('Catalog_Контрагенты')}(guid'${GUID}')?$format=json`,
    );
    expect(out).toEqual({ Ref_Key: GUID, Description: 'ООО Ромашка', ИНН: '7707083893' });
  });

  it('sends a written-out query with %20 for spaces and asks for JSON', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: { 'odata.metadata': 'x', value: [{ Ref_Key: GUID, Number: '0000-000123' }] }, headers: {} });
    const resource = "Document_РеализацияТоваровУслуг?$filter=Posted eq true and Date ge datetime'2026-10-01T00:00:00'&$orderby=Date desc&$top=20";
    const out = await run(tool('onec_enterprise_get').endpointMapping, { resource });
    const url = wire(sent());
    expect(url).not.toContain('+');
    expect(decodeURIComponent(url)).toBe(
      `/trade/odata/standard.odata/${resource}&$format=json`,
    );
    expect(url).toContain('$filter=Posted%20eq%20true%20and%20Date%20ge%20datetime%27');
    expect(sent().method).toBe('GET');
    expect(out).toEqual({ returned: 1, rows: [{ Ref_Key: GUID, Number: '0000-000123' }] });
  });

  it('reads a register virtual table with its parameters in the path', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: { value: [{ Номенклатура_Key: GUID, КоличествоBalance: 12 }] }, headers: {} });
    const resource = `AccumulationRegister_ТоварыНаСкладах/Balance(Period=datetime'2026-10-20T23:59:59', Condition='Склад_Key eq guid''${GUID}''')?$top=200`;
    const out = await run(tool('onec_enterprise_get').endpointMapping, { resource });
    expect(decodeURIComponent(wire(sent()))).toBe(`/trade/odata/standard.odata/${resource}&$format=json`);
    expect(out.rows[0].КоличествоBalance).toBe(12);
  });

  it('refuses resources that leave the service root', () => {
    const re = new RegExp(tool('onec_enterprise_get').parameters.properties!.resource.pattern, 'u');
    for (const ok of ['Catalog_Номенклатура?$top=5', 'Document_X(guid\'1\')/Товары', 'InformationRegister_КурсыВалют/SliceLast()']) expect(re.test(ok)).toBe(true);
    for (const bad of ['../other/odata', '//evil.example/x', 'https://evil.example/x', '/Catalog_X', 'Catalog_X/../../x', 'Catalog_X#frag', '$metadata']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('guide answers every topic it offers', () => {
    const g = tool('onec_enterprise_guide');
    expect(Object.keys(g.endpointMapping.staticResponses).sort()).toEqual([...g.parameters.properties!.topic.enum].sort());
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});
