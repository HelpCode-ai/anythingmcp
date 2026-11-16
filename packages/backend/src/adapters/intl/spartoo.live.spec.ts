import axios from 'axios';
import * as adapter from './spartoo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Spartoo marketplace web services (seller side).
 *
 * Static checks always run: every tool's web service file and form fields
 * against Spartoo's documentation, the partner code as a form field (never a
 * header or the query), the XML answer read as JSON, the error codes turned
 * into failed calls, and which tools install switched off.
 * https://www.spartoo.eu/mp/documentation.php?page=webservices
 *
 * The English pages translate two field names the other languages keep in
 * French (`partner` for `partenaire`, `status` for `statut` on the order
 * export). `partner` is accepted by the live service (an unknown code answers
 * -2 under either name, a missing one -1); the order export's status filter
 * is sent under both names because only a real account can tell which one
 * the service reads.
 *
 * Live checks run only with RUN_SPARTOO_LIVE=1. Without a code they confirm
 * that an unknown partner code is refused with -2; with SPARTOO_PARTNER_KEY
 * (and optionally SPARTOO_HOST) they list the orders from tomorrow on, which
 * reads nothing and proves the code. Reads only.
 *
 *   RUN_SPARTOO_LIVE=1 SPARTOO_PARTNER_KEY=... npx jest src/adapters/intl/spartoo.live.spec.ts
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

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config: { errorWhen: unknown[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const ENV: Record<string, string> = {
  SPARTOO_HOST: 'https://sws.spartoo.eu',
  SPARTOO_PARTNER_KEY: '1EC51BF31B486658',
};

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: a.connector.authConfig,
      headers: cfg.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params) },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const form = () => Object.fromEntries(new URLSearchParams(String(sent().data)));
const xml = (body: string) =>
  mockedAxios.mockResolvedValueOnce({
    status: 200,
    data: `<?xml version="1.0" encoding="UTF-8"?>${body}`,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });

/** Web service file and form fields per tool, as Spartoo documents them. */
const CONTRACT: Record<string, { file: string; fields: string[]; required: string[]; read: boolean }> = {
  spartoo_list_orders: { file: 'xml_export_orders.php', fields: ['partner', 'date', 'status', 'statut'], required: ['since'], read: true },
  spartoo_get_order: { file: 'xml_export_orders.php', fields: ['partner', 'oID'], required: ['order_id'], read: true },
  spartoo_accept_order: { file: 'xml_maj_orders.php', fields: ['partner', 'oID', 'statut'], required: ['order_id'], read: false },
  spartoo_ship_order: {
    file: 'xml_maj_orders.php',
    fields: ['partner', 'oID', 'statut', 'tracking_number'],
    required: ['order_id', 'tracking_number'],
    read: false,
  },
  spartoo_cancel_order: { file: 'xml_maj_orders.php', fields: ['partner', 'oID', 'statut'], required: ['order_id'], read: false },
  spartoo_list_returns: { file: 'xml_export_returns.php', fields: ['partner', 'date', 'statut'], required: ['since'], read: true },
  spartoo_get_return: { file: 'xml_export_returns.php', fields: ['partner', 'rID', 'oID'], required: [], read: true },
  spartoo_check_product_status: {
    file: 'xml_check_status_products.php',
    fields: ['partner', 'xml'],
    required: ['product_reference'],
    read: true,
  },
  spartoo_update_stock: {
    file: 'xml_maj_stock.php',
    fields: ['partner', 'reference_partenaire', 'products_size_reference', 'products_quantity'],
    required: ['product_reference', 'size_reference', 'quantity'],
    read: false,
  },
};

describe('spartoo adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is a REST connector on the web service host of the seller, with the partner code as its only secret', () => {
    expect(a.slug).toBe('spartoo');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('spartoo');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{SPARTOO_HOST}}/mp');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual(['SPARTOO_HOST', 'SPARTOO_PARTNER_KEY']);
    expect(a.envVarMeta.SPARTOO_PARTNER_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.SPARTOO_HOST).toMatchObject({ kind: 'address' });
    const host = new RegExp(a.envVarMeta.SPARTOO_HOST.pattern!);
    for (const good of ['https://sws.spartoo.eu', 'https://sws.spartoo.com', 'https://sws.spartoo.co.uk', 'https://sws.spartoo.com.hr']) {
      expect(host.test(good)).toBe(true);
    }
    for (const bad of ['http://sws.spartoo.eu', 'https://sws.spartoo.eu/mp', 'https://www.spartoo.eu', 'https://sws.spartoo.eu.example.com', 'https://example.com']) {
      expect(host.test(bad)).toBe(false);
    }
    expect(new RegExp(a.envVarMeta.SPARTOO_PARTNER_KEY.pattern!).test(ENV.SPARTOO_PARTNER_KEY)).toBe(true);
    expect(new RegExp(a.envVarMeta.SPARTOO_PARTNER_KEY.pattern!).test('has space')).toBe(false);
    // The code never travels in a header or in the address.
    expect(JSON.stringify(a.connector.headers)).not.toContain('SPARTOO_PARTNER_KEY');
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toContain('SPARTOO_PARTNER_KEY');
  });

  it('probes with an order list that reads nothing and explains 401, 403, 404 and the hourly limit', () => {
    expect(a.probe).toEqual({ tool: 'spartoo_list_orders', params: { since: '__TOMORROW__:00:00:00' } });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to its documented web service file and form fields', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const entry of a.tools) {
      const want = CONTRACT[entry.name];
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.endpointMapping.path).toBe(`/${want.file}`);
      expect(entry.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(Object.keys(entry.endpointMapping.bodyMapping ?? {})).toEqual(want.fields);
      expect(entry.endpointMapping.bodyMapping!.partner).toBe('{{SPARTOO_PARTNER_KEY}}');
      expect([...(entry.parameters.required ?? [])].sort()).toEqual([...want.required].sort());
      const annotations = deriveToolAnnotations({
        name: entry.name,
        connectorType: 'REST',
        endpointMapping: entry.endpointMapping,
        annotations: entry.annotations,
      });
      expect(annotations.readOnlyHint).toBe(want.read);
    }
  });

  it('prefixes every tool, shares no name with another adapter, and describes every parameter', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^spartoo_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      expect(entry.description.length).toBeGreaterThan(60);
      for (const p of Object.values(entry.parameters.properties ?? {})) expect(p.description).toBeTruthy();
      for (const req of entry.parameters.required ?? []) expect(entry.parameters.properties).toHaveProperty(req);
    }
  });

  it('installs the cancellation switched off and has no product import, price, packing slip or return decision', () => {
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name)).toEqual(['spartoo_cancel_order']);
    expect(tool('spartoo_cancel_order').endpointMapping.bodyMapping!.statut).toBe('41');
    for (const entry of a.tools) {
      for (const file of ['xml_import_products', 'xml_maj_stock_batch', 'xml_export_bl', 'xml_maj_returns', 'xml_export_products']) {
        expect(entry.endpointMapping.path).not.toContain(file);
      }
    }
    // Only the two documented transitions a merchant makes are switched on.
    expect(tool('spartoo_accept_order').endpointMapping.bodyMapping!.statut).toBe('2');
    expect(tool('spartoo_ship_order').endpointMapping.bodyMapping!.statut).toBe('3');
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
  });

  it('sends the partner code and the order filter as form fields and reads the XML answer as JSON', async () => {
    xml('<root><orders><order><orders_id>90D813EA1A2365A8</orders_id><orders_status_id>11</orders_status_id></order></orders></root>');
    const result = await call('spartoo_list_orders', { since: '2026-11-01:00:00:00', status: 11 });
    const req = sent();
    expect(req.url).toBe('https://sws.spartoo.eu/mp/xml_export_orders.php');
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.params ?? {}).toEqual({});
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(form()).toEqual({ partner: '1EC51BF31B486658', date: '2026-11-01:00:00:00', status: '11', statut: '11' });
    expect(result).toMatchObject({
      root: { orders: { order: { orders_id: '90D813EA1A2365A8', orders_status_id: '11' } } },
    });

    xml('<root><orders></orders></root>');
    await call('spartoo_list_orders', { since: '2026-11-01:00:00:00' });
    expect(form()).toEqual({ partner: '1EC51BF31B486658', date: '2026-11-01:00:00:00' });
  });

  it('uses the web service host the seller entered', async () => {
    xml('<root><orders></orders></root>');
    await call('spartoo_get_order', { order_id: '90D813EA1A2365A8' }, { ...ENV, SPARTOO_HOST: 'https://sws.spartoo.it' });
    expect(sent().url).toBe('https://sws.spartoo.it/mp/xml_export_orders.php');
    expect(form()).toEqual({ partner: '1EC51BF31B486658', oID: '90D813EA1A2365A8' });
  });

  it('builds the order updates, the product check and the stock update as documented', async () => {
    xml('<root><errors>1</errors></root>');
    await call('spartoo_accept_order', { order_id: '90D813EA1A2365A8' });
    expect(sent().url).toBe('https://sws.spartoo.eu/mp/xml_maj_orders.php');
    expect(form()).toEqual({ partner: '1EC51BF31B486658', oID: '90D813EA1A2365A8', statut: '2' });

    xml('<root><errors>1</errors></root>');
    await call('spartoo_ship_order', { order_id: '90D813EA1A2365A8', tracking_number: '12563AF256' });
    expect(form()).toEqual({ partner: '1EC51BF31B486658', oID: '90D813EA1A2365A8', statut: '3', tracking_number: '12563AF256' });

    xml('<root><errors>1</errors><products><product><reference_partenaire>SKU_PARENT</reference_partenaire><status>OS</status></product></products></root>');
    await call('spartoo_check_product_status', { product_reference: 'SKU_PARENT' });
    expect(sent().url).toBe('https://sws.spartoo.eu/mp/xml_check_status_products.php');
    expect(form()).toEqual({
      partner: '1EC51BF31B486658',
      xml: '<root><products><product><reference_partenaire>SKU_PARENT</reference_partenaire></product></products></root>',
    });

    xml('<root><errors>1</errors></root>');
    await call('spartoo_update_stock', { product_reference: '98', size_reference: '98_38', quantity: 0 });
    expect(sent().url).toBe('https://sws.spartoo.eu/mp/xml_maj_stock.php');
    expect(form()).toEqual({
      partner: '1EC51BF31B486658',
      reference_partenaire: '98',
      products_size_reference: '98_38',
      products_quantity: '0',
    });

    xml('<root><returns></returns></root>');
    await call('spartoo_list_returns', { since: 1793491200, status: 2 });
    expect(sent().url).toBe('https://sws.spartoo.eu/mp/xml_export_returns.php');
    expect(form()).toEqual({ partner: '1EC51BF31B486658', date: '1793491200', statut: '2' });
  });

  it.each([
    ['-2', 401],
    ['-1', 401],
    ['-428', 403],
    ['-429', 429],
    ['-6', 404],
    ['-19', 400],
  ])('reports error code %s as a failed call with status %i', async (code, status) => {
    xml(`<root>\n    <errors>${code}</errors>\n</root>`);
    const failure = await call('spartoo_get_order', { order_id: '90D813EA1A2365A8' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ResponseBodyError);
    expect((failure as ResponseBodyError).status).toBe(status);
  });

  it('lets code 1 and a per-order code 1 through, and fails a per-order negative code', async () => {
    xml('<root><errors>1</errors></root>');
    await expect(call('spartoo_accept_order', { order_id: '90D813EA1A2365A8' })).resolves.toBeTruthy();

    xml('<root><orders><order><orders_id>A</orders_id><errors><error><id>1</id><description>ok</description></error></errors></order></orders></root>');
    await expect(call('spartoo_get_order', { order_id: '90D813EA1A2365A8' })).resolves.toBeTruthy();

    // The returns export reports its code as an object under root.errors: not a failure.
    xml('<root><returns><return><return_id>EEAJBCC</return_id></return></returns><errors><error><id>1</id></error></errors></root>');
    await expect(call('spartoo_get_return', { return_id: 'EEAJBCC' })).resolves.toMatchObject({
      root: { returns: { return: { return_id: 'EEAJBCC' } } },
    });

    xml('<root><orders><order><errors><error><id>-3</id><description>missing</description></error></errors></order></orders></root>');
    const failure = await call('spartoo_get_order', { order_id: '90D813EA1A2365A8' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ResponseBodyError);
    expect((failure as ResponseBodyError).message).toContain('-3');
  });
});

// Opt-in: RUN_SPARTOO_LIVE=1. The refusal check needs no account; the read
// needs SPARTOO_PARTNER_KEY. Nothing is written.
const live = process.env.RUN_SPARTOO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('spartoo: live', () => {
  const host = process.env.SPARTOO_HOST || 'https://sws.spartoo.eu';

  it('refuses an unknown partner code with -2 in an XML answer', async () => {
    const response = await liveFetch.post(
      `${host}/mp/xml_export_orders.php`,
      new URLSearchParams({ partner: 'NOTAPARTNERCODE0', oID: '0000000000000000' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true },
    );
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('xml');
    expect(String(response.data)).toMatch(/<errors>-2<\/errors>/);
  });

  it('lists the orders from tomorrow on with a real partner code', async () => {
    const key = process.env.SPARTOO_PARTNER_KEY;
    if (!key) return;
    mockedAxios.mockImplementation(liveFetch as never);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const result = await call('spartoo_list_orders', { since: `${tomorrow}:00:00:00` }, { SPARTOO_HOST: host, SPARTOO_PARTNER_KEY: key });
    expect(result).toHaveProperty('root');
  });
});
