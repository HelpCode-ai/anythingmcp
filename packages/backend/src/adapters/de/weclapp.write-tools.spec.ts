import * as adapter from './weclapp.json';
import axios, { AxiosError } from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;
void AxiosError;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { required?: string[]; properties: Record<string, any> };
  endpointMapping: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const tools = (adapter as unknown as { tools: Tool[] }).tools;
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const writes = tools.filter((t) => t.endpointMapping.method !== 'GET');

/**
 * weclapp's write tools. Request shapes follow weclapp's OpenAPI v2 file
 * (https://www.weclapp.com/api/openapi_v2.json) and its user guide, which
 * documents `PUT ...?ignoreMissingProperties=true` as the way to change single
 * fields. Where it matters, they mirror what already works in production:
 * hand-built tools on the cloud set the responsible user on invoices, orders
 * and parties with exactly this partial PUT (739/741, 220/223 and 93/96
 * successful calls), create customers with POST /party (40/40) and quotations
 * with their positions in one POST (6/6).
 */
describe('weclapp adapter: write tools', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn(), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const base = 'https://acme.weclapp.com/webapp/api/v2';
  const config = {
    baseUrl: base,
    authType: 'API_KEY' as const,
    authConfig: { headerName: 'AuthenticationToken', apiKey: 'token' },
  };
  const run = (name: string, params: Record<string, unknown>) =>
    engine.execute(config, tool(name).endpointMapping as any, params);
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ data: { id: '1' } });
  });

  it('sets one field of an invoice with a partial PUT, as the proven hand-built tool does', async () => {
    await run('weclapp_edit_sales_invoice', {
      salesInvoiceId: '4711',
      fields: { responsibleUserId: '3555' },
    });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe(`${base}/salesInvoice/id/4711`);
    expect(sent().params).toEqual({ ignoreMissingProperties: 'true' });
    expect(sent().data).toEqual({ responsibleUserId: '3555' });
    expect(sent().headers.AuthenticationToken).toBe('token');
  });

  it('passes the version for optimistic locking only when given', async () => {
    await run('weclapp_edit_party', {
      partyId: '7992',
      fields: { lastName: 'Mustermann-Neu' },
      version: '3',
      dryRun: true,
    });
    expect(sent().url).toBe(`${base}/party/id/7992`);
    expect(sent().params).toEqual({ ignoreMissingProperties: 'true', dryRun: true });
    expect(sent().data).toEqual({ lastName: 'Mustermann-Neu', version: '3' });
  });

  it('never sends a PUT without ignoreMissingProperties, so fields left out are not wiped', () => {
    const puts = writes.filter((t) => t.endpointMapping.method === 'PUT');
    expect(puts.length).toBeGreaterThan(5);
    for (const t of puts) {
      expect({ tool: t.name, q: t.endpointMapping.queryParams?.ignoreMissingProperties }).toEqual({
        tool: t.name,
        q: 'true',
      });
    }
  });

  it('creates a customer with its address, letting weclapp assign the number', async () => {
    await run('weclapp_add_party', {
      partyType: 'ORGANIZATION',
      customer: true,
      company: 'Muster GmbH',
      responsibleUserId: '3555',
      addresses: [{ street1: 'Mustergasse 7', zipcode: '80331', city: 'München', countryCode: 'DE', primaryAddress: true }],
      fields: { customerPaymentMethodId: '3980', company: 'ignored, the explicit value wins' },
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${base}/party`);
    expect(sent().data).toEqual({
      partyType: 'ORGANIZATION',
      customer: true,
      company: 'Muster GmbH',
      responsibleUserId: '3555',
      addresses: [{ street1: 'Mustergasse 7', zipcode: '80331', city: 'München', countryCode: 'DE', primaryAddress: true }],
      customerPaymentMethodId: '3980',
    });
  });

  it('creates a contact person as a PERSON party', async () => {
    await run('weclapp_add_contact_person', { firstName: 'Anna', lastName: 'Meier', email: 'anna@example.com' });
    expect(sent().data).toEqual({ partyType: 'PERSON', firstName: 'Anna', lastName: 'Meier', email: 'anna@example.com' });
  });

  it('creates a lead with its lead status', async () => {
    await run('weclapp_add_lead', { partyType: 'ORGANIZATION', company: 'Prospect AG', leadStatus: 'NEW' });
    expect(sent().url).toBe(`${base}/party`);
    expect(sent().data).toEqual({ partyType: 'ORGANIZATION', company: 'Prospect AG', leadStatus: 'NEW' });
  });

  it('creates a quotation with its positions in one call', async () => {
    const quotationItems = [
      { articleId: '5101', positionNumber: 1, quantity: '2', unitPrice: '119.00', manualUnitPrice: true },
      { articleId: '5102', positionNumber: 2, quantity: '1', invoicingType: 'FIXED_PRICE' },
    ];
    await run('weclapp_add_quotation', { customerId: '7992', quotationItems, validTo: 1767225600000 });
    expect(sent().url).toBe(`${base}/quotation`);
    expect(sent().data).toEqual({ customerId: '7992', quotationItems, validTo: 1767225600000 });
  });

  it('creates a sales order and a purchase order with positions', async () => {
    const orderItems = [{ articleId: '5101', quantity: '3' }];
    await run('weclapp_add_sales_order', { customerId: '7992', orderItems, orderNumberAtCustomer: 'PO-778' });
    expect(sent().url).toBe(`${base}/salesOrder`);
    expect(sent().data).toEqual({ customerId: '7992', orderItems, orderNumberAtCustomer: 'PO-778' });

    mockedAxios.mockClear();
    await run('weclapp_add_purchase_order', { supplierId: '812', purchaseOrderItems: orderItems, warehouseId: '20' });
    expect(sent().url).toBe(`${base}/purchaseOrder`);
    expect(sent().data).toEqual({ supplierId: '812', purchaseOrderItems: orderItems, warehouseId: '20' });
  });

  it('changes the status of a sales order with the status alone', async () => {
    await run('weclapp_set_sales_order_status', { salesOrderId: '4400', status: 'ORDER_ENTRY_IN_PROGRESS' });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe(`${base}/salesOrder/id/4400`);
    expect(sent().data).toEqual({ status: 'ORDER_ENTRY_IN_PROGRESS' });
  });

  it('sends a JSON body to actions that take none, which weclapp requires (415 otherwise)', async () => {
    await run('weclapp_cancel_sales_order', { salesOrderId: '4400' });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${base}/salesOrder/id/4400/cancelOrManuallyClose`);
    expect(sent().data).toEqual({});

    mockedAxios.mockClear();
    await run('weclapp_invoice_sales_order', { salesOrderId: '4400' });
    expect(sent().url).toBe(`${base}/salesOrder/id/4400/createSalesInvoice`);
    expect(sent().data).toEqual({});
  });

  it('can invoice several orders of one customer together', async () => {
    await run('weclapp_invoice_sales_order', { salesOrderId: '4400', additionalSalesOrderIds: ['4401', '4402'] });
    expect(sent().data).toEqual({ additionalSalesOrderIds: ['4401', '4402'] });
  });

  it('uses the quotation status action', async () => {
    await run('weclapp_set_quotation_status', { quotationId: '300', status: 'ACCEPTED' });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${base}/quotation/id/300/updateStatus`);
    expect(sent().data).toEqual({ status: 'ACCEPTED' });
  });

  it('books stock with the quantity as a decimal string', async () => {
    await run('weclapp_book_stock_in', { articleId: '5101', quantity: '80', targetStoragePlaceId: '9' });
    expect(sent().url).toBe(`${base}/warehouseStockMovement/bookIncomingMovement`);
    expect(sent().data).toEqual({ articleId: '5101', quantity: '80', targetStoragePlaceId: '9' });
    expect(tool('weclapp_book_stock_out').parameters.properties.quantity.type).toBe('string');
  });

  it('replaces the article price list with the list it is given', async () => {
    const articlePrices = [{ id: '61' }, { id: '62', price: '159.99' }];
    await run('weclapp_set_article_prices', { articleId: '5101', articlePrices, version: '7' });
    expect(sent().url).toBe(`${base}/article/id/5101`);
    expect(sent().params).toEqual({ ignoreMissingProperties: 'true' });
    expect(sent().data).toEqual({ articlePrices, version: '7' });
  });

  it('adds a comment, a task and a time record', async () => {
    await run('weclapp_add_comment', {
      entityName: 'salesOrder',
      entityId: '4400',
      comment: 'Customer called',
      privateComment: false,
      publicComment: false,
      solution: false,
    });
    expect(sent().url).toBe(`${base}/comment`);
    expect(sent().data).toEqual({
      entityName: 'salesOrder',
      entityId: '4400',
      comment: 'Customer called',
      privateComment: false,
      publicComment: false,
      solution: false,
    });

    mockedAxios.mockClear();
    await run('weclapp_add_task', { subject: 'Call back', assignees: [{ userId: '3555' }], taskPriority: 'HIGH' });
    expect(sent().url).toBe(`${base}/task`);
    expect(sent().data).toEqual({ subject: 'Call back', assignees: [{ userId: '3555' }], taskPriority: 'HIGH' });

    mockedAxios.mockClear();
    await run('weclapp_add_time_record', {
      userId: '3555',
      startDate: 1767258000000,
      durationSeconds: 5400,
      billableDurationSeconds: 5400,
      salesOrderId: '4400',
    });
    expect(sent().url).toBe(`${base}/timeRecord`);
    expect(sent().data).toEqual({
      userId: '3555',
      startDate: 1767258000000,
      durationSeconds: 5400,
      billableDurationSeconds: 5400,
      salesOrderId: '4400',
    });
  });

  it('reads reference lists by name, with weclapp filters as query parameters', async () => {
    await run('weclapp_list_reference_data', { resource: 'user', filter: 'lastName-ilike=%meier%', properties: 'id,lastName' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${base}/user`);
    expect(sent().params).toEqual({ properties: 'id,lastName', 'lastName-ilike': '%meier%' });
  });

  it('encodes ids into the path, so an id cannot reach another route', async () => {
    await run('weclapp_edit_task', { taskId: '1/../../salesOrder/id/2', fields: { taskStatus: 'COMPLETED' } });
    expect(sent().url).toBe(`${base}/task/id/1%2F..%2F..%2FsalesOrder%2Fid%2F2`);
  });

  it('installs every delete switched off', () => {
    const deletes = writes.filter((t) => t.endpointMapping.method === 'DELETE');
    expect(deletes.map((t) => t.name).sort()).toEqual([
      'weclapp_delete_comment',
      'weclapp_delete_party',
      'weclapp_delete_quotation',
      'weclapp_delete_sales_order',
      'weclapp_delete_task',
      'weclapp_delete_time_record',
    ]);
    for (const t of deletes) expect({ tool: t.name, enabled: t.enabled }).toEqual({ tool: t.name, enabled: false });
  });

  it('asks the model to confirm every write with the user', () => {
    for (const t of writes) {
      expect({ tool: t.name, confirms: /confirm/i.test(t.description) }).toEqual({ tool: t.name, confirms: true });
    }
  });

  it('marks the status changes and the cancellation as destructive', () => {
    expect(tool('weclapp_cancel_sales_order').annotations).toMatchObject({ destructiveHint: true });
    expect(tool('weclapp_set_quotation_status').annotations).toMatchObject({ destructiveHint: true });
  });

  /**
   * Catalog re-sync matches tools by name. A catalog tool named like one a
   * workspace built itself on an installed weclapp connector would overwrite
   * that tool on the next update. These are the weclapp_* names in use on
   * installed weclapp connectors on the cloud (13 Oct 2026).
   */
  it('reuses no tool name customers already gave their own weclapp tools', () => {
    const customerNames = [
      'weclapp_angebot_erstellen_v2', 'weclapp_book_productionorder', 'weclapp_count_articles',
      'weclapp_create_article', 'weclapp_create_contact', 'weclapp_create_delivery_note',
      'weclapp_create_manufacturer', 'weclapp_create_opportunity', 'weclapp_create_party',
      'weclapp_create_purchase_order', 'weclapp_create_quotation', 'weclapp_create_sales_invoice',
      'weclapp_create_sales_order', 'weclapp_create_salesorder', 'weclapp_create_shipment',
      'weclapp_create_stockmovement', 'weclapp_create_supply_source', 'weclapp_create_unit',
      'weclapp_create_variant_article', 'weclapp_find_purchase_invoices', 'weclapp_find_quotation',
      'weclapp_get_article_supply_source', 'weclapp_get_batch_number', 'weclapp_get_contact',
      'weclapp_get_delivery_note', 'weclapp_get_invoice', 'weclapp_get_open_item', 'weclapp_get_opportunity',
      'weclapp_get_party', 'weclapp_get_productionorder', 'weclapp_get_purchase_order',
      'weclapp_get_sales_invoice', 'weclapp_get_sales_order', 'weclapp_get_salesorder',
      'weclapp_get_warehousestock', 'weclapp_list_article_categories', 'weclapp_list_article_prices',
      'weclapp_list_bank_transactions', 'weclapp_list_batch_numbers', 'weclapp_list_contacts',
      'weclapp_list_customs_tariff_numbers', 'weclapp_list_delivery_notes', 'weclapp_list_incoming_goods',
      'weclapp_list_manufacturers', 'weclapp_list_open_items', 'weclapp_list_parties',
      'weclapp_list_purchase_open_items', 'weclapp_list_purchase_orders', 'weclapp_list_shipments',
      'weclapp_list_stock_movements', 'weclapp_list_storage_places', 'weclapp_list_supply_sources',
      'weclapp_list_units', 'weclapp_list_users', 'weclapp_list_warehouse_stock', 'weclapp_list_warehouses',
      'weclapp_match_bank_to_purchase_open_item', 'weclapp_set_purchase_payment_state',
      'weclapp_update_article', 'weclapp_update_contact', 'weclapp_update_delivery_note',
      'weclapp_update_invoice', 'weclapp_update_open_item', 'weclapp_update_opportunity',
      'weclapp_update_party', 'weclapp_update_purchase_order', 'weclapp_update_quotation',
      'weclapp_update_recurring_invoice', 'weclapp_update_sales_invoice', 'weclapp_update_sales_order',
      'weclapp_update_salesorder',
    ];
    const ours = new Set(tools.map((t) => t.name));
    expect(customerNames.filter((n) => ours.has(n))).toEqual([]);
  });
});
