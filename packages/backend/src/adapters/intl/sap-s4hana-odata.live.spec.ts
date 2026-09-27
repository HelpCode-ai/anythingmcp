import { getAdapter } from '../catalog';
import { ODataEngine } from '../../connectors/engines/odata.engine';
import { renderStaticResponse } from '../../connectors/static-response.util';
import { interpolateDeep } from '../../common/env-interpolation.util';

/**
 * SAP S/4HANA (OData) adapter.
 *
 *   1. Static — always runs: the catalog injects the five OData built-ins
 *      with the adapter's `s4` prefix, the probe needs no arguments, the
 *      guide answers every topic, and the ready tools reach SAP with the
 *      client, language and JSON format that SAP Gateway expects.
 *
 *   2. Live — skipped unless RUN_SAP_ODATA_LIVE is set:
 *
 *        RUN_SAP_ODATA_LIVE=1 SAP_ODATA_BASE_URL=https://s4.internal:44300 SAP_CLIENT=100 \
 *          SAP_LANGUAGE=EN SAP_ODATA_USER=... SAP_ODATA_PASSWORD=... \
 *          npx jest src/adapters/intl/sap-s4hana-odata.live.spec.ts
 */

const adapter = getAdapter('sap-s4hana-odata')!;
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

describe('sap-s4hana-odata adapter (static)', () => {
  it('carries the OData built-ins under the s4 prefix', () => {
    for (const name of ['s4_list_services', 's4_describe_service', 's4_describe_entity', 's4_query', 's4_get_entity']) {
      expect(tool(name)).toBeDefined();
    }
    expect(adapter.probe?.tool).toBe('s4_list_services');
    expect((tool('s4_query').parameters as any).required).toEqual(['service', 'entity_set']);
  });

  it('answers every guide topic', () => {
    const guide = tool('s4_guide');
    for (const topic of (guide.parameters as any).properties.topic.enum) {
      expect(renderStaticResponse(guide.endpointMapping as any, { topic })).not.toMatch(/^There is no topic/);
    }
  });

  it('sends the ready tools with sap-client, sap-language and JSON', async () => {
    const executeWithMeta = jest.fn().mockResolvedValue({ body: { d: { results: [{ A: 1 }] } }, headers: {} });
    const engine = new ODataEngine({ executeWithMeta } as any);
    const env = { SAP_CLIENT: '100', SAP_LANGUAGE: 'EN' };
    const out: any = await engine.execute(
      { baseUrl: 'https://s4.example.test:44300', authType: 'BASIC_AUTH' },
      tool('s4_billing_documents').endpointMapping as any,
      { top: 5, filter: "SalesOrganization eq '1000'" },
      interpolateDeep(adapter.connector.config!.odata, env),
    );
    expect(out.rows).toEqual([{ A: 1 }]);
    const [, mapping, params] = executeWithMeta.mock.calls[0];
    expect(mapping.path).toBe('/sap/opu/odata/sap/API_BILLING_DOCUMENT_SRV/A_BillingDocument');
    expect(mapping.queryParams).toMatchObject({ 'sap-client': '$__sap_client', $format: 'json' });
    expect(params).toMatchObject({ __sap_client: '100', __sap_language: 'EN', top: 5 });
  });
});

describe('sap-s4hana-cloud adapter', () => {
  it('gets the built-ins over its listed services', () => {
    const cloud = getAdapter('sap-s4hana-cloud')!;
    const names = cloud.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['s4_cloud_list_services', 's4_cloud_query', 's4_list_business_partners']));
  });
});

const live = process.env.RUN_SAP_ODATA_LIVE ? describe : describe.skip;
live('sap-s4hana-odata adapter (live)', () => {
  const env = {
    SAP_CLIENT: process.env.SAP_CLIENT ?? '',
    SAP_LANGUAGE: process.env.SAP_LANGUAGE ?? 'EN',
  };
  const config = {
    baseUrl: process.env.SAP_ODATA_BASE_URL ?? '',
    authType: 'BASIC_AUTH',
    authConfig: { username: process.env.SAP_ODATA_USER, password: process.env.SAP_ODATA_PASSWORD },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RestEngine } = require('../../connectors/engines/rest.engine');
  const engine = new ODataEngine(new RestEngine({} as any, {} as any));
  const settings = () => interpolateDeep(adapter.connector.config!.odata, env);

  beforeAll(() => {
    process.env.SSRF_ALLOW_PRIVATE = 'true';
  });

  it('lists catalog services and describes one', async () => {
    const list: any = await engine.execute(config, { method: 'odata_list_services' }, { search: 'business partner' }, settings());
    // eslint-disable-next-line no-console
    console.log(list.total, list.services.slice(0, 3));
    expect(list.total).toBeGreaterThan(0);
    const svc: any = await engine.execute(config, { method: 'odata_describe_service' }, { service: list.services[0].service }, settings());
    expect(svc.entitySets.length).toBeGreaterThan(0);
  }, 120_000);
});
