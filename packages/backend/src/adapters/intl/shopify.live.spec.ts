import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Kind, OperationDefinitionNode, parse } from 'graphql';
import * as adapterJson from './shopify.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Static checks always run, plus an end-to-end run of the client credentials
 * exchange and one query through the real LoginTokenService and GraphqlEngine
 * against a local server. The live block runs only with a Dev Dashboard app
 * installed on a store, and calls read-only tools:
 *   SHOPIFY_STORE=acme-shop SHOPIFY_CLIENT_ID=xxx SHOPIFY_CLIENT_SECRET=yyy \
 *     npx jest src/adapters/intl/shopify.live.spec.ts
 */

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapterJson as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const operation = (t: Tool) =>
  parse(t.endpointMapping.path).definitions.find(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  )!;
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;

describe('shopify adapter: static spec conformance', () => {
  it('is unlisted until verified against a real store', () => {
    expect(a.unlisted).toBe(true);
  });

  it('calls the GraphQL Admin API of the store, version 2026-10', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://{{SHOPIFY_STORE}}.myshopify.com/admin/api/2026-10/graphql.json');
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.requiredEnvVars).toEqual(['SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']);
  });

  it('gets its token with the client credentials grant and sends it as X-Shopify-Access-Token', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(auth.loginUrl).toBe('https://{{SHOPIFY_STORE}}.myshopify.com/admin/oauth/access_token');
    expect(auth.loginHeaders['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(auth.loginBody).toEqual({ grant_type: 'client_credentials', client_id: '${username}', client_secret: '${password}' });
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('expires_in');
    expect(auth.expiryFormat).toBe('ttl_seconds');
    expect(auth.headerName).toBe('X-Shopify-Access-Token');
    expect(auth.headerTemplate).toBe('${token}');
  });

  it('probes with the shop query, which needs no scope and no argument', () => {
    expect(a.probe.tool).toBe('shopify_get_shop');
    expect(operation(tool('shopify_get_shop')).variableDefinitions ?? []).toHaveLength(0);
  });

  it('every operation parses, and parameters and variables match one to one', () => {
    for (const t of a.tools) {
      const op = operation(t);
      expect(`${t.name}:${op.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      const mapped = Object.keys(t.endpointMapping.queryParams ?? {}).sort();
      expect(`${t.name}:${mapped.join(',')}`).toBe(`${t.name}:${declared.join(',')}`);
      const used = Object.values(t.endpointMapping.queryParams ?? {}).map((v) => v.slice(1)).sort();
      const params = Object.keys(t.parameters.properties ?? {}).sort();
      expect(`${t.name}:${used.join(',')}`).toBe(`${t.name}:${params.join(',')}`);
      for (const r of t.parameters.required ?? []) expect(params).toContain(r);
    }
  });

  it('has exactly three writes and nothing that deletes', () => {
    const mutations = a.tools.filter((t) => t.endpointMapping.method === 'mutation').map((t) => t.name).sort();
    expect(mutations).toEqual(['shopify_adjust_inventory', 'shopify_create_fulfillment', 'shopify_update_variant_price']);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/Delete|Remove|Cancel/);
  });

  it('every mutation selects userErrors', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'mutation')) {
      expect(t.endpointMapping.path).toMatch(/userErrors \{ field message/);
    }
  });

  it('inventory adjustments carry the idempotency key 2026-04+ requires', () => {
    const t = tool('shopify_adjust_inventory');
    expect(t.endpointMapping.path).toContain('@idempotent(key: $idempotencyKey)');
    expect(t.parameters.required).toContain('idempotency_key');
  });

  it('list tools page with first/after and return pageInfo', () => {
    for (const name of ['shopify_search_products', 'shopify_search_orders', 'shopify_search_customers', 'shopify_list_locations', 'shopify_list_inventory_levels']) {
      const t = tool(name);
      expect(Object.keys(t.parameters.properties ?? {})).toEqual(expect.arrayContaining(['first', 'after']));
      expect(t.endpointMapping.path).toContain('pageInfo { hasNextPage endCursor }');
    }
  });
});

describe('shopify adapter: token exchange and query through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/admin/oauth/access_token') {
          res.end(JSON.stringify({ access_token: 'shpat_test', scope: 'read_products', expires_in: 86399 }));
        } else {
          res.end(JSON.stringify({ data: { shop: { name: 'Acme' } }, extensions: { cost: { requestedQueryCost: 1 } } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('posts client_id and client_secret form-encoded, then queries with X-Shopify-Access-Token only', async () => {
    const auth = interpolateDeep(a.connector.authConfig, {
      SHOPIFY_STORE: 'acme-shop',
      SHOPIFY_CLIENT_ID: 'cid',
      SHOPIFY_CLIENT_SECRET: 'csecret',
    });
    expect(auth.loginUrl).toBe('https://acme-shop.myshopify.com/admin/oauth/access_token');
    auth.loginUrl = `${origin}/admin/oauth/access_token`;

    const engine = new GraphqlEngine(
      {} as OAuth2TokenService,
      new LoginTokenService({} as any, config),
      {} as GraphqlSchemaService,
    );
    const result = await engine.execute(
      { baseUrl: `${origin}/admin/api/2026-10/graphql.json`, authType: 'LOGIN_TOKEN', authConfig: auth, headers: a.connector.headers },
      tool('shopify_get_shop').endpointMapping,
      {},
    );
    expect(result).toEqual({ shop: { name: 'Acme' } });

    const [login, query] = seen;
    expect(login.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(login.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'csecret',
    });
    expect(query.url).toBe('/admin/api/2026-10/graphql.json');
    expect(query.headers['x-shopify-access-token']).toBe('shpat_test');
    expect(query.headers.authorization).toBeUndefined();
    expect(query.headers['user-agent']).toBe('AnythingMCP');
  });
});

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const live = STORE && CLIENT_ID && CLIENT_SECRET ? describe : describe.skip;

live('shopify adapter: live read-only calls', () => {
  const vars = { SHOPIFY_STORE: STORE!, SHOPIFY_CLIENT_ID: CLIENT_ID!, SHOPIFY_CLIENT_SECRET: CLIENT_SECRET! };
  const engine = new GraphqlEngine(
    {} as OAuth2TokenService,
    new LoginTokenService({} as any, config),
    {} as GraphqlSchemaService,
  );
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: interpolateDeep(a.connector.baseUrl, vars),
        authType: 'LOGIN_TOKEN',
        authConfig: interpolateDeep(a.connector.authConfig, vars),
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  let productId: string | undefined;
  let variantId: string | undefined;

  it('reads the shop', async () => {
    const res = await run('shopify_get_shop');
    expect(res.shop.myshopifyDomain).toBe(`${STORE}.myshopify.com`);
  }, 30000);

  it('searches products and reads one with its variants', async () => {
    const res = await run('shopify_search_products', { first: 2 });
    expect(Array.isArray(res.products.nodes)).toBe(true);
    productId = res.products.nodes[0]?.id;
    if (!productId) return;
    const p = await run('shopify_get_product', { product_id: productId, variants_first: 5 });
    expect(p.product.id).toBe(productId);
    variantId = p.product.variants.nodes[0]?.id;
  }, 30000);

  it('lists locations and the inventory levels of a variant', async () => {
    const loc = await run('shopify_list_locations', { first: 5 });
    expect(Array.isArray(loc.locations.nodes)).toBe(true);
    if (!variantId) return;
    const inv = await run('shopify_list_inventory_levels', { variant_id: variantId });
    expect(inv.productVariant.id).toBe(variantId);
  }, 30000);

  it('searches orders and reads one', async () => {
    const res = await run('shopify_search_orders', { first: 2, sort_key: 'CREATED_AT', reverse: true });
    expect(Array.isArray(res.orders.nodes)).toBe(true);
    const orderId = res.orders.nodes[0]?.id;
    if (!orderId) return;
    const o = await run('shopify_get_order', { order_id: orderId });
    expect(o.order.id).toBe(orderId);
  }, 30000);

  it('searches customers and reads one', async () => {
    const res = await run('shopify_search_customers', { first: 2 });
    expect(Array.isArray(res.customers.nodes)).toBe(true);
    const customerId = res.customers.nodes[0]?.id;
    if (!customerId) return;
    const c = await run('shopify_get_customer', { customer_id: customerId });
    expect(c.customer.id).toBe(customerId);
  }, 30000);
});
