import * as adapter from './spartoo-shop.json';
import { describeAdapterEnvVars, setupKind } from '../env-var-meta';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';
import { localMcpToolName, mcpFixedArgumentsOf } from '../../connectors/mcp-connector-config.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { McpClientEngine } from '../../connectors/engines/mcp-client.engine';

/**
 * Spartoo Shop bridges Spartoo's official MCP server: three read-only tools
 * on the catalog, no credentials. Spartoo runs one server per country site,
 * so the site is the one thing to choose (SPARTOO_SHOP_SITE).
 *
 *   1. Static: always runs. Pins the bridge, the site choices, the three
 *      tools and their arguments.
 *
 *   2. Live: skipped unless RUN_SPARTOO_SHOP_LIVE=1. Lists the tools of the
 *      French site and runs one product search through the real engine.
 *
 *        RUN_SPARTOO_SHOP_LIVE=1 npx jest src/adapters/intl/spartoo-shop.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { type: string; required?: string[]; additionalProperties?: boolean; properties: Record<string, { description?: string; enum?: string[]; maximum?: number; default?: unknown }> };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  name: string;
  slug: string;
  category: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret: boolean; pattern: string; example: string; options: Array<{ value: string; label: string }> }>;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: unknown; config: { mcpToolPrefix: string } };
  tools: Tool[];
};
const tool = (method: string) => {
  const t = a.tools.find((x) => x.endpointMapping.method === method);
  if (!t) throw new Error(`missing tool ${method}`);
  return t;
};

// The country sites whose /mcp answered `initialize` on 2026-11-14.
const SITES = ['com', 'co.uk', 'de', 'it', 'es', 'pt', 'be', 'nl', 'pl', 'gr', 'se', 'dk', 'fi', 'sk', 'hu', 'ro', 'si', 'com.hr', 'net'];

describe('spartoo-shop adapter: static spec conformance', () => {
  it("bridges the chosen country site's MCP server without credentials", () => {
    expect(a.name).toBe('Spartoo Shop');
    expect(a.category).toBe('e-commerce');
    expect(a.docsUrl).toBe('https://www.spartoo.com/mcp.php');
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('{{SPARTOO_SHOP_SITE}}/mcp');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector).not.toHaveProperty('authConfig');
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'spartoo_shop_' });
    expect(mcpFixedArgumentsOf(a.connector.config)).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['SPARTOO_SHOP_SITE']);
    expect(setupKind(a as never)).toBe('credentials');
    expect(interpolateDeep(a.connector.baseUrl, { SPARTOO_SHOP_SITE: 'https://www.spartoo.co.uk' })).toBe(
      'https://www.spartoo.co.uk/mcp',
    );
  });

  it('offers the country sites as a fixed list of https addresses the pattern accepts, and nothing else', () => {
    const site = a.envVarMeta.SPARTOO_SHOP_SITE;
    expect(site.kind).toBe('address');
    expect(site.secret).toBe(false);
    expect(site.options.map((o) => o.value)).toEqual(SITES.map((tld) => `https://www.spartoo.${tld}`));
    expect(site.options.length).toBeGreaterThanOrEqual(2);
    expect(site.options.length).toBeLessThanOrEqual(20);
    expect(new Set(site.options.map((o) => o.value)).size).toBe(site.options.length);
    const pattern = new RegExp(site.pattern);
    for (const o of site.options) {
      expect(`${o.value}: ${pattern.test(o.value)}`).toBe(`${o.value}: true`);
      expect(o.label).toContain(o.value.replace('https://', ''));
      expect(o.label).toMatch(/\((EUR|GBP|PLN|SEK|DKK|HUF|RON|USD)\)$/);
    }
    expect(pattern.test(site.example)).toBe(true);
    // Sites that redirect instead of answering, another host, a path, plain http.
    for (const bad of [
      'https://www.spartoo.fr',
      'https://www.spartoo.ch',
      'https://www.spartoo.com/mcp',
      'https://www.spartoo.com/',
      'http://www.spartoo.com',
      'https://www.spartoo.com.evil.example',
      'https://spartoo.com',
    ]) {
      expect(`${bad}: ${pattern.test(bad)}`).toBe(`${bad}: false`);
    }
    const described = describeAdapterEnvVars(a as never).find((d) => d.name === 'SPARTOO_SHOP_SITE')!;
    expect(described).toMatchObject({ required: true, kind: 'address', secret: false });
  });

  it('has the three read-only tools, prefixed and called by their remote names', () => {
    expect(a.tools.map((t) => t.endpointMapping.method)).toEqual(['list_filters', 'search_products', 'get_product']);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.enabled).not.toBe(false);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.parameters).not.toHaveProperty('$schema');
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
      for (const [p, def] of Object.entries(t.parameters.properties)) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
  });

  it('searches by a required query with gender, brand, colour, size, price, sort and paging', () => {
    const search = tool('search_products').parameters;
    expect(search.required).toEqual(['query']);
    expect(Object.keys(search.properties)).toEqual([
      'query', 'gender', 'brand', 'color', 'size', 'price_min', 'price_max', 'sort', 'page', 'page_size',
    ]);
    expect(search.properties.gender.enum).toEqual(['men', 'women', 'kids', 'girls', 'boys']);
    expect(search.properties.sort.enum).toEqual(['relevance', 'price_asc', 'price_desc', 'newest', 'discount']);
    expect(search.properties.page_size).toMatchObject({ maximum: 50, default: 20 });
    const filters = tool('list_filters').parameters;
    expect(filters.required).toEqual(['query']);
    expect(Object.keys(filters.properties)).toEqual(['query', 'gender', 'brand', 'color', 'size', 'price_min', 'price_max']);
    expect(Object.keys(tool('get_product').parameters.properties)).toEqual(['product_id', 'product_ids']);
  });

  it('keeps the tools as they are when discovered from the server', () => {
    const discovered = a.tools.map((t) => ({
      name: t.endpointMapping.method,
      description: `server ${t.endpointMapping.method}`,
      parameters: t.parameters,
      endpointMapping: t.endpointMapping,
    }));
    const merged = mergeDiscoveredMcpTools(a.tools as never, discovered as never, a.connector.config.mcpToolPrefix);
    expect(merged.map((t) => t.name)).toEqual(['spartoo_shop_list_filters', 'spartoo_shop_search_products', 'spartoo_shop_get_product']);
    expect(merged.every((t) => t.enabled === undefined)).toBe(true);
    expect(merged[1].parameters).toBe(tool('search_products').parameters);
  });

  it('explains the site choice, the language and currency of a site, and what Spartoo logs', () => {
    expect(a.instructions).toMatch(/^## Spartoo Shop\n/);
    expect(a.instructions).toMatch(/one server per site/);
    expect(a.instructions).toMatch(/No account, API key or sign-in/);
    expect(a.instructions).toMatch(/in the site's language/);
    expect(a.instructions).toMatch(/not in cents/);
    expect(a.instructions).toMatch(/logs each call/);
    expect(a.instructions).toMatch(/cannot order/);
    for (const t of a.tools) expect(a.instructions).toContain(`\`${t.name}\``);
  });

  it('keeps braces and angle brackets out of the texts the website renders, and uses no em or en dashes', () => {
    const outsideBackticks = (s: string) => s.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((t) => t.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_SPARTOO_SHOP_LIVE === '1' ? describe : describe.skip;

live('spartoo-shop adapter: live server of the French site, read-only', () => {
  jest.setTimeout(90_000);
  const engine = new McpClientEngine({} as never);
  const baseUrl = interpolateDeep(a.connector.baseUrl, { SPARTOO_SHOP_SITE: 'https://www.spartoo.com' });

  it('lists exactly the tools in the catalog snapshot, with the same arguments', async () => {
    const tools = await engine.listTools({ baseUrl, authType: 'NONE' });
    expect(tools.map((t) => t.name)).toEqual(a.tools.map((t) => t.endpointMapping.method));
    for (const t of tools) {
      expect(t.inputSchema).toEqual(tool(t.name).parameters);
      expect(t.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it('searches products: EUR prices and a link to the product page', async () => {
    const result = (await engine.execute(
      { baseUrl, authType: 'NONE' },
      { method: 'search_products', path: '/mcp' },
      { query: 'baskets blanches femme', page_size: 2 },
    )) as { isError?: boolean; structuredContent?: any; content: Array<{ type: string; text?: string }> };
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent ?? JSON.parse(result.content.map((c) => c.text ?? '').join(''));
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products.length).toBeLessThanOrEqual(2);
    expect(body.products[0].currency).toBe('EUR');
    expect(typeof body.products[0].price).toBe('number');
    expect(body.products[0].url).toMatch(/^https:\/\/www\.spartoo\.com\//);
  });
});
