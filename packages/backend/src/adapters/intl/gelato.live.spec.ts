import * as adapter from './gelato.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static checks always run. The live block runs only with a real key and
 * calls read-only tools (catalogs, products, prices, shipment methods,
 * order search) through the real RestEngine:
 *   GELATO_API_KEY=xxx npx jest src/adapters/intl/gelato.live.spec.ts
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: Mapping;
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('gelato adapter: static spec conformance', () => {
  it('is listed: verified against a real account on 7 Oct 2026', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the key in X-API-KEY with a User-Agent', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{GELATO_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['GELATO_API_KEY']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('uses the product host as base and probes with the catalog list', () => {
    expect(a.connector.baseUrl).toBe('https://product.gelatoapis.com');
    expect(a.connector.healthcheckPath).toBe('/v3/catalogs');
    expect(a.probe.tool).toBe('gelato_list_catalogs');
    expect(tool('gelato_list_catalogs').endpointMapping).toEqual({ method: 'GET', path: '/v3/catalogs' });
  });

  it('reaches the order, shipment and ecommerce hosts with absolute URLs', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (p.startsWith('/')) expect(`${t.name}:${p}`).toMatch(/:\/v3\//);
      else expect(p).toMatch(/^https:\/\/(order|shipment|ecommerce)\.gelatoapis\.com\/v[14]\//);
    }
    expect(tool('gelato_get_order').endpointMapping.path).toBe('https://order.gelatoapis.com/v4/orders/{order_id}');
    expect(tool('gelato_list_shipment_methods').endpointMapping.path).toBe('https://shipment.gelatoapis.com/v1/shipment-methods');
  });

  it('has no DELETE tool', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('draft and real orders differ only by a fixed orderType', () => {
    const draft = tool('gelato_create_draft_order').endpointMapping;
    const real = tool('gelato_create_order').endpointMapping;
    expect(draft.bodyMapping?.orderType).toBe('draft');
    expect(real.bodyMapping?.orderType).toBe('order');
    expect(draft.path).toBe(real.path);
  });

  it('tools that charge or publish install switched off and are marked destructive', () => {
    for (const n of ['gelato_create_order', 'gelato_confirm_draft_order', 'gelato_create_product_from_template']) {
      expect(tool(n).enabled).toBe(false);
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
    expect(tool('gelato_cancel_order').endpointMapping).toEqual({ method: 'POST', path: 'https://order.gelatoapis.com/v4/orders/{order_id}:cancel' });
    expect(tool('gelato_cancel_order').annotations?.destructiveHint).toBe(true);
  });

  it('POST searches and quotes are marked read-only', () => {
    for (const n of ['gelato_search_products', 'gelato_check_stock', 'gelato_quote_order', 'gelato_search_orders']) {
      expect(tool(n).endpointMapping.method).toBe('POST');
      expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    }
  });
});

const KEY = process.env.GELATO_API_KEY;
const live = KEY ? describe : describe.skip;

live('gelato adapter: live read-only calls', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'API_KEY',
        authConfig: { headerName: 'X-API-KEY', apiKey: KEY as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  let catalogUid: string;
  let productUid: string;

  it('lists catalogs', async () => {
    const res = await run('gelato_list_catalogs');
    const list = Array.isArray(res) ? res : res.data;
    expect(Array.isArray(list)).toBe(true);
    catalogUid = list[0].catalogUid;
    expect(catalogUid).toBeTruthy();
  }, 30000);

  it('gets a catalog and searches its products', async () => {
    const cat = await run('gelato_get_catalog', { catalog_uid: catalogUid });
    expect(Array.isArray(cat.productAttributes)).toBe(true);
    const found = await run('gelato_search_products', { catalog_uid: catalogUid, limit: 2 });
    expect(Array.isArray(found.products)).toBe(true);
    productUid = found.products[0].productUid;
  }, 30000);

  it('gets a product and its prices', async () => {
    const p = await run('gelato_get_product', { product_uid: productUid });
    expect(p.productUid).toBe(productUid);
    const prices = await run('gelato_get_product_prices', { product_uid: productUid, country: 'US', currency: 'USD' });
    expect(Array.isArray(prices)).toBe(true);
  }, 30000);

  it('checks stock and lists shipment methods', async () => {
    const stock = await run('gelato_check_stock', { product_uids: [productUid] });
    expect(Array.isArray(stock.productsAvailability)).toBe(true);
    const methods = await run('gelato_list_shipment_methods', { country: 'US' });
    expect(Array.isArray(methods.shipmentMethods)).toBe(true);
  }, 30000);

  it('searches orders', async () => {
    const res = await run('gelato_search_orders', { limit: 1 });
    expect(Array.isArray(res.orders)).toBe(true);
  }, 30000);
});
