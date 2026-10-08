import * as adapter from './printful.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static checks always run. The live block runs only with a real private
 * token and calls read-only tools (scopes, stores, catalog, v2 prices,
 * shipping rates, cost estimate, order list) through the real RestEngine.
 * PRINTFUL_STORE_ID is needed only for an account-level token:
 *   PRINTFUL_API_TOKEN=xxx [PRINTFUL_STORE_ID=123] npx jest src/adapters/intl/printful.live.spec.ts
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
  headers?: Record<string, string>;
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

describe('printful adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the private token as a Bearer token with a User-Agent', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{PRINTFUL_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['PRINTFUL_API_TOKEN']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('probes with the token scopes, which work for store- and account-level tokens', () => {
    expect(a.connector.baseUrl).toBe('https://api.printful.com');
    expect(a.connector.healthcheckPath).toBe('/oauth/scopes');
    expect(a.probe.tool).toBe('printful_get_token_scopes');
    expect(tool('printful_get_token_scopes').endpointMapping).toEqual({ method: 'GET', path: '/oauth/scopes' });
  });

  it('uses API v1 paths, and v2 only for catalog prices', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      expect(p.startsWith('/')).toBe(true);
      if (p.startsWith('/v2/')) expect(t.name).toBe('printful_get_product_prices');
    }
  });

  it('has no DELETE tool and nothing that cancels', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(t.endpointMapping.path).not.toMatch(/cancel/i);
    }
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      refs(m.headers, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('store-scoped tools send store_id as X-PF-Store-Id', () => {
    for (const t of a.tools) {
      if ('store_id' in (t.parameters?.properties ?? {})) expect(t.endpointMapping.headers).toEqual({ 'X-PF-Store-Id': '$store_id' });
      expect(t.parameters?.required ?? []).not.toContain('store_id');
    }
  });

  it('the draft order never sends confirm, and confirming installs switched off', () => {
    const draft = tool('printful_create_draft_order').endpointMapping;
    expect(draft).toMatchObject({ method: 'POST', path: '/orders' });
    expect(draft.queryParams).toBeUndefined();
    expect(JSON.stringify(draft)).not.toContain('confirm');
    expect(tool('printful_create_draft_order').enabled).toBeUndefined();
    expect(tool('printful_confirm_order').enabled).toBe(false);
    expect(tool('printful_confirm_order').annotations?.destructiveHint).toBe(true);
    expect(tool('printful_confirm_order').endpointMapping.path).toBe('/orders/{order_id}/confirm');
  });

  it('estimate and draft take the same order body', () => {
    expect(tool('printful_estimate_order_costs').endpointMapping.bodyMapping).toEqual(
      tool('printful_create_draft_order').endpointMapping.bodyMapping,
    );
  });

  it('POST quotes are marked read-only', () => {
    for (const n of ['printful_calculate_shipping_rates', 'printful_estimate_order_costs']) {
      expect(tool(n).endpointMapping.method).toBe('POST');
      expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    }
  });
});

const TOKEN = process.env.PRINTFUL_API_TOKEN;
const STORE_ID = process.env.PRINTFUL_STORE_ID;
const live = TOKEN ? describe : describe.skip;

live('printful adapter: live read-only calls', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const store = STORE_ID ? { store_id: STORE_ID } : {};
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  let productId: number;
  let variantId: number;

  it('reads the token scopes and the stores', async () => {
    const scopes = await run('printful_get_token_scopes');
    expect(scopes.code).toBe(200);
    const stores = await run('printful_list_stores').catch((e) => e);
    if (!(stores instanceof Error)) expect(Array.isArray(stores.result)).toBe(true);
  }, 30000);

  it('browses the catalog', async () => {
    const cats = await run('printful_list_categories');
    expect(Array.isArray(cats.result) || Array.isArray(cats.result?.categories)).toBe(true);
    const products = await run('printful_list_catalog_products');
    productId = products.result[0].id;
    const p = await run('printful_get_catalog_product', { product_id: productId });
    expect(p.result.product.id).toBe(productId);
    variantId = p.result.variants[0].id;
    const v = await run('printful_get_catalog_variant', { variant_id: variantId });
    expect(v.result.variant.id).toBe(variantId);
  }, 30000);

  it('gets v2 prices and v1 shipping rates', async () => {
    const prices = await run('printful_get_product_prices', { product_id: productId, ...store });
    expect(prices).toBeTruthy();
    const rates = await run('printful_calculate_shipping_rates', {
      recipient: { country_code: 'US', state_code: 'CA', city: 'Los Angeles', zip: '90001', address1: '1 Main St' },
      items: [{ variant_id: String(variantId), quantity: 1 }],
      ...store,
    });
    expect(Array.isArray(rates.result)).toBe(true);
  }, 30000);

  it('lists orders', async () => {
    const res = await run('printful_list_orders', { limit: 1, ...store });
    expect(Array.isArray(res.result)).toBe(true);
  }, 30000);
});
