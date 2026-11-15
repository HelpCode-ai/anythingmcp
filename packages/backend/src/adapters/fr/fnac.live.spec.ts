import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { XMLValidator } from 'fast-xml-parser';
import * as adapter from './fnac.json';
import { RestEngine, renderXmlBodyTemplate } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Fnac Darty Marketplace seller API (XML, version 2.6).
 *
 * Static checks always run: the LOGIN_TOKEN configuration (POST /auth with an
 * XML document holding partner id, shop id and key; the token read from the
 * XML answer and sent as the `token` attribute of every request, never in a
 * header), every tool's service path against the API documentation
 * (https://partners-test.mp.fnacdarty.com/docs/api/2.6/services/index.html),
 * the XML each template renders with sample parameters (well formed, with
 * partner id, shop id and token, optional elements left out), the tools that
 * install switched off (offer deletion, order refusal, refunds), and a call
 * through the real RestEngine and LoginTokenService with axios mocked: login
 * in XML, token in the body, a new login when Fnac reports the token expired.
 *
 * Live checks run only with RUN_FNAC_LIVE=1. Without credentials they confirm
 * that the test platform refuses a wrong key with the XML error ERR_097; with
 * FNAC_PARTNER_ID, FNAC_SHOP_ID and FNAC_KEY (production values) they sign in
 * and read the carriers and the countries. Reads only.
 *
 *   RUN_FNAC_LIVE=1 FNAC_PARTNER_ID=... FNAC_SHOP_ID=... FNAC_KEY=... \
 *     npx jest src/adapters/fr/fnac.live.spec.ts
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
  endpointMapping: { method: string; path: string; bodyEncoding?: string; bodyTemplate?: string; headers?: Record<string, string> };
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
  description: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; link?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide: { effort: string; steps: Array<{ id: string; fields?: string[] }> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers?: Record<string, string>;
    config: { errorWhen: Array<{ path: string; status: number; in?: string[]; equals?: string }> };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const NS = 'http://www.fnac.com/schemas/mp-dialog.xsd';
const BASE = 'https://vendeur.fnac.com/api.php';
const XML = { 'content-type': 'text/xml; charset=UTF-8' };
// Made up, in the shape Fnac uses (UUIDs); the key is built at runtime so no
// literal looks like a real credential.
const ENV: Record<string, string> = {
  FNAC_PARTNER_ID: '1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D',
  FNAC_SHOP_ID: '6D5C4B3A-2F1E-D0C9-B8A7-F6E5D4C3B2A1',
  FNAC_KEY: ['0D00AF3D', 'x'.repeat(4), 'k&y'].join('-'),
};
const TOKEN = '61DF8A84-4465-7D36-20A4-00F941207026';
const HEADER = `partner_id="${ENV.FNAC_PARTNER_ID}" shop_id="${ENV.FNAC_SHOP_ID}" token="${TOKEN}"`;
const D1 = '2026-11-01T00:00:00+01:00';
const D2 = '2026-11-14T23:59:59+01:00';

// Every tool, its service path (always POST) and the root element of its
// request, from the "Services list" of the API documentation. Pricing V3 is
// the `pricing_query` document sent to /prices_query.
const SERVICES: Record<string, [path: string, root: string]> = {
  fnac_query_offers: ['/offers_query', 'offers_query'],
  fnac_update_offers: ['/offers_update', 'offers_update'],
  fnac_delete_offers: ['/offers_update', 'offers_update'],
  fnac_get_batch_status: ['/batch_status', 'batch_status'],
  fnac_list_running_batches: ['/batch_query', 'batch_query'],
  fnac_query_orders: ['/orders_query', 'orders_query'],
  fnac_accept_order: ['/orders_update', 'orders_update'],
  fnac_accept_or_refuse_order_lines: ['/orders_update', 'orders_update'],
  fnac_ship_order: ['/orders_update', 'orders_update'],
  fnac_ship_order_lines: ['/orders_update', 'orders_update'],
  fnac_update_order_tracking: ['/orders_update', 'orders_update'],
  fnac_list_carriers: ['/carriers_query', 'carriers_query'],
  fnac_list_countries: ['/countries_query', 'countries_query'],
  fnac_query_order_comments: ['/client_order_comments_query', 'client_order_comments_query'],
  fnac_reply_to_order_comment: ['/client_order_comments_update', 'client_order_comments_update'],
  fnac_query_messages: ['/messages_query', 'messages_query'],
  fnac_reply_to_message: ['/messages_update', 'messages_update'],
  fnac_update_message_status: ['/messages_update', 'messages_update'],
  fnac_query_incidents: ['/incidents_query', 'incidents_query'],
  fnac_refund_order_lines: ['/incidents_update', 'incidents_update'],
  fnac_query_competing_offers: ['/prices_query', 'pricing_query'],
  fnac_query_shop_invoices: ['/shop_invoices_query', 'shop_invoices_query'],
  fnac_query_sales_periods: ['/sales_periods_query', 'sales_periods_query'],
};
const READS = [
  'fnac_query_offers',
  'fnac_get_batch_status',
  'fnac_list_running_batches',
  'fnac_query_orders',
  'fnac_list_carriers',
  'fnac_list_countries',
  'fnac_query_order_comments',
  'fnac_query_messages',
  'fnac_query_incidents',
  'fnac_query_competing_offers',
  'fnac_query_shop_invoices',
  'fnac_query_sales_periods',
];
const SWITCHED_OFF = ['fnac_accept_or_refuse_order_lines', 'fnac_delete_offers', 'fnac_refund_order_lines'];

// One call per tool with every parameter set. The same documents, rendered
// by this adapter on 2026-11-14, validate against the XSD files Fnac
// publishes with its documentation (fnac_mp_api_xsd.tgz).
const SAMPLES: Record<string, Record<string, unknown>> = {
  fnac_query_offers: { page: 2, results_count: 10, with_fees: true, date_type: 'Created', date_min: D1, date_max: D2, quantity_value: 0, quantity_mode: 'GreaterThan', product_fnac_id: '123', offer_fnac_id: 'abc', offer_seller_id: 'SKU & <1>', promotion_types: ['Sales', 'FlashSale'] },
  fnac_update_offers: {
    offers: [
      { offer_reference: 'SKU-1', offer_reference_type: 'SellerSku', product_reference: '7321950286485', product_reference_type: 'Ean', price: 10.5, product_state: 11, quantity: 0, description_fr: 'Neuf & emballé', description_es: 'Nuevo', description_pt: 'Novo', description_nl: 'Nieuw', internal_comment: 'A1', showcase: 1, adherent_price: 9.5, is_shipping_free: false, logistic_type_id: '107', time_to_ship: 3 },
      { offer_reference: 'SKU-2', price: 20, quantity: 4 },
    ],
  },
  fnac_delete_offers: { offer_references: ['SKU-1', 'SKU-2'], offer_reference_type: 'SellerSku' },
  fnac_get_batch_status: { batch_id: '73169053-DD44-82E4-D3E7-E298D1F27B13' },
  fnac_list_running_batches: {},
  fnac_query_orders: { page: 1, results_count: 50, states: ['Created', 'ToShip'], date_type: 'UpdatedAt', date_min: D1, date_max: D2, sort: 'DESC', order_fnac_ids: ['1P3HCS77E4QYE', '0FI06VER1XBMW'], product_fnac_id: '1', offer_fnac_id: '2', offer_seller_id: 'SKU-1' },
  fnac_accept_order: { order_id: '1P3HCS77E4QYE', expedition_country_code: 'FRA' },
  fnac_accept_or_refuse_order_lines: { order_id: '1P3HCS77E4QYE', lines: [{ order_detail_id: 1, decision: 'Accepted', expedition_country_code: 'FRA' }, { order_detail_id: 2, decision: 'Refused' }] },
  fnac_ship_order: { order_id: '1P3HCS77E4QYE', tracking_number: '77894512348', tracking_company: 'UPS' },
  fnac_ship_order_lines: { order_id: '1P3HCS77E4QYE', lines: [{ order_detail_id: 1, tracking_number: '1', tracking_company: 'UPS' }, { order_detail_id: 2 }] },
  fnac_update_order_tracking: { order_id: '1P3HCS77E4QYE', tracking_number: '77894512348', tracking_company: 'UPS' },
  fnac_list_carriers: {},
  fnac_list_countries: {},
  fnac_query_order_comments: { page: 1, results_count: 2, date_type: 'Created', date_min: D1, date_max: D2, rate_value: 2, rate_mode: 'LessThanOrEquals', client_order_comment_id: '474E54D6-E21E-F62E-0BE6-745FF40C5F2A', order_fnac_id: '1P3HCS77E4QYE' },
  fnac_reply_to_order_comment: { comment_id: '474E54D6-E21E-F62E-0BE6-745FF40C5F2A', reply: 'Merci <3 & à bientôt' },
  fnac_query_messages: { page: 1, results_count: 2, date_type: 'UpdatedAt', date_min: D1, date_max: D2, message_type: 'ORDER', message_archived: 'FALSE', message_state: 'UNREAD', message_id: 'AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D', order_fnac_id: '1P3HCS77E4QYE', offer_fnac_id: 'x', offer_seller_id: 'SKU-1', sort_field: 'CREATED_AT', sort_order: 'ASC', from_types: ['CLIENT', 'CALLCENTER'] },
  fnac_reply_to_message: { message_id: 'AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D', message_description: 'Bonjour', message_type: 'ORDER', message_to: 'CLIENT', message_subject: 'order_information' },
  fnac_update_message_status: { message_ids: ['AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D', '92E6410E-F981-881E-2334-17353E5A8561'], action: 'archive' },
  fnac_query_incidents: { page: 1, results_count: 10, date_type: 'ClosedAt', date_min: D1, date_max: D2, status: 'OPENED', incident_type: 1, incident_id: '644D00B4-3D61-ECFD-0D62-589AE7B39CEA', closed_status: 6, waiting_for_seller_answer: 'TRUE', opened_by: 'client', closed_by: 'call-center', sort: 'ASC', order_fnac_id: '1A4JMPE5PG02W' },
  fnac_refund_order_lines: { order_id: '07LWQ6278YJUI', action: 'partial_refund', lines: [{ order_detail_id: 1, refund_reason: 'damaged_article', refund_amount_product: 1.12, refund_amount_shipping: 0.7 }, { order_detail_id: 2, refund_reason: 'no_stock' }] },
  fnac_query_competing_offers: { product_references: ['0886971942323', '9780262510875'], reference_type: 'Ean', sellers: 'others', states: 'new', prices: 'standard' },
  fnac_query_shop_invoices: { page: 1, results_count: 10, date_min: D1, date_max: D2 },
  fnac_query_sales_periods: { page: 1, results_count: 5, date_type: 'EndAt', date_min: D1, date_max: D2, reference: 'SLD_HIVER_2017' },
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the mapping and in
// authConfig, schema defaults applied, connector variables offered as
// parameters; the engine adds the token.
const mappingOf = (name: string) =>
  interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
const render = (name: string, params: Record<string, unknown>) =>
  renderXmlBodyTemplate(
    mappingOf(name).endpointMapping.bodyTemplate!,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
    { loginToken: TOKEN },
  );
const requiredOnly = (name: string) => {
  const required = tool(name).parameters.required ?? [];
  return Object.fromEntries(Object.entries(SAMPLES[name]).filter(([key]) => required.includes(key)));
};
const body = (name: string, inner: string, attributes = '') => {
  const root = SERVICES[name][1];
  return `<?xml version="1.0" encoding="utf-8"?><${root} xmlns="${NS}" ${HEADER}${attributes}>${inner}</${root}>`;
};
// The placeholders of a template: `${name}`, and the names blocks are keyed on.
const used = (template: string) => {
  const names = new Set<string>();
  for (const [, name] of template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(name);
  for (const [, expr] of template.matchAll(/\$\{[?*]([^}]+)\}/g)) for (const name of expr.split('|')) names.add(name);
  return names;
};
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const realLogin = () =>
  new LoginTokenService(
    { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
    config,
  );
const call = (name: string, params: Record<string, unknown>, login: LoginTokenService) => {
  const { config: cfg, endpointMapping } = mappingOf(name);
  return new RestEngine({} as OAuth2TokenService, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config.errorWhen,
      connectorId: 'conn-fnac',
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sentAt = (index: number) => mockedAxios.mock.calls[index][0];
const authAnswer = (token: string) => ({
  status: 200,
  data:
    `<?xml version="1.0" encoding="utf-8"?>\n<auth_response status="OK" xmlns="${NS}">\n  <token>${token}</token>\n` +
    `  <validity>${new Date(Date.now() + 3_600_000).toISOString()}</validity>\n  <version>2.6.0</version>\n</auth_response>`,
  headers: XML,
});
const carriers =
  `<?xml version="1.0" encoding="utf-8"?><carriers_query_response xmlns="${NS}" status="OK">` +
  '<carrier code="CHRONOPOST" global="1"><name><![CDATA[Chronopost]]></name></carrier>' +
  '<carrier code="UPS" global="1"><name><![CDATA[UPS]]></name></carrier></carriers_query_response>';
const refused = (root: string, code: string, text: string) =>
  `<?xml version="1.0" encoding="UTF-8" ?>\n<${root} status="FATAL" xmlns="${NS}">\n    <error severity="FATAL" code="${code}">${text}</error>\n</${root}>`;

describe('fnac adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /auth with an XML document and carries the token in the request body', () => {
    expect(a.slug).toBe('fnac');
    expect(a.name).toBe('Fnac Darty Marketplace');
    expect(a.region).toBe('fr');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('fnac');
    expect(a.docsUrl).toBe('https://partners-test.mp.fnacdarty.com/docs/api/2.6/services/index.html');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: `${BASE}/auth`,
      loginMethod: 'POST',
      loginBodyFormat: 'xml',
      loginBody: `<?xml version="1.0" encoding="utf-8"?><auth xmlns="${NS}"><partner_id>\${username}</partner_id><shop_id>\${aud}</shop_id><key>\${password}</key></auth>`,
      loginHeaders: { 'Content-Type': 'text/xml; charset=utf-8' },
      username: '{{FNAC_PARTNER_ID}}',
      password: '{{FNAC_KEY}}',
      aud: '{{FNAC_SHOP_ID}}',
      loginResponseFormat: 'xml',
      tokenJsonPath: 'auth_response.token',
      expiryJsonPath: 'auth_response.validity',
      expiryFormat: 'iso8601',
      tokenTTLSeconds: 900,
      proactiveRefreshSeconds: 120,
      refreshOn401: true,
      refreshOnBody401: true,
      tokenPlacement: 'body',
    });
    expect(a.connector.headers).toEqual({ 'Content-Type': 'text/xml; charset=utf-8' });
    expect(a.requiredEnvVars).toEqual(['FNAC_PARTNER_ID', 'FNAC_SHOP_ID', 'FNAC_KEY']);
    expect(a.envVarMeta.FNAC_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.FNAC_PARTNER_ID.secret).toBeUndefined();
    expect(a.envVarMeta.FNAC_SHOP_ID.secret).toBeUndefined();
    for (const name of a.requiredEnvVars) {
      expect(a.envVarMeta[name].link).toMatch(/^https:\/\/marketplace\.fnacdarty\.com\//);
      expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
      expect(new RegExp(a.envVarMeta[name].pattern!).test('has a space')).toBe(false);
    }
    expect(new RegExp(a.envVarMeta.FNAC_SHOP_ID.pattern!).test('not-a-uuid')).toBe(false);
  });

  it('posts every tool to its service path with an XML body', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(SERVICES).sort());
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(SERVICES).sort());
    for (const t of a.tools) {
      const [path, root] = SERVICES[t.name];
      expect(t.name.startsWith('fnac_')).toBe(true);
      expect(`${t.name}: ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name}: POST ${path}`);
      expect(t.endpointMapping.bodyEncoding).toBe('xml');
      // No tool overrides the connector's Content-Type or adds a header.
      expect(t.endpointMapping.headers).toBeUndefined();
      // The request header every service asks for: namespace, partner id,
      // shop id and the token, as attributes of the root element.
      expect(t.endpointMapping.bodyTemplate!.startsWith(
        `<?xml version="1.0" encoding="utf-8"?><${root} xmlns="${NS}" partner_id="{{FNAC_PARTNER_ID}}" shop_id="{{FNAC_SHOP_ID}}" token="\${loginToken}"`,
      )).toBe(true);
      expect(t.endpointMapping.bodyTemplate!.endsWith(`</${root}>`)).toBe(true);
      // The key travels in the login only.
      expect(t.endpointMapping.bodyTemplate).not.toContain('FNAC_KEY');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('declares every parameter a template uses, and uses every parameter it declares', () => {
    for (const t of a.tools) {
      const names = used(t.endpointMapping.bodyTemplate!);
      names.delete('loginToken');
      const properties = t.parameters.properties ?? {};
      const declared = new Set(Object.keys(properties));
      for (const schema of Object.values(properties)) {
        for (const key of Object.keys(schema.items?.properties ?? {})) declared.add(key);
      }
      expect(`${t.name}: ${[...names].sort().join(',')}`).toBe(`${t.name}: ${[...declared].sort().join(',')}`);
      for (const [key, schema] of Object.entries(properties)) {
        expect(`${t.name}.${key}: ${typeof schema.description}`).toBe(`${t.name}.${key}: string`);
        for (const [field, nested] of Object.entries(schema.items?.properties ?? {})) {
          expect(`${t.name}.${key}.${field}: ${typeof nested.description}`).toBe(`${t.name}.${key}.${field}: string`);
        }
      }
      for (const key of t.parameters.required ?? []) expect(declared.has(key)).toBe(true);
    }
  });

  it('renders well-formed XML with partner id, shop id and token, with all parameters and with the required ones only', () => {
    for (const t of a.tools) {
      const [, root] = SERVICES[t.name];
      for (const params of [SAMPLES[t.name], requiredOnly(t.name)]) {
        const xml = render(t.name, params);
        expect(`${t.name}: ${JSON.stringify(XMLValidator.validate(xml))}`).toBe(`${t.name}: true`);
        expect(xml.startsWith(`<?xml version="1.0" encoding="utf-8"?><${root} xmlns="${NS}" ${HEADER}`)).toBe(true);
        // Nothing is left to substitute, and no element or attribute is sent
        // empty: Fnac validates requests against its schema.
        expect(xml).not.toMatch(/\$\{|\{\{/);
        expect(`${t.name}: ${xml.match(/<(\w+)[^>]*><\/\1>|="\s*"/g)?.filter((m) => !m.startsWith('<batch_query')) ?? []}`).toBe(`${t.name}: `);
      }
    }
  });

  it('leaves optional filters out and keeps the defaults', () => {
    expect(render('fnac_query_offers', {})).toBe(body('fnac_query_offers', '<paging>1</paging>', ' results_count="50"'));
    expect(render('fnac_query_orders', {})).toBe(body('fnac_query_orders', '<paging>1</paging>', ' results_count="50"'));
    expect(render('fnac_list_running_batches', {})).toBe(body('fnac_list_running_batches', ''));
    expect(render('fnac_list_carriers', {})).toBe(body('fnac_list_carriers', '<query>all</query>'));
    expect(render('fnac_list_countries', {})).toBe(body('fnac_list_countries', '<query>all</query>'));
    expect(render('fnac_query_shop_invoices', { date_min: D1 })).toBe(
      body('fnac_query_shop_invoices', `<paging>1</paging><date><min>${D1}</min></date>`, ' results_count="50"'),
    );
    // Orders come at most 50 per call.
    expect(tool('fnac_query_orders').parameters.properties!.results_count).toMatchObject({ default: 50, maximum: 50 });
  });

  it('renders the queries with the element names and enumerations of the documentation', () => {
    expect(render('fnac_query_offers', SAMPLES.fnac_query_offers)).toBe(
      body(
        'fnac_query_offers',
        `<paging>2</paging><date type="Created"><min>${D1}</min><max>${D2}</max></date><quantity mode="GreaterThan" value="0"/>` +
          '<product_fnac_id>123</product_fnac_id><offer_fnac_id>abc</offer_fnac_id><offer_seller_id>SKU &amp; &lt;1&gt;</offer_seller_id>' +
          '<promotion_types><promotion_type>Sales</promotion_type><promotion_type>FlashSale</promotion_type></promotion_types>',
        ' results_count="10" with_fees="true"',
      ),
    );
    expect(render('fnac_query_orders', SAMPLES.fnac_query_orders)).toBe(
      body(
        'fnac_query_orders',
        '<paging>1</paging><states><state>Created</state><state>ToShip</state></states>' +
          `<date type="UpdatedAt"><min>${D1}</min><max>${D2}</max></date><sort_by>DESC</sort_by>` +
          '<orders_fnac_id><order_fnac_id>1P3HCS77E4QYE</order_fnac_id><order_fnac_id>0FI06VER1XBMW</order_fnac_id></orders_fnac_id>' +
          '<product_fnac_id>1</product_fnac_id><offer_fnac_id>2</offer_fnac_id><offer_seller_id>SKU-1</offer_seller_id>',
        ' results_count="50"',
      ),
    );
    expect(render('fnac_query_messages', { message_state: 'UNREAD', sort_field: 'CREATED_AT', from_types: ['CLIENT'] })).toBe(
      body(
        'fnac_query_messages',
        '<paging>1</paging><message_state>UNREAD</message_state><sort_by type="DESC">CREATED_AT</sort_by>' +
          '<message_from_types><from_type>CLIENT</from_type></message_from_types>',
        ' results_count="50"',
      ),
    );
    expect(render('fnac_query_incidents', { status: 'OPENED', incident_type: 1, order_fnac_id: '1A4JMPE5PG02W', opened_by: 'call-center' })).toBe(
      body(
        'fnac_query_incidents',
        '<paging>1</paging><status>OPENED</status><type>1</type><opened_by>call-center</opened_by><order>1A4JMPE5PG02W</order>',
        ' results_count="50"',
      ),
    );
    expect(render('fnac_query_order_comments', { rate_value: 2, rate_mode: 'LessThanOrEquals' })).toBe(
      body('fnac_query_order_comments', '<paging>1</paging><rate mode="LessThanOrEquals" value="2"/>', ' results_count="50"'),
    );
    expect(render('fnac_query_sales_periods', { date_max: D2 })).toBe(
      body('fnac_query_sales_periods', `<paging>1</paging><date type="StartAt"><max>${D2}</max></date>`, ' results_count="50"'),
    );
    // Pricing V3: the pricing_query document, sent to /prices_query.
    expect(render('fnac_query_competing_offers', { product_references: ['0886971942323'] })).toBe(
      body('fnac_query_competing_offers', '<product_reference type="Ean">0886971942323</product_reference>'),
    );
    expect(render('fnac_query_competing_offers', SAMPLES.fnac_query_competing_offers)).toBe(
      body(
        'fnac_query_competing_offers',
        '<product_reference type="Ean">0886971942323</product_reference><product_reference type="Ean">9780262510875</product_reference>',
        ' sellers="others" states="new" prices="standard"',
      ),
    );
  });

  it('renders the order updates as the documentation shows them', () => {
    expect(render('fnac_accept_order', { order_id: '1P3HCS98E4QYE', expedition_country_code: 'FRA' })).toBe(
      body(
        'fnac_accept_order',
        '<order order_id="1P3HCS98E4QYE" action="accept_all_orders"><order_detail><action>Accepted</action>' +
          '<expedition_country_code>FRA</expedition_country_code></order_detail></order>',
      ),
    );
    expect(render('fnac_accept_or_refuse_order_lines', SAMPLES.fnac_accept_or_refuse_order_lines)).toBe(
      body(
        'fnac_accept_or_refuse_order_lines',
        '<order order_id="1P3HCS77E4QYE" action="accept_order">' +
          '<order_detail><order_detail_id>1</order_detail_id><action>Accepted</action><expedition_country_code>FRA</expedition_country_code></order_detail>' +
          '<order_detail><order_detail_id>2</order_detail_id><action>Refused</action></order_detail></order>',
      ),
    );
    expect(render('fnac_ship_order', { order_id: '1P3HCS77E4QYE' })).toBe(
      body('fnac_ship_order', '<order order_id="1P3HCS77E4QYE" action="confirm_all_to_send"><order_detail><action>Shipped</action></order_detail></order>'),
    );
    expect(render('fnac_ship_order', SAMPLES.fnac_ship_order)).toBe(
      body(
        'fnac_ship_order',
        '<order order_id="1P3HCS77E4QYE" action="confirm_all_to_send"><order_detail><action>Shipped</action>' +
          '<tracking_number>77894512348</tracking_number><tracking_company>UPS</tracking_company></order_detail></order>',
      ),
    );
    expect(render('fnac_ship_order_lines', SAMPLES.fnac_ship_order_lines)).toBe(
      body(
        'fnac_ship_order_lines',
        '<order order_id="1P3HCS77E4QYE" action="confirm_to_send">' +
          '<order_detail><order_detail_id>1</order_detail_id><action>Shipped</action><tracking_number>1</tracking_number><tracking_company>UPS</tracking_company></order_detail>' +
          '<order_detail><order_detail_id>2</order_detail_id><action>Shipped</action></order_detail></order>',
      ),
    );
    expect(render('fnac_update_order_tracking', SAMPLES.fnac_update_order_tracking)).toBe(
      body(
        'fnac_update_order_tracking',
        '<order order_id="1P3HCS77E4QYE" action="update_all"><order_detail><action>Updated</action>' +
          '<tracking_number>77894512348</tracking_number><tracking_company>UPS</tracking_company></order_detail></order>',
      ),
    );
    expect(tool('fnac_update_order_tracking').parameters.required).toEqual(['order_id', 'tracking_company']);
  });

  it('renders offer updates, deletions, replies and refunds', () => {
    expect(render('fnac_update_offers', SAMPLES.fnac_update_offers)).toBe(
      body(
        'fnac_update_offers',
        '<offer><product_reference type="Ean">7321950286485</product_reference><offer_reference type="SellerSku">SKU-1</offer_reference>' +
          '<price>10.5</price><product_state>11</product_state><quantity>0</quantity><description_fr>Neuf &amp; emballé</description_fr>' +
          '<description_es>Nuevo</description_es><description_pt>Novo</description_pt><description_nl>Nieuw</description_nl>' +
          '<internal_comment>A1</internal_comment><showcase>1</showcase><adherent_price>9.5</adherent_price>' +
          '<is_shipping_free>false</is_shipping_free><logistic_type_id>107</logistic_type_id><time_to_ship>3</time_to_ship></offer>' +
          '<offer><offer_reference>SKU-2</offer_reference><price>20</price><quantity>4</quantity></offer>',
      ),
    );
    expect(render('fnac_delete_offers', { offer_references: ['MYSKU_TO_DELETE'] })).toBe(
      body('fnac_delete_offers', '<offer><offer_reference type="SellerSku">MYSKU_TO_DELETE</offer_reference><treatment>delete</treatment></offer>'),
    );
    expect(render('fnac_get_batch_status', SAMPLES.fnac_get_batch_status)).toBe(
      body('fnac_get_batch_status', '<batch_id>73169053-DD44-82E4-D3E7-E298D1F27B13</batch_id>'),
    );
    expect(render('fnac_reply_to_order_comment', SAMPLES.fnac_reply_to_order_comment)).toBe(
      body(
        'fnac_reply_to_order_comment',
        '<comment id="474E54D6-E21E-F62E-0BE6-745FF40C5F2A"><comment_reply>Merci &lt;3 &amp; à bientôt</comment_reply></comment>',
      ),
    );
    expect(render('fnac_reply_to_message', SAMPLES.fnac_reply_to_message)).toBe(
      body(
        'fnac_reply_to_message',
        '<message action="reply" id="AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D"><message_to>CLIENT</message_to>' +
          '<message_subject>order_information</message_subject><message_description>Bonjour</message_description><message_type>ORDER</message_type></message>',
      ),
    );
    expect(render('fnac_update_message_status', { message_ids: ['AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D'] })).toBe(
      body('fnac_update_message_status', '<message action="mark_as_read" id="AE7A5365-79CF-71C6-BEB4-FA1492C1FB4D"/>'),
    );
    expect(render('fnac_refund_order_lines', { order_id: '07LWQ6278YJUI', lines: [{ order_detail_id: 1, refund_reason: 'no_stock' }] })).toBe(
      body(
        'fnac_refund_order_lines',
        '<order order_id="07LWQ6278YJUI" action="refund"><order_detail><order_detail_id>1</order_detail_id><refund_reason>no_stock</refund_reason></order_detail></order>',
      ),
    );
    expect(render('fnac_refund_order_lines', SAMPLES.fnac_refund_order_lines)).toContain(
      '<order order_id="07LWQ6278YJUI" action="partial_refund"><order_detail><order_detail_id>1</order_detail_id><refund_reason>damaged_article</refund_reason>' +
        '<refund_amount_product>1.12</refund_amount_product><refund_amount_shipping>0.7</refund_amount_shipping></order_detail>',
    );
  });

  it('marks reads read-only and installs deletion, refusal and refunds switched off', () => {
    for (const t of a.tools) {
      const annotations = deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
      expect(`${t.name}: ${annotations.readOnlyHint}`).toBe(`${t.name}: ${READS.includes(t.name)}`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(SWITCHED_OFF);
    for (const name of SWITCHED_OFF) {
      expect(tool(name).description).toMatch(/installed switched off/);
      expect(tool(name).annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
    // Every other tool installs enabled.
    for (const t of a.tools.filter((entry) => !SWITCHED_OFF.includes(entry.name))) expect(t.enabled).toBeUndefined();
  });

  it('reads an error in the answer of every service: refused token, hourly limit, anything else', () => {
    const rules = a.connector.config.errorWhen;
    const roots = [...new Set(Object.values(SERVICES).map(([, root]) => `${root}_response`))];
    expect(roots).toHaveLength(17);
    for (const root of roots) {
      const own = rules.filter((rule) => rule.path.startsWith(`${root}.`));
      expect(`${root}: ${own.map((rule) => rule.status).join(',')}`).toBe(`${root}: 401,429,400,400`);
      expect(own[0]).toMatchObject({ path: `${root}.error.code`, in: ['ERR_097', 'ERR_098', 'ERR_102'] });
      expect(own[1]).toMatchObject({ path: `${root}.error.code`, equals: 'ERR_107' });
      expect(own[3].path).toBe(`${root}.error[0].code`);
    }
    expect(rules).toHaveLength(roots.length * 4);
  });

  it('probes with a read, names every tool in the instructions and keeps the text clean', () => {
    expect(a.probe).toEqual({ tool: 'fnac_list_carriers', params: {} });
    expect(READS).toContain(a.probe.tool);
    expect(Object.keys(a.verifyHints).sort()).toEqual(['400', '401', '404', 'rate_limited']);
    expect(a.setupGuide.effort).toBe('api_key');
    expect(a.setupGuide.steps).toHaveLength(2);
    expect(a.setupGuide.steps[1].fields).toEqual(a.requiredEnvVars);
    expect(a.instructions.startsWith('## Fnac Darty Marketplace\n')).toBe(true);
    for (const heading of ['**Setup**', '**Where to start**', '**Order workflow**', '**Offers are updated in batches**', '**Limits and formats**']) {
      expect(a.instructions).toContain(heading);
    }
    for (const t of a.tools) expect(`${t.name}: ${a.instructions.includes(`\`${t.name}\``)}`).toBe(`${t.name}: true`);
    // The website renders descriptions and instructions as MDX.
    const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, a.description, ...a.tools.map((t) => t.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

describe('fnac adapter: requests through the engine (axios mocked)', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('logs in with the XML document, reads the token from the XML answer and sends it in the body, never in a header', async () => {
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: carriers, headers: XML });
    const out = await call('fnac_list_carriers', {}, realLogin());

    const login = sentAt(0);
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe(`${BASE}/auth`);
    expect(login.data).toBe(
      `<?xml version="1.0" encoding="utf-8"?><auth xmlns="${NS}"><partner_id>${ENV.FNAC_PARTNER_ID}</partner_id>` +
        `<shop_id>${ENV.FNAC_SHOP_ID}</shop_id><key>0D00AF3D-xxxx-k&amp;y</key></auth>`,
    );
    expect(XMLValidator.validate(login.data)).toBe(true);
    expect(login.headers['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(login.headers.Authorization).toBeUndefined();

    const request = sentAt(1);
    expect(String(request.method).toUpperCase()).toBe('POST');
    expect(request.url).toBe(`${BASE}/carriers_query`);
    expect(request.data).toBe(body('fnac_list_carriers', '<query>all</query>'));
    expect(Object.keys(request.headers).map((h) => h.toLowerCase())).toEqual(['content-type']);
    expect(request.headers['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(request.params).toBeUndefined();
    // The key never leaves the login.
    expect(String(request.data)).not.toContain('k&amp;y');

    // The XML answer reaches the model as an object.
    expect(out).toMatchObject({
      carriers_query_response: {
        status: 'OK',
        carrier: [
          { code: 'CHRONOPOST', global: '1', name: 'Chronopost' },
          { code: 'UPS', global: '1', name: 'UPS' },
        ],
      },
    });
  });

  it('reuses the token for the next call instead of logging in again', async () => {
    const login = realLogin();
    mockedAxios
      .mockResolvedValueOnce(authAnswer(TOKEN))
      .mockResolvedValueOnce({ status: 200, data: carriers, headers: XML })
      .mockResolvedValueOnce({ status: 200, data: carriers, headers: XML });
    await call('fnac_list_carriers', {}, login);
    await call('fnac_list_carriers', {}, login);
    expect(mockedAxios.mock.calls.map(([request]) => request.url)).toEqual([`${BASE}/auth`, `${BASE}/carriers_query`, `${BASE}/carriers_query`]);
  });

  for (const [code, text] of [
    ['ERR_098', 'Authentication Failure: token session time is expired, please authenticate.'],
    ['ERR_102', 'Partner is not authenticated. Please authenticate with auth service.'],
  ]) {
    for (const status of [200, 400]) {
      it(`logs in again and repeats the call when Fnac answers ${code} with HTTP ${status}`, async () => {
        const login = realLogin();
        const NEW_TOKEN = '9E778BC4-492B-99FD-5091-EF2F837A8D97';
        const answer = { status, data: refused('orders_query_response', code, text), headers: XML };
        mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN));
        if (status === 200) mockedAxios.mockResolvedValueOnce(answer);
        else {
          const { AxiosError } = jest.requireActual('axios');
          mockedAxios.mockRejectedValueOnce(new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, answer));
        }
        mockedAxios
          .mockResolvedValueOnce(authAnswer(NEW_TOKEN))
          .mockResolvedValueOnce({ status: 200, data: `<orders_query_response xmlns="${NS}" status="OK"><page>1</page><total_paging>0</total_paging></orders_query_response>`, headers: XML });

        const out = await call('fnac_query_orders', { states: ['Created'] }, login);

        expect(mockedAxios.mock.calls.map(([request]) => request.url)).toEqual([
          `${BASE}/auth`,
          `${BASE}/orders_query`,
          `${BASE}/auth`,
          `${BASE}/orders_query`,
        ]);
        const inner = '<paging>1</paging><states><state>Created</state></states>';
        expect(sentAt(1).data).toBe(body('fnac_query_orders', inner, ' results_count="50"'));
        expect(sentAt(3).data).toBe(body('fnac_query_orders', inner, ' results_count="50"').replace(TOKEN, NEW_TOKEN));
        expect(sentAt(3).headers.Authorization).toBeUndefined();
        expect(out).toMatchObject({ orders_query_response: { status: 'OK', page: '1' } });
      });
    }
  }

  it('reports another error in a 200 answer as a failed call, with its code, and does not log in again', async () => {
    mockedAxios
      .mockResolvedValueOnce(authAnswer(TOKEN))
      .mockResolvedValueOnce({ status: 200, data: refused('batch_status_response', 'ERR_023', 'Batch not found'), headers: XML });
    const failure = await call('fnac_get_batch_status', SAMPLES.fnac_get_batch_status, realLogin()).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ResponseBodyError);
    expect((failure as ResponseBodyError).status).toBe(400);
    expect((failure as ResponseBodyError).message).toContain('ERR_023 Batch not found');
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('reports the hourly limit as a rate limit and a per-offer error as data', async () => {
    mockedAxios
      .mockResolvedValueOnce(authAnswer(TOKEN))
      .mockResolvedValueOnce({ status: 200, data: refused('offers_query_response', 'ERR_107', 'You reached the maximum API calls available in one hour.'), headers: XML })
      .mockResolvedValueOnce({
        status: 200,
        data:
          `<batch_status_response xmlns="${NS}" status="ERROR"><batch_id>73169053-DD44-82E4-D3E7-E298D1F27B13</batch_id>` +
          '<offer status="ERROR"><offer_seller_id>SKU-1</offer_seller_id><error severity="ERROR" code="ERR_017">This price is negative or inferior to 0.90 euro(s).</error></offer>' +
          '</batch_status_response>',
        headers: XML,
      });
    const login = realLogin();
    const limited = await call('fnac_query_offers', {}, login).then(
      () => undefined,
      (error) => error,
    );
    expect(limited).toBeInstanceOf(ResponseBodyError);
    expect((limited as ResponseBodyError).status).toBe(429);
    // A batch that finished with errors is a report to read, not a failed call.
    const report = await call('fnac_get_batch_status', SAMPLES.fnac_get_batch_status, login);
    expect(report).toMatchObject({
      batch_status_response: { status: 'ERROR', offer: { status: 'ERROR', offer_seller_id: 'SKU-1', error: { code: 'ERR_017' } } },
    });
  });
});

// Opt-in: RUN_FNAC_LIVE=1. The refusal check needs no account and goes to
// Fnac's test platform; the reads need the three production values. Nothing
// is written.
const live = process.env.RUN_FNAC_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('fnac: live', () => {
  it('the test platform refuses a wrong key with the XML error ERR_097', async () => {
    const wrong = '00000000-0000-0000-0000-000000000000';
    const response = await liveFetch.post(
      'https://partners-test.mp.fnacdarty.com/api.php/auth',
      `<?xml version="1.0" encoding="utf-8"?><auth xmlns="${NS}"><partner_id>${wrong}</partner_id><shop_id>${wrong}</shop_id><key>${wrong}</key></auth>`,
      { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, validateStatus: () => true, responseType: 'text' },
    );
    expect(response.status).toBe(400);
    expect(String(response.headers['content-type'])).toMatch(/xml/);
    expect(String(response.data)).toMatch(/<auth_response status="ERROR"[^>]*>\s*<error severity="ERROR" code="ERR_097">/);
  }, 60_000);

  it('signs in through LoginTokenService and reads the carriers and the countries', async () => {
    const env = { FNAC_PARTNER_ID: process.env.FNAC_PARTNER_ID, FNAC_SHOP_ID: process.env.FNAC_SHOP_ID, FNAC_KEY: process.env.FNAC_KEY };
    if (!env.FNAC_PARTNER_ID || !env.FNAC_SHOP_ID || !env.FNAC_KEY) {
      throw new Error('Set FNAC_PARTNER_ID, FNAC_SHOP_ID and FNAC_KEY for the live check');
    }
    mockedAxios.mockImplementation((cfg: unknown) => (liveFetch as unknown as (c: unknown) => Promise<unknown>)(cfg));
    const login = realLogin();
    const engine = new RestEngine({} as OAuth2TokenService, login);
    const read = (name: string) => {
      const { config: cfg, endpointMapping } = interpolateConnectorConfig(
        { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
        tool(name).endpointMapping as never,
        env as Record<string, string>,
      );
      return engine.execute(
        {
          baseUrl: cfg.baseUrl,
          authType: a.connector.authType,
          authConfig: interpolateDeep(a.connector.authConfig, env as Record<string, string>),
          headers: cfg.headers,
          errorWhen: a.connector.config.errorWhen,
          connectorId: 'conn-fnac-live',
        } as never,
        endpointMapping,
        applySchemaDefaults(tool(name).parameters as never, {}),
      ) as Promise<Record<string, any>>;
    };
    const carrierList = await read('fnac_list_carriers');
    expect(carrierList.carriers_query_response.status).toBe('OK');
    expect([carrierList.carriers_query_response.carrier].flat()[0].code).toMatch(/^[A-Z_]+$/);
    const countries = await read('fnac_list_countries');
    expect([countries.countries_query_response.country].flat().some((c: { code: string }) => c.code === 'FRA')).toBe(true);
  }, 120_000);
});
