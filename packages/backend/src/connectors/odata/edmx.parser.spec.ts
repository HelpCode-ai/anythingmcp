import { readFileSync } from 'fs';
import { join } from 'path';
import { parseEdmx } from './edmx.parser';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

describe('parseEdmx', () => {
  it('reads an SAP V2 analytical service with sap:* annotations', () => {
    const m = parseEdmx(fixture('sap-v2-analytical.xml'));
    expect(m.version).toBe('v2');
    expect(m.functions).toEqual(['GetHierarchy']);

    const results = m.entitySets.find((s) => s.name === 'C_GLRevenueExpensesResults')!;
    expect(results).toMatchObject({
      entityType: 'C_GLREVENUEEXPENSES_CDS.C_GLRevenueExpensesResult',
      label: 'Revenue and Expenses',
      analytical: true,
      creatable: false,
      requiredInFilter: ['CompanyCode'],
    });

    const type = m.entityTypes[results.entityType];
    const amount = type.properties.find((p) => p.name === 'AmountInCompanyCodeCurrency')!;
    expect(amount).toMatchObject({
      type: 'Edm.Decimal',
      label: 'Amount in CC Crcy',
      unit: 'CompanyCodeCurrency',
      aggregationRole: 'measure',
      filterable: false,
      precision: 24,
      scale: 3,
    });
    expect(type.properties.find((p) => p.name === 'CompanyCode')).toMatchObject({
      label: 'Company Code',
      text: 'CompanyCodeName',
      aggregationRole: 'dimension',
    });
    expect(type.keys).toEqual(['ID']);

    expect(m.entitySets.find((s) => s.name === 'C_GLRevenueExpenses')?.parameters).toEqual({
      names: ['P_ExchangeRateType'],
      resultsNavigation: 'Set',
    });
  });

  it('reads V4 labels and currency links from external and inline annotations', () => {
    const m = parseEdmx(fixture('sap-v4-annotated.xml'));
    expect(m.version).toBe('v4');
    const so = m.entitySets.find((s) => s.name === 'SalesOrder')!;
    expect(so.entityType).toBe('com.sap.gateway.srvd_a2x.api_salesorder.v0001.SalesOrderType');
    expect(so.label).toBe('Sales Order');

    const type = m.entityTypes[so.entityType];
    expect(type.properties.find((p) => p.name === 'SoldToParty')?.label).toBe('Sold-To Party');
    expect(type.properties.find((p) => p.name === 'TotalNetAmount')).toMatchObject({
      label: 'Net Value',
      unit: 'TransactionCurrency',
    });
    expect(type.navigation).toEqual([
      {
        name: '_Item',
        target: 'com.sap.gateway.srvd_a2x.api_salesorder.v0001.SalesOrderItemType',
        many: true,
      },
    ]);
    const item = m.entityTypes['com.sap.gateway.srvd_a2x.api_salesorder.v0001.SalesOrderItemType'];
    expect(item.keys).toEqual(['SalesOrder', 'SalesOrderItem']);
    expect(item.properties.find((p) => p.name === 'Material')?.label).toBe('Product');
  });

  it('parses a public V2 service (Northwind)', () => {
    const m = parseEdmx(fixture('northwind-v2.xml'));
    expect(m.version).toBe('v2');
    const customers = m.entitySets.find((s) => s.name === 'Customers')!;
    expect(m.entityTypes[customers.entityType].keys).toEqual(['CustomerID']);
    expect(m.entitySets.length).toBeGreaterThan(20);
  });

  it('parses a public V4 service (TripPin)', () => {
    const m = parseEdmx(fixture('trippin-v4.xml'));
    expect(m.version).toBe('v4');
    const people = m.entitySets.find((s) => s.name === 'People')!;
    const person = m.entityTypes[people.entityType];
    expect(person.keys).toEqual(['UserName']);
    expect(person.navigation.find((n) => n.name === 'Friends')).toMatchObject({ many: true });
  });

  it('rejects a document that is not $metadata', () => {
    expect(() => parseEdmx('<html><body>login</body></html>')).toThrow(/Not an OData \$metadata/);
  });
});
