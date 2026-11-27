import axios from 'axios';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import * as adapter from './afterbuy.json';
import { RestEngine, renderXmlBodyTemplate } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';

/**
 * Afterbuy XML API (https://xmldoku.afterbuy.de/dokued/).
 *
 * Every call is an HTTPS POST of one XML document to
 * https://api.afterbuy.de/afterbuy/ABInterface.aspx; the partner token and the
 * account token travel in its AfterbuyGlobal block, CallName picks the
 * operation, and the answer is XML with CallStatus Success, Warning or Error.
 *
 * Static checks always run: the envelope, each template against the request
 * definitions of its call (CallName, element names, optional elements left
 * out when their parameter is missing), well-formed XML with sample and
 * required-only arguments, and calls through the real RestEngine with axios
 * mocked: where the request goes, how the XML answer is parsed, and which
 * CallStatus Error answers become failed calls (refused tokens 401, an
 * unavailable interface 503, everything else 400) and which stay answers
 * ("No items found" is an empty result).
 *
 * Live checks run only with RUN_AFTERBUY_LIVE=1. Without tokens they confirm
 * that Afterbuy refuses wrong tokens with error 8 in a CallStatus Error answer;
 * with AFTERBUY_PARTNER_TOKEN and AFTERBUY_ACCOUNT_TOKEN they read the server
 * time, the seller flags and the newest order. Reads only.
 *
 *   RUN_AFTERBUY_LIVE=1 AFTERBUY_PARTNER_TOKEN=... AFTERBUY_ACCOUNT_TOKEN=... \
 *     npx jest src/adapters/de/afterbuy.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Schema = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Schema>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; bodyTemplate?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide: { steps: Array<{ fields?: string[] }> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    headers: Record<string, string>;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
  unlisted?: boolean;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const ENDPOINT = 'https://api.afterbuy.de/afterbuy/ABInterface.aspx';
const ENV = { AFTERBUY_PARTNER_TOKEN: 'PT-1a2b3c4d', AFTERBUY_ACCOUNT_TOKEN: 'AT-5e6f7a8b' };
const XML = { 'content-type': 'text/xml; charset=utf-8' };

// The CallName each tool sends, from the API Calls Reference.
const CALLS: Record<string, string> = {
  afterbuy_get_time: 'GetAfterbuyTime',
  afterbuy_list_orders: 'GetSoldItems',
  afterbuy_get_order: 'GetSoldItems',
  afterbuy_list_products: 'GetShopProducts',
  afterbuy_get_stock: 'GetStockInfo',
  afterbuy_list_catalogs: 'GetShopCatalogs',
  afterbuy_list_shipping_services: 'GetShippingServices',
  afterbuy_list_payment_services: 'GetPaymentServices',
  afterbuy_list_user_defined_flags: 'GetUserDefinedFlags',
  afterbuy_mark_order_shipped: 'UpdateSoldItems',
  afterbuy_set_order_tracking: 'UpdateSoldItems',
  afterbuy_update_order: 'UpdateSoldItems',
  afterbuy_update_shipping_address: 'UpdateSoldItems',
  afterbuy_update_stock_and_prices: 'UpdateShopProducts',
  afterbuy_update_product_details: 'UpdateShopProducts',
  afterbuy_cancel_order: 'CancelOrders',
};
const WRITES = new Set(
  Object.entries(CALLS)
    .filter(([, call]) => /^(Update|Cancel)/.test(call))
    .map(([name]) => name),
);

const SAMPLES: Record<string, Record<string, unknown>> = {
  afterbuy_get_time: {},
  afterbuy_list_orders: {
    date_from: '01.11.2026 00:00:00',
    date_to: '26.11.2026',
    date_field: 'ModDate',
    status_filter: 'not_CompletedAuctions',
    order_ids: [482915733, 482915734],
    after_order_id: 482900000,
    to_order_id: 482999999,
    platform: 'ebay',
    buyer_email: 'anna.schmidt@example.de',
    buyer_ids: [7781234],
    user_defined_flag: 12,
    shop_ids: [1, 2],
    tag: 'Express & Co',
    invoice_numbers: [10045],
    max_items: 100,
    newest_first: 1,
    include_hidden: 1,
    detail_level: 62,
  },
  afterbuy_get_order: { order_id: 482915733, detail_level: 30 },
  afterbuy_list_products: {
    product_ids: [1010101],
    anrs: ['101010110'],
    eans: ['4006381333931'],
    tags: ['Sale'],
    set_filter: 'not_ProductSets',
    changed_from: '01.11.2026',
    changed_to: '26.11.2026 23:59:59',
    date_field: 'LastStockChange',
    after_product_id: 1000000,
    page: 2,
    max_items: 250,
    detail_level: 18,
    suppress_set_data: 1,
  },
  afterbuy_get_stock: { product_ids: [1010101], anrs: ['101010110'], eans: ['4006381333931'], detail_level: 8 },
  afterbuy_list_catalogs: { catalog_ids: [55, 56], level: 1, after_catalog_id: 50, max_items: 20, detail_level: 2 },
  afterbuy_list_shipping_services: { detail_level: 2 },
  afterbuy_list_payment_services: { country: 'DE', platform: 'shop', order_value: 149.9 },
  afterbuy_list_user_defined_flags: {},
  afterbuy_mark_order_shipped: { order_id: 482915733, shipping_date: '27.11.2026 10:00:00', shipping_method: 'DHL Paket', send_shipping_mail: 1 },
  afterbuy_set_order_tracking: {
    order_id: 482915733,
    parcels: [
      { item_id: 12345600, package_number: 1, tracking_number: '00340434161234567890' },
      { item_id: 12345601, package_number: 2, tracking_number: '00340434161234567891', return_tracking_number: 'R-998877' },
    ],
  },
  afterbuy_update_order: {
    order_id: 482915733,
    user_defined_flag: 12,
    user_comment: 'Kunde ruft zurück',
    order_memo: 'Lieferung an Nachbarn erlaubt <OK>',
    invoice_memo: 'Danke für Ihren Einkauf',
    invoice_number: 10045,
    external_invoice: 'RE-2026-10045',
    order_exported: 1,
    invoice_date: '27.11.2026',
    hide_order: 0,
    payment_method: 'PayPal',
    payment_date: '26.11.2026 18:04:00',
    already_paid: 49.9,
    payment_transaction_id: '9XK12345AB678901C',
    send_payment_mail: 0,
    order_info_1: 'Info 1',
    order_info_2: 'Info 2',
    order_info_3: 'Info 3',
    tags: ['VIP', 'Express'],
  },
  afterbuy_update_shipping_address: {
    order_id: 482915733,
    first_name: 'Anna',
    last_name: 'Schmidt',
    company: 'Schmidt & Söhne GmbH',
    street: 'Brehmstraße 3',
    street2: 'c/o Empfang',
    postal_code: '40239',
    city: 'Düsseldorf',
    state: 'NRW',
    country_iso: 'DE',
    phone: '+49 211 000000',
  },
  afterbuy_update_stock_and_prices: {
    products: [
      { product_id: 1010101, quantity: 25, selling_price: 19.99, minimum_stock: 5 },
      { ean: '4006381333931', add_quantity: -2, auction_quantity: 0, buying_price: 8.5, dealer_price: 14, discontinued: 1 },
      { anr: '101010110', quantity: 0 },
    ],
  },
  afterbuy_update_product_details: {
    products: [
      {
        product_id: 1010101,
        name: 'Kaffeebecher "Classic" 300 ml',
        manufacturer_part_number: 'KB-300',
        short_description: 'Steingut, spülmaschinenfest',
        description: '<p>Robuster Becher & spülmaschinenfest</p>',
        keywords: 'Becher, Tasse',
        product_brand: 'Musterhaus',
        tax_rate: 19,
        weight: 0.35,
        delivery_time: '1-3 Werktage',
        stock_location_1: 'A-01-03',
        stock_location_2: 'B-02',
        country_of_origin: 'DE',
        customs_tariff_number: '69120010',
      },
    ],
  },
  afterbuy_cancel_order: { order_id: 482915733, stock_booking: 0, hide_order: 1, flag_id: 0 },
};

const mappingOf = (name: string) =>
  interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
// Mirrors DynamicMcpTools: {{VAR}} interpolated in the mapping, schema
// defaults applied, connector variables offered next to the arguments.
const argsOf = (name: string, params: Record<string, unknown>) => ({
  ...applySchemaDefaults(tool(name).parameters as never, params),
  ...ENV,
});
const render = (name: string, params: Record<string, unknown>) =>
  renderXmlBodyTemplate(mappingOf(name).endpointMapping.bodyTemplate!, argsOf(name, params));
const requiredOnly = (name: string) => {
  const required = tool(name).parameters.required ?? [];
  return Object.fromEntries(Object.entries(SAMPLES[name]).filter(([key]) => required.includes(key)));
};
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, isArray: (n) => ['Filter', 'FilterValue', 'Product', 'ParcelLabel', 'Tag'].includes(n) });
const parse = (xml: string) => parser.parse(xml).Request as Record<string, any>;
const filters = (req: Record<string, any>) =>
  Object.fromEntries(((req.DataFilter?.Filter ?? []) as Array<Record<string, any>>).map((f) => [f.FilterName, f.FilterValues]));
// Placeholders of a template: `${name}`, and the names blocks are keyed on.
const used = (template: string) => {
  const names = new Set<string>();
  for (const [, name] of template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(name);
  for (const [, expr] of template.matchAll(/\$\{[?*]([^}]+)\}/g)) for (const name of expr.split('|')) names.add(name);
  return names;
};

const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = mappingOf(name);
  return engine().execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping,
    argsOf(name, params),
  );
};
const answer = (call: string, status: string, result: string) => ({
  status: 200,
  headers: XML,
  data: `<?xml version="1.0" encoding="utf-8"?>\n<Afterbuy>\n  <CallStatus>${status}</CallStatus>\n  <CallName>${call}</CallName>\n  <VersionID>8</VersionID>\n  <Result>${result}</Result>\n</Afterbuy>`,
});
const errors = (...list: Array<[number, string]>) =>
  `<ErrorList>${list
    .map(([code, text]) => `<Error><ErrorCode>${code}</ErrorCode><ErrorDescription><![CDATA[${text}]]></ErrorDescription><ErrorLongDescription><![CDATA[${text}]]></ErrorLongDescription></Error>`)
    .join('')}</ErrorList>`;

describe('afterbuy adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and describes the XML API with two secret tokens', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.slug).toBe('afterbuy');
    expect(a.name).toBe('Afterbuy');
    expect(a.region).toBe('de');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('afterbuy');
    expect(a.docsUrl).toBe('https://xmldoku.afterbuy.de/dokued/');
    expect(a.requiredEnvVars).toEqual(['AFTERBUY_PARTNER_TOKEN', 'AFTERBUY_ACCOUNT_TOKEN']);
    for (const name of a.requiredEnvVars) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
      expect(new RegExp(a.envVarMeta[name].pattern!).test('abc def')).toBe(false);
    }
    expect(a.setupGuide.steps.flatMap((s) => s.fields ?? [])).toEqual(a.requiredEnvVars);
  });

  it('posts to ABInterface.aspx without an auth header: the tokens are in the XML', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.afterbuy.de/afterbuy');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.headers['Content-Type']).toMatch(/^application\/xml/);
    expect(a.probe).toEqual({ tool: 'afterbuy_get_time', params: {} });
    expect(tool('afterbuy_get_time').parameters.required).toBeUndefined();
  });

  it('has exactly the documented tools, each with its CallName and the AfterbuyGlobal block', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(CALLS).sort());
    for (const t of a.tools) {
      expect(t.name).toMatch(/^afterbuy_[a-z_]+$/);
      expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/ABInterface.aspx', bodyEncoding: 'xml' });
      const template = t.endpointMapping.bodyTemplate!;
      expect(template.startsWith('<?xml version="1.0" encoding="utf-8"?><Request><AfterbuyGlobal>')).toBe(true);
      expect(template).toContain('<PartnerToken>{{AFTERBUY_PARTNER_TOKEN}}</PartnerToken>');
      expect(template).toContain('<AccountToken>{{AFTERBUY_ACCOUNT_TOKEN}}</AccountToken>');
      expect(template).toContain(`<CallName>${CALLS[t.name]}</CallName>`);
      expect(template).toContain('<ErrorLanguage>EN</ErrorLanguage>');
      expect(template.endsWith('</Request>')).toBe(true);
    }
  });

  it('marks the reads read-only, the writes as writes, and installs the cancellation switched off', () => {
    for (const t of a.tools) {
      if (WRITES.has(t.name)) {
        expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      } else {
        expect(`${t.name}:${JSON.stringify(t.annotations)}`).toBe(`${t.name}:{"readOnlyHint":true}`);
        expect(t.enabled).toBeUndefined();
      }
    }
    expect(tool('afterbuy_cancel_order').enabled).toBe(false);
    expect(tool('afterbuy_cancel_order').annotations?.destructiveHint).toBe(true);
    for (const name of ['afterbuy_update_stock_and_prices', 'afterbuy_update_product_details']) {
      expect(tool(name).endpointMapping.bodyTemplate).toContain('<ProductInsert>0</ProductInsert>');
    }
  });

  it('every declared parameter reaches the template, and every placeholder is declared', () => {
    for (const t of a.tools) {
      const template = t.endpointMapping.bodyTemplate!;
      const names = used(template);
      const top = Object.keys(t.parameters.properties ?? {});
      const nested = Object.values(t.parameters.properties ?? {}).flatMap((p) => Object.keys(p.items?.properties ?? {}));
      for (const p of [...top, ...nested]) expect(`${t.name}:${p}:${names.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const n of names) expect(`${t.name}:${n}:${[...top, ...nested].includes(n)}`).toBe(`${t.name}:${n}:true`);
      for (const p of Object.values(t.parameters.properties ?? {})) expect(p.description).toBeTruthy();
      expect(Object.keys(SAMPLES[t.name]).sort()).toEqual(top.sort());
    }
  });

  it.each(Object.keys(CALLS))('%s renders well-formed XML with sample and with required-only arguments', (name) => {
    for (const params of [SAMPLES[name], requiredOnly(name)]) {
      const xml = render(name, params);
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).not.toMatch(/\{\{|\$\{/);
      // Afterbuy reads an empty element as a value; optional ones must be left
      // out. get_stock without any identifier is the one exception: Afterbuy
      // answers it with error 19 ("No product identification transferred").
      const checked = name === 'afterbuy_get_stock' ? xml.replace('<Products></Products>', '') : xml;
      expect(checked).not.toMatch(/<([A-Za-z_0-9]+)><\/\1>/);
      const req = parse(xml);
      expect(req.AfterbuyGlobal).toEqual({
        PartnerToken: ENV.AFTERBUY_PARTNER_TOKEN,
        AccountToken: ENV.AFTERBUY_ACCOUNT_TOKEN,
        CallName: CALLS[name],
        DetailLevel: expect.stringMatching(/^\d+$/),
        ErrorLanguage: 'EN',
      });
    }
  });

  it('list_orders sends each filter in a DataFilter, and none without a filter', () => {
    const req = parse(render('afterbuy_list_orders', SAMPLES.afterbuy_list_orders));
    expect(req.AfterbuyGlobal.DetailLevel).toBe('62');
    expect(req.MaxSoldItems).toBe('100');
    expect(req.OrderDirection).toBe('1');
    expect(req.ReturnHiddenItems).toBe('1');
    const f = filters(req);
    expect(f.DateFilter).toEqual({ DateFrom: '01.11.2026 00:00:00', DateTo: '26.11.2026', FilterValue: ['ModDate'] });
    expect(f.OrderID).toEqual({ FilterValue: ['482915733', '482915734'] });
    expect(f.RangeID).toEqual({ ValueFrom: '482900000', ValueTo: '482999999' });
    expect(f.DefaultFilter).toEqual({ FilterValue: ['not_CompletedAuctions'] });
    expect(f.Plattform).toEqual({ FilterValue: ['ebay'] });
    expect(f.AfterbuyUserEmail).toEqual({ FilterValue: ['anna.schmidt@example.de'] });
    expect(f.AfterbuyUserID).toEqual({ FilterValue: ['7781234'] });
    expect(f.UserDefinedFlag).toEqual({ FilterValue: ['12'] });
    expect(f.ShopId).toEqual({ FilterValue: ['1', '2'] });
    expect(f.Tag).toEqual({ FilterValue: ['Express & Co'] });
    expect(f.InvoiceNumber).toEqual({ FilterValue: ['10045'] });

    const bare = parse(render('afterbuy_list_orders', { status_filter: 'PaidAuctions' }));
    expect(bare.AfterbuyGlobal.DetailLevel).toBe('30');
    expect(bare.MaxSoldItems).toBe('50');
    expect(bare.ReturnHiddenItems).toBeUndefined();
    expect(Object.keys(filters(bare))).toEqual(['DefaultFilter']);
    expect(parse(render('afterbuy_list_orders', {})).DataFilter).toBeUndefined();

    const range = filters(parse(render('afterbuy_list_orders', { after_order_id: 0 })));
    expect(range.RangeID).toEqual({ ValueFrom: '0', ValueTo: '2147483647' });
    const dates = filters(parse(render('afterbuy_list_orders', { date_from: '01.11.2026' })));
    expect(dates.DateFilter).toEqual({ DateFrom: '01.11.2026', FilterValue: ['AuctionEndDate'] });
  });

  it('get_order reads one order by OrderID, hidden ones included', () => {
    const req = parse(render('afterbuy_get_order', { order_id: 482915733 }));
    expect(req.AfterbuyGlobal.DetailLevel).toBe('62');
    expect(req.MaxSoldItems).toBe('1');
    expect(filters(req)).toEqual({ OrderID: { FilterValue: ['482915733'] } });
  });

  it('list_products and get_stock identify products by ProductID, Anr and EAN', () => {
    const req = parse(render('afterbuy_list_products', SAMPLES.afterbuy_list_products));
    expect(req).toMatchObject({ MaxShopItems: '250', SuppressBaseProductRelatedData: '1', PaginationEnabled: '1', PageNumber: '2' });
    const f = filters(req);
    expect(f.ProductID).toEqual({ FilterValue: ['1010101'] });
    expect(f.Anr).toEqual({ FilterValue: ['101010110'] });
    expect(f.Ean).toEqual({ FilterValue: ['4006381333931'] });
    expect(f.Tag).toEqual({ FilterValue: ['Sale'] });
    expect(f.DefaultFilter).toEqual({ FilterValue: ['not_ProductSets'] });
    expect(f.DateFilter).toEqual({ DateFrom: '01.11.2026', DateTo: '26.11.2026 23:59:59', FilterValue: ['LastStockChange'] });
    expect(f.RangeID).toEqual({ ValueFrom: '1000000', ValueTo: '2147483647' });
    const bare = parse(render('afterbuy_list_products', {}));
    expect(bare).toMatchObject({ MaxShopItems: '50', SuppressBaseProductRelatedData: '0' });
    expect(bare.DataFilter).toBeUndefined();
    expect(bare.PaginationEnabled).toBeUndefined();

    const stock = parse(render('afterbuy_get_stock', SAMPLES.afterbuy_get_stock));
    expect(stock.Products.Product).toEqual([{ ProductID: '1010101' }, { Anr: '101010110' }, { EAN: '4006381333931' }]);
  });

  it('mark_order_shipped sets the shipping date without touching parcel data', () => {
    const req = parse(render('afterbuy_mark_order_shipped', SAMPLES.afterbuy_mark_order_shipped));
    expect(req.Orders.Order).toEqual({
      OrderID: '482915733',
      ShippingInfo: { ShippingMethod: 'DHL Paket', DeliveryDate: '27.11.2026 10:00:00', SendShippingMail: '1' },
    });
    const minimal = parse(render('afterbuy_mark_order_shipped', requiredOnly('afterbuy_mark_order_shipped')));
    expect(minimal.Orders.Order.ShippingInfo).toEqual({ DeliveryDate: '27.11.2026 10:00:00', SendShippingMail: '0' });
  });

  it('set_order_tracking sends one ParcelLabel per parcel and nothing else', () => {
    const req = parse(render('afterbuy_set_order_tracking', SAMPLES.afterbuy_set_order_tracking));
    expect(req.Orders.Order).toEqual({
      OrderID: '482915733',
      ShippingInfo: {
        ParcelLabels: {
          ParcelLabel: [
            { ItemID: '12345600', PackageNumber: '1', ParcelLabelNumber: '00340434161234567890' },
            { ItemID: '12345601', PackageNumber: '2', ParcelLabelNumber: '00340434161234567891', ReturnLabelNumber: 'R-998877' },
          ],
        },
      },
    });
    expect(tool('afterbuy_set_order_tracking').description).toMatch(/REPLACES all parcel data/);
  });

  it('update_order sends only the fields passed, escaped, in the documented containers', () => {
    const xml = render('afterbuy_update_order', SAMPLES.afterbuy_update_order);
    expect(xml).toContain('<OrderMemo>Lieferung an Nachbarn erlaubt &lt;OK&gt;</OrderMemo>');
    const order = parse(xml).Orders.Order;
    expect(order).toMatchObject({
      OrderID: '482915733',
      UserDefinedFlag: '12',
      InvoiceNumber: '10045',
      OrderExported: '1',
      HideOrder: '0',
      PaymentInfo: { PaymentMethod: 'PayPal', PaymentDate: '26.11.2026 18:04:00', PaymentTransactionID: '9XK12345AB678901C', AlreadyPaid: '49.9', SendPaymentMail: '0' },
      VorgangsInfo: { VorgangsInfo1: 'Info 1', VorgangsInfo2: 'Info 2', VorgangsInfo3: 'Info 3' },
      Tags: { Tag: ['VIP', 'Express'] },
    });
    expect(parse(render('afterbuy_update_order', { order_id: 1, order_memo: 'x' })).Orders.Order).toEqual({ OrderID: '1', OrderMemo: 'x' });
  });

  it('update_shipping_address switches the order to the new delivery address', () => {
    const order = parse(render('afterbuy_update_shipping_address', SAMPLES.afterbuy_update_shipping_address)).Orders.Order;
    expect(order.BuyerInfo.ShippingAddress).toMatchObject({
      UseShippingAddress: '1',
      LastName: 'Schmidt',
      Company: 'Schmidt & Söhne GmbH',
      Street: 'Brehmstraße 3',
      PostalCode: '40239',
      City: 'Düsseldorf',
      CountryISO: 'DE',
    });
  });

  it('product updates identify each product and never create one', () => {
    const products = parse(render('afterbuy_update_stock_and_prices', SAMPLES.afterbuy_update_stock_and_prices)).Products.Product;
    expect(products).toEqual([
      { ProductIdent: { ProductInsert: '0', ProductID: '1010101' }, Quantity: '25', MinimumStock: '5', SellingPrice: '19.99' },
      { ProductIdent: { ProductInsert: '0', EAN: '4006381333931' }, AuctionQuantity: '0', AddQuantity: '-2', Discontinued: '1', BuyingPrice: '8.5', DealerPrice: '14' },
      { ProductIdent: { ProductInsert: '0', Anr: '101010110' }, Quantity: '0' },
    ]);
    const details = parse(render('afterbuy_update_product_details', SAMPLES.afterbuy_update_product_details)).Products.Product[0];
    expect(details).toMatchObject({
      ProductIdent: { ProductInsert: '0', ProductID: '1010101' },
      Name: 'Kaffeebecher "Classic" 300 ml',
      Description: '<p>Robuster Becher & spülmaschinenfest</p>',
      Stocklocation_1: 'A-01-03',
      CustomsTariffNumber: '69120010',
    });
  });

  it('cancel_order sends one OrderCancellation with the defaults Afterbuy documents', () => {
    const req = parse(render('afterbuy_cancel_order', { order_id: 482915733 }));
    expect(req.OrderCancellations.OrderCancellation).toEqual({ OrderId: '482915733', StockBooking: '-1', HideOrder: '0', MarkId: '-1' });
  });

  it('posts the XML to the endpoint and hands the parsed answer back', async () => {
    mockedAxios.mockResolvedValue(
      answer('GetAfterbuyTime', 'Success', '<AfterbuyTimeStamp>27.11.2026 12:06:19</AfterbuyTimeStamp><AfterbuyUniversalTimeStamp>27.11.2026 11:06:19</AfterbuyUniversalTimeStamp>'),
    );
    const result = (await call('afterbuy_get_time', {})) as Record<string, any>;
    expect(result.Afterbuy.CallStatus).toBe('Success');
    expect(result.Afterbuy.Result.AfterbuyTimeStamp).toBe('27.11.2026 12:06:19');
    const sent = mockedAxios.mock.calls[0][0];
    expect(sent.url).toBe(ENDPOINT);
    expect(sent.method).toBe('POST');
    expect(sent.headers['Content-Type']).toMatch(/^application\/xml/);
    expect(sent.headers.Authorization).toBeUndefined();
    expect(sent.data).toContain(`<PartnerToken>${ENV.AFTERBUY_PARTNER_TOKEN}</PartnerToken>`);
  });

  it('reports refused tokens as 401, also when Afterbuy lists several errors', async () => {
    mockedAxios.mockResolvedValue(answer('GetAfterbuyTime', 'Error', errors([8, 'Partner data is invalid (Wrong password?)'])));
    await expect(call('afterbuy_get_time', {})).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/8 Partner data is invalid/) });
    mockedAxios.mockResolvedValue(
      answer('GetAfterbuyTime', 'Error', errors([5, 'Partner password is missing or is empty.'], [8, 'Partner data is invalid (Wrong password?)'])),
    );
    await expect(call('afterbuy_get_time', {})).rejects.toMatchObject({ status: 401 });
  });

  it('reports an unavailable interface as 503 and other errors as 400', async () => {
    mockedAxios.mockResolvedValue(answer('GetSoldItems', 'Error', errors([13, 'XML Interface is currently not available.'])));
    await expect(call('afterbuy_list_orders', { status_filter: 'PaidAuctions' })).rejects.toMatchObject({ status: 503 });
    mockedAxios.mockResolvedValue(answer('UpdateSoldItems', 'Error', errors([3002, 'A package number is missing or is out of valid range.'])));
    const failure = call('afterbuy_set_order_tracking', SAMPLES.afterbuy_set_order_tracking);
    await expect(failure).rejects.toBeInstanceOf(ResponseBodyError);
    await expect(call('afterbuy_set_order_tracking', SAMPLES.afterbuy_set_order_tracking)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/3002 A package number/),
    });
  });

  it('hands back "No items found" and warnings as answers, not failures', async () => {
    mockedAxios.mockResolvedValue(answer('GetSoldItems', 'Error', errors([15, 'No items found.'])));
    const empty = (await call('afterbuy_list_orders', { status_filter: 'ReadyToShip' })) as Record<string, any>;
    expect(empty.Afterbuy.Result.ErrorList.Error.ErrorCode).toBe('15');
    mockedAxios.mockResolvedValue(
      answer('UpdateShopProducts', 'Warning', '<WarningList><Warning><WarningCode>1</WarningCode><WarningDescription>Product not found</WarningDescription></Warning></WarningList>'),
    );
    const warned = (await call('afterbuy_update_stock_and_prices', SAMPLES.afterbuy_update_stock_and_prices)) as Record<string, any>;
    expect(warned.Afterbuy.CallStatus).toBe('Warning');
  });

  it('explains booking, tokens, paging, the parcel rule and the date format', () => {
    expect(a.instructions).toMatch(/Schnittstellen zu Afterbuy \(XML & Shop\)/);
    expect(a.instructions).toMatch(/AFTERBUY_PARTNER_TOKEN/);
    expect(a.instructions).toMatch(/LastOrderID/);
    expect(a.instructions).toMatch(/replaces all parcel data/);
    expect(a.instructions).toMatch(/DD\.MM\.YYYY HH:MM:SS/);
    expect(a.instructions).toMatch(/50,000 calls a day/);
  });
});

const live = process.env.RUN_AFTERBUY_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('afterbuy: live', () => {
  it('refuses wrong tokens with error 8 in a CallStatus Error answer', async () => {
    const response = await liveFetch.post(
      ENDPOINT,
      '<?xml version="1.0" encoding="utf-8"?><Request><AfterbuyGlobal><PartnerToken>wrong</PartnerToken><AccountToken>wrong</AccountToken><CallName>GetAfterbuyTime</CallName><DetailLevel>0</DetailLevel><ErrorLanguage>EN</ErrorLanguage></AfterbuyGlobal></Request>',
      { headers: { 'Content-Type': 'application/xml' }, validateStatus: () => true, responseType: 'text' },
    );
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toMatch(/xml/);
    expect(String(response.data)).toMatch(/<CallStatus>Error<\/CallStatus>/);
    expect(String(response.data)).toMatch(/<ErrorCode>8<\/ErrorCode>/);
  }, 60_000);

  it('reads the server time, the seller flags and the newest order', async () => {
    const env = { AFTERBUY_PARTNER_TOKEN: process.env.AFTERBUY_PARTNER_TOKEN, AFTERBUY_ACCOUNT_TOKEN: process.env.AFTERBUY_ACCOUNT_TOKEN };
    if (!env.AFTERBUY_PARTNER_TOKEN || !env.AFTERBUY_ACCOUNT_TOKEN) {
      throw new Error('Set AFTERBUY_PARTNER_TOKEN and AFTERBUY_ACCOUNT_TOKEN for the live check');
    }
    mockedAxios.mockImplementation((cfg: unknown) => (liveFetch as unknown as (c: unknown) => Promise<unknown>)(cfg));
    const read = (name: string, params: Record<string, unknown>) => {
      const { config, endpointMapping } = interpolateConnectorConfig(
        { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
        tool(name).endpointMapping as never,
        env as Record<string, string>,
      );
      return engine().execute(
        { baseUrl: config.baseUrl, authType: a.connector.authType, headers: config.headers, errorWhen: a.connector.config.errorWhen } as never,
        endpointMapping,
        applySchemaDefaults(tool(name).parameters as never, params),
      ) as Promise<Record<string, any>>;
    };
    const time = await read('afterbuy_get_time', {});
    expect(time.Afterbuy.CallStatus).toMatch(/Success|Warning/);
    expect(time.Afterbuy.Result.AfterbuyTimeStamp).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
    const flags = await read('afterbuy_list_user_defined_flags', {});
    expect(flags.Afterbuy.CallName).toBe('GetUserDefinedFlags');
    const orders = await read('afterbuy_list_orders', { after_order_id: 0, newest_first: 1, max_items: 1, detail_level: 0 });
    expect(orders.Afterbuy.CallName).toBe('GetSoldItems');
  }, 120_000);
});
