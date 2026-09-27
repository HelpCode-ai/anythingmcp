import { ODataEngine } from './odata.engine';
import { RestEngine } from './rest.engine';
import { parseODataTools } from '../parsers/odata.parser';

/**
 * The OData engine against real public services (services.odata.org), with
 * the real RestEngine: Northwind V2 and V4 (server-driven paging at 200 rows,
 * composite keys, expand) and TripPin V4. Skipped unless RUN_ODATA_PUBLIC_LIVE
 * is set:
 *
 *   RUN_ODATA_PUBLIC_LIVE=1 npx jest src/connectors/engines/odata.engine.live.spec.ts
 */
const live = process.env.RUN_ODATA_PUBLIC_LIVE ? describe : describe.skip;
jest.setTimeout(120_000);

live('ODataEngine against public OData services', () => {
  const engine = new ODataEngine(new RestEngine({} as any, {} as any));
  const v2 = { baseUrl: 'https://services.odata.org/V2/Northwind/Northwind.svc', authType: 'NONE' };
  const v4 = { baseUrl: 'https://services.odata.org/V4/Northwind/Northwind.svc', authType: 'NONE' };
  const trippin = { baseUrl: 'https://services.odata.org/V4/TripPinServiceRW', authType: 'NONE' };

  it('V2: describes the service and an entity with its keys and navigation', async () => {
    const svc: any = await engine.execute(v2, { method: 'odata_describe_service' }, {}, undefined);
    expect(svc.version).toBe('v2');
    expect(svc.entitySets.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Orders', 'Customers', 'Order_Details']));
    const ent: any = await engine.execute(v2, { method: 'odata_describe_entity' }, { entity_set: 'Order_Details' }, undefined);
    expect(ent.keys).toEqual(['OrderID', 'ProductID']);
    expect(ent.navigation.map((n: any) => n.name)).toEqual(expect.arrayContaining(['Order', 'Product']));
  });

  it('V2: filters, selects, orders, counts, and flattens /Date()/ values', async () => {
    const q: any = await engine.execute(v2, { method: 'odata_query' }, {
      entity_set: 'Orders',
      select: 'OrderID,CustomerID,OrderDate,Freight',
      filter: "ShipCountry eq 'Germany'",
      orderby: 'OrderDate desc',
      top: 10,
    }, undefined);
    expect(q.total).toBe(122);
    expect(q.returned).toBe(10);
    expect(q.nextSkip).toBe(10);
    expect(q.rows[0]).toEqual({ OrderID: 11070, CustomerID: 'LEHMS', OrderDate: '1998-05-05T00:00:00.000Z', Freight: '136.0000' });
  });

  it('V2: follows server paging (200-row pages) up to top', async () => {
    const q: any = await engine.execute(v2, { method: 'odata_query' }, { entity_set: 'Orders', select: 'OrderID', top: 450 }, undefined);
    expect(q.returned).toBe(450);
    expect(new Set(q.rows.map((r: any) => r.OrderID)).size).toBe(450);
    expect(q.total).toBe(830);
  });

  it('V4: follows relative next links and counts', async () => {
    const q: any = await engine.execute(v4, { method: 'odata_query' }, { entity_set: 'Orders', select: 'OrderID', top: 450 }, undefined);
    expect(q.returned).toBe(450);
    expect(new Set(q.rows.map((r: any) => r.OrderID)).size).toBe(450);
    expect(q.total).toBe(830);
    expect(q.rows[0]).toEqual({ OrderID: 10248 });
  });

  it('V2 and V4: composite keys and expand', async () => {
    for (const cfg of [v2, v4]) {
      const line: any = await engine.execute(cfg, { method: 'odata_get' }, {
        entity_set: 'Order_Details',
        key: { OrderID: 10248, ProductID: 11 },
        expand: 'Product',
      }, undefined);
      expect(line).toMatchObject({ OrderID: 10248, ProductID: 11, Quantity: 12 });
      expect(line.Product).toMatchObject({ ProductID: 11, ProductName: 'Queso Cabrales' });
    }
    const cust: any = await engine.execute(v4, { method: 'odata_get' }, { entity_set: 'Customers', key: 'ALFKI', select: 'CustomerID,CompanyName' }, undefined);
    expect(cust).toEqual({ CustomerID: 'ALFKI', CompanyName: 'Alfreds Futterkiste' });
  });

  it('explains a misspelt field before calling the server', async () => {
    await expect(
      engine.execute(v2, { method: 'odata_query' }, { entity_set: 'Orders', select: 'OrderDat' }, undefined),
    ).rejects.toThrow(/Did you mean: OrderDate/);
  });

  it('TripPin V4: navigation expand of a collection', async () => {
    const p: any = await engine.execute(trippin, { method: 'odata_get' }, { entity_set: 'People', key: 'russellwhyte', expand: 'Friends' }, undefined);
    expect(p.UserName).toBe('russellwhyte');
    expect(Array.isArray(p.Friends)).toBe(true);
  });

  it('import: tools generated from $metadata run as plain HTTP tools', async () => {
    for (const cfg of [v2, v4]) {
      const { xml }: any = await engine.execute(cfg, { method: 'odata_metadata_xml' }, {}, undefined);
      const { tools } = parseODataTools(xml, { entitySets: ['Order_Details', 'Customers'] });
      const list = tools.find((t) => t.name === 'order_details_list')!;
      const get = tools.find((t) => t.name === 'order_details_get')!;
      const cust = tools.find((t) => t.name === 'customers_get')!;

      const rows: any = await engine.execute(cfg, list.endpointMapping, { filter: 'OrderID eq 10248', top: 5 }, undefined);
      expect(rows.rows.map((r: any) => r.ProductID)).toEqual([11, 42, 72]);

      const one: any = await engine.execute(cfg, get.endpointMapping, { OrderID: '10248', ProductID: '42' }, undefined);
      expect(one).toMatchObject({ OrderID: 10248, ProductID: 42 });

      const c: any = await engine.execute(cfg, cust.endpointMapping, { CustomerID: 'ALFKI' }, undefined);
      expect(c).toMatchObject({ CustomerID: 'ALFKI' });
    }
  });
});
