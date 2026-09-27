import { readFileSync } from 'fs';
import { join } from 'path';
import { parseODataTools } from './odata.parser';
import { buildODataBuiltinTools, odataToolPrefix, wantsODataBuiltins } from '../odata/odata-builtins';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'odata', '__fixtures__', name), 'utf8');

describe('parseODataTools', () => {
  it('makes list and get tools per entity set, named after service and set', () => {
    const { tools } = parseODataTools(fixture('sap-v4-annotated.xml'), {
      service: '/sap/opu/odata4/sap/api_salesorder/srvd_a2x/sap/salesorder/0001',
    });
    expect(tools.map((t) => t.name)).toEqual([
      'sales_order_list',
      'sales_order_get',
      'sales_order_item_list',
      'sales_order_item_get',
    ]);
    const get = tools.find((t) => t.name === 'sales_order_item_get')!;
    expect(get.endpointMapping).toMatchObject({
      method: 'GET',
      path: "/sap/opu/odata4/sap/api_salesorder/srvd_a2x/sap/salesorder/0001/SalesOrderItem(SalesOrder='{SalesOrder}',SalesOrderItem='{SalesOrderItem}')",
      encodePathParams: true,
    });
    expect((get.parameters as any).required).toEqual(['SalesOrder', 'SalesOrderItem']);
    const list = tools.find((t) => t.name === 'sales_order_list')!;
    expect(list.description).toMatch(/SoldToParty \(Sold-To Party\)/);
  });

  it('skips parameter sets and gives analytical sets no get tool', () => {
    const { tools } = parseODataTools(fixture('sap-v2-analytical.xml'), {
      service: '/sap/opu/odata/sap/C_GLREVENUEEXPENSES_CDS',
    });
    expect(tools.map((t) => t.name)).toEqual(['c_glrevenue_expenses_results_list']);
    expect(tools[0].description).toMatch(/must restrict CompanyCode/);
    expect((tools[0].parameters as any).required).toEqual(['filter']);
  });

  it('filters entity sets and refuses an unsafe service path', () => {
    const { tools } = parseODataTools(fixture('northwind-v2.xml'), { entitySets: ['customers'] });
    expect(tools.map((t) => t.name)).toEqual(['customers_list', 'customers_get']);
    expect(() => parseODataTools(fixture('northwind-v2.xml'), { service: 'https://evil.test' })).toThrow();
  });
});

describe('OData built-ins', () => {
  it('prefixes and requires a service only for SAP', () => {
    expect(odataToolPrefix({ name: 'SAP S/4HANA' })).toBe('sap_s_4hana_odata');
    expect(odataToolPrefix({ name: 'x', toolPrefix: 's4' })).toBe('s4');
    const sap = buildODataBuiltinTools({ prefix: 's4', displayName: 'S4', sap: true });
    expect(sap.map((t) => t.name)).toEqual([
      's4_list_services',
      's4_describe_service',
      's4_describe_entity',
      's4_query',
      's4_get_entity',
    ]);
    expect((sap[3].parameters as any).required).toEqual(['service', 'entity_set']);
    const generic = buildODataBuiltinTools({ prefix: 'trip', displayName: 'TripPin', sap: false });
    expect((generic[3].parameters as any).required).toEqual(['entity_set']);
  });

  it('applies to ODATA connectors and REST connectors with config.odata only', () => {
    expect(wantsODataBuiltins('ODATA', null)).toBe(true);
    expect(wantsODataBuiltins('REST', { odata: {} })).toBe(true);
    expect(wantsODataBuiltins('REST', {})).toBe(false);
    expect(wantsODataBuiltins('GRAPHQL', { odata: {} })).toBe(false);
  });
});
