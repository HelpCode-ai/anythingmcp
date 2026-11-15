import * as adapter from './decathlon-shop.json';
import { AdaptersService } from '../adapters.service';
import { setupKind } from '../env-var-meta';
import { catalogMcpToolsFor, mergeDiscoveredMcpTools } from '../mcp-adapter.util';
import {
  localMcpToolName,
  mcpFixedArgumentsOf,
  withMcpFixedArguments,
  withoutMcpFixedArguments,
} from '../../connectors/mcp-connector-config.util';
import { McpClientEngine } from '../../connectors/engines/mcp-client.engine';
import type { DiscoveredMcpTool } from '../../connectors/connectors.service';

// The install test below goes through the real importAdapter, which reads the
// adapter from the catalog: serve this file's JSON for the slug, whatever the
// generated catalog holds.
jest.mock('../catalog', () => {
  const actual = jest.requireActual('../catalog');
  return {
    ...actual,
    getAdapter: (slug: string) =>
      slug === 'decathlon-shop' ? jest.requireActual('./decathlon-shop.json') : actual.getAdapter(slug),
  };
});

/**
 * Decathlon US Shop bridges the shopping endpoint of Decathlon's US online
 * store (UCP over MCP, on Shopify). It is the first MCP adapter that needs no
 * credentials (authType NONE), and the first with `mcpFixedArguments`: the
 * server wants `meta.ucp-agent.profile` on every call.
 *
 *   1. Static: always runs. Pins the bridge, the 14 tools, the seven cart and
 *      checkout tools that install switched off, and that the profile URL is
 *      sent by the connector and never listed as a parameter. Installs the
 *      adapter through importAdapter with a mocked server listing.
 *
 *   2. Live: skipped unless RUN_DECATHLON_SHOP_LIVE=1. Read-only: lists the
 *      tools and runs one catalog search through the real McpClientEngine.
 *      The profile URL the adapter sends must resolve for the search to work
 *      (Decathlon fetches it); DECATHLON_SHOP_PROFILE_URL replaces it for a
 *      run before ours is published. No cart, checkout or order tool is called.
 *
 *        RUN_DECATHLON_SHOP_LIVE=1 npx jest src/adapters/intl/decathlon-shop.live.spec.ts
 */

type Schema = { type: string; required?: string[]; properties: Record<string, { description?: string; properties?: Record<string, unknown>; required?: string[] }> };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: Schema;
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  category: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta?: unknown;
  connector: {
    name: string;
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: unknown;
    headers?: unknown;
    config: { mcpToolPrefix: string; mcpFixedArguments: Record<string, unknown> };
  };
  tools: Tool[];
};
const tool = (method: string) => {
  const t = a.tools.find((x) => x.endpointMapping.method === method);
  if (!t) throw new Error(`missing tool ${method}`);
  return t;
};

const MCP_URL = 'https://www.decathlon.com/api/ucp/mcp';
const PROFILE_URL = 'https://anythingmcp.com/.well-known/ucp-agent.json';
const FIXED = { meta: { 'ucp-agent': { profile: PROFILE_URL } } };
const ALL = [
  'ask_business',
  'cancel_cart',
  'cancel_checkout',
  'complete_checkout',
  'create_cart',
  'create_checkout',
  'get_cart',
  'get_checkout',
  'get_order',
  'get_product',
  'lookup_catalog',
  'search_catalog',
  'update_cart',
  'update_checkout',
];
const OFF = [
  'cancel_cart',
  'cancel_checkout',
  'complete_checkout',
  'create_cart',
  'create_checkout',
  'update_cart',
  'update_checkout',
];

/** `meta` as the server lists it on every tool. */
const serverMeta = (withIdempotencyKey: boolean) => ({
  type: 'object',
  description: 'Metadata for UCP agent profile discovery.',
  properties: {
    'ucp-agent': {
      type: 'object',
      properties: { profile: { type: 'string', format: 'uri', description: 'Agent profile URI for UCP discovery.' } },
      required: ['profile'],
    },
    ...(withIdempotencyKey ? { 'idempotency-key': { type: 'string', description: 'An idempotency key for completing the checkout.' } } : {}),
  },
  required: ['ucp-agent', ...(withIdempotencyKey ? ['idempotency-key'] : [])],
});

/** The snapshot as the server would list it: remote names, `meta` on every tool. */
const asServerLists = (): DiscoveredMcpTool[] =>
  a.tools.map((t) => {
    const { meta: _kept, ...rest } = t.parameters.properties;
    const key = t.endpointMapping.method === 'complete_checkout';
    return {
      name: t.endpointMapping.method,
      description: `server ${t.endpointMapping.method}`,
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { meta: serverMeta(key), ...rest },
        required: ['meta', ...(t.parameters.required ?? []).filter((r) => r !== 'meta')],
      },
      endpointMapping: { method: t.endpointMapping.method, path: '/mcp' },
      outputSchema: null,
      annotations: null,
    };
  });

describe('decathlon-shop adapter: static spec conformance', () => {
  it("bridges Decathlon's US shopping endpoint without credentials", () => {
    expect(a.name).toBe('Decathlon US Shop');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe(MCP_URL);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector).not.toHaveProperty('authConfig');
    expect(a.connector).not.toHaveProperty('headers');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a).not.toHaveProperty('envVarMeta');
    expect(setupKind(a as never)).toBe('none');
  });

  it('sends the agent profile with every call instead of asking the model for it', () => {
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'decathlon_shop_', mcpFixedArguments: FIXED });
    expect(mcpFixedArgumentsOf(a.connector.config)).toEqual(FIXED);
    expect(withMcpFixedArguments({ catalog: { query: 'tent' } }, mcpFixedArgumentsOf(a.connector.config))).toEqual({
      catalog: { query: 'tent' },
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
    });
  });

  it('names each of the 14 tools with the prefix and calls it by its remote name', () => {
    expect(a.tools.map((t) => t.endpointMapping.method).sort()).toEqual(ALL);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.parameters.type).toBe('object');
      expect(t.parameters).not.toHaveProperty('$schema');
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
      for (const [p, def] of Object.entries(t.parameters.properties)) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(14);
  });

  it('ships every cart and checkout write switched off, and only those', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(OFF);
    for (const t of a.tools) {
      const write = OFF.includes(t.endpointMapping.method);
      expect(`${t.name}: ${t.annotations?.readOnlyHint}`).toBe(`${t.name}: ${!write}`);
    }
    expect(tool('complete_checkout').annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });

  it('carries no agent profile parameter in the snapshot: only the idempotency key of complete_checkout is left of meta', () => {
    for (const t of a.tools) {
      // Nothing left to strip: the fallback installed when the server cannot be reached is already clean.
      expect(withoutMcpFixedArguments(t.parameters as never, FIXED)).toBe(t.parameters);
      expect(JSON.stringify(t.parameters)).not.toContain('ucp-agent');
      if (t.endpointMapping.method !== 'complete_checkout') expect(t.parameters.properties).not.toHaveProperty('meta');
    }
    const meta = tool('complete_checkout').parameters.properties.meta;
    expect(Object.keys(meta.properties ?? {})).toEqual(['idempotency-key']);
    expect(meta.required).toEqual(['idempotency-key']);
    expect(tool('complete_checkout').parameters.required?.slice().sort()).toEqual(['checkout', 'id', 'meta']);
  });

  it('search takes the query, filters and paging inside catalog', () => {
    const catalog = tool('search_catalog').parameters.properties.catalog;
    expect(tool('search_catalog').parameters.required).toEqual(['catalog']);
    expect(Object.keys(catalog.properties ?? {})).toEqual(expect.arrayContaining(['query', 'filters', 'pagination']));
    expect(tool('get_product').parameters.properties.catalog.required).toEqual(['id']);
    expect(tool('ask_business').parameters.properties.ask.required).toEqual(['query']);
    for (const m of ['get_cart', 'get_checkout', 'get_order', 'cancel_cart', 'cancel_checkout']) {
      expect(tool(m).parameters.required).toEqual(['id']);
    }
  });

  it("drops the profile from what the server lists, at install and on Discover tools, and keeps the writes off", () => {
    const listed = asServerLists();
    expect(listed.every((d) => (d.parameters.required as string[]).includes('meta'))).toBe(true);

    const atInstall = mergeDiscoveredMcpTools(
      a.tools as never,
      listed,
      a.connector.config.mcpToolPrefix,
      mcpFixedArgumentsOf(a.connector.config),
    );
    const onDiscover = catalogMcpToolsFor({ ...a.connector.config, adapterSlug: 'decathlon-shop' }, asServerLists());
    for (const merged of [atInstall, onDiscover]) {
      expect(merged.map((t) => t.name).sort()).toEqual(a.tools.map((t) => t.name).sort());
      expect(merged.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method).sort()).toEqual(OFF);
      for (const t of merged) {
        const snapshot = a.tools.find((s) => s.name === t.name)!;
        expect(JSON.stringify(t.parameters)).not.toContain('ucp-agent');
        expect(Object.keys((t.parameters as Schema).properties).sort()).toEqual(Object.keys(snapshot.parameters.properties).sort());
        expect(((t.parameters as Schema).required ?? []).slice().sort()).toEqual((snapshot.parameters.required ?? []).slice().sort());
        expect(t.annotations).toEqual(snapshot.annotations);
      }
    }
    expect(onDiscover.every((t) => t.origin === 'catalog')).toBe(true);
    // The server's own listing is not changed.
    expect(Object.keys(listed[0].parameters.properties as object)).toContain('meta');
  });

  it('says what it covers, that prices are in minor units, and why cart and checkout are off', () => {
    expect(a.instructions).toMatch(/^## Decathlon US Shop\n/);
    expect(a.instructions).toMatch(/US online store/);
    expect(a.instructions).toMatch(/No Decathlon account, no API key/);
    expect(a.instructions).toMatch(/minor units/);
    expect(a.instructions).toMatch(/2500 with `currency` USD is \$25\.00/);
    expect(a.instructions).toMatch(/Carts and checkout are switched off at install/);
    expect(a.instructions).toMatch(/places a real order/);
    expect(a.instructions).toMatch(/Discover tools/);
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

describe('importAdapter for an MCP adapter without credentials (decathlon-shop)', () => {
  const build = (discover: jest.Mock) => {
    const created: Array<Record<string, any>> = [];
    const prisma = {
      connector: { create: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data })) },
      mcpTool: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
        createMany: jest.fn(async ({ data }: any) => {
          created.push(...data);
          return { count: data.length };
        }),
      },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { discoverRemoteMcpTools: discover } as any,
    );
    // The install path is what is tested here, whether or not the catalog lists the adapter yet.
    jest.spyOn(service as any, 'isInstallableHere').mockReturnValue(true);
    return { service, prisma, created };
  };

  it('installs with nothing to enter, lists the server tools and stores them without the profile parameter', async () => {
    const discover = jest.fn().mockResolvedValue(asServerLists());
    const { service, prisma, created } = build(discover);
    const out = await service.importAdapter('decathlon-shop', 'u1', 'o1', {});

    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: 'MCP', baseUrl: MCP_URL, authType: 'NONE' });
    expect(data.authConfig ?? null).toBeNull();
    expect(data.config).toMatchObject({
      adapterSlug: 'decathlon-shop',
      mcpToolPrefix: 'decathlon_shop_',
      mcpFixedArguments: FIXED,
    });
    // Listed with the connector as stored: no credentials, the endpoint as is.
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0][0]).toMatchObject({ baseUrl: MCP_URL, authType: 'NONE' });

    expect(created).toHaveLength(14);
    expect(created.filter((t) => t.isEnabled === false).map((t) => t.endpointMapping.method).sort()).toEqual(OFF);
    for (const t of created) {
      expect(t.name).toBe(`decathlon_shop_${t.endpointMapping.method}`);
      expect(JSON.stringify(t.parameters)).not.toContain('ucp-agent');
      expect(t.description).toBe(`server ${t.endpointMapping.method}`);
    }
    expect(created.find((t) => t.name === 'decathlon_shop_search_catalog')!.parameters.required).toEqual(['catalog']);
    expect(Object.keys(created.find((t) => t.name === 'decathlon_shop_complete_checkout')!.parameters.properties.meta.properties)).toEqual([
      'idempotency-key',
    ]);
    expect(out.toolsCreated).toBe(14);
    expect(out.probe).toMatchObject({ ok: true, toolName: 'tools/list' });
  });

  it('falls back to the snapshot, already without the profile parameter, when the server cannot be listed', async () => {
    const discover = jest.fn().mockRejectedValue(Object.assign(new Error('Error POSTing to endpoint (HTTP 503)'), { code: 503 }));
    const { service, created } = build(discover);
    const out = await service.importAdapter('decathlon-shop', 'u1', 'o1', {});

    expect(created.map((t) => t.name).sort()).toEqual(a.tools.map((t) => t.name).sort());
    expect(created.filter((t) => t.isEnabled === false)).toHaveLength(7);
    expect(JSON.stringify(created.map((t) => t.parameters))).not.toContain('ucp-agent');
    expect(out.probe).toMatchObject({ ok: false, toolName: 'tools/list', status: 503 });
  });
});

const live = process.env.RUN_DECATHLON_SHOP_LIVE === '1' ? describe : describe.skip;

live('decathlon-shop adapter: live endpoint, read-only', () => {
  jest.setTimeout(90_000);
  const engine = new McpClientEngine({} as never);
  const profile = process.env.DECATHLON_SHOP_PROFILE_URL || PROFILE_URL;

  it('lists exactly the tools in the catalog snapshot, without credentials, and the profile leaves every schema', async () => {
    const tools = await engine.listTools({ baseUrl: MCP_URL, authType: 'NONE' });
    expect(tools.map((t) => t.name).sort()).toEqual(ALL);
    for (const t of tools) {
      expect((t.inputSchema.required as string[]) ?? []).toContain('meta');
    }
    const merged = mergeDiscoveredMcpTools(
      a.tools as never,
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        endpointMapping: { method: t.name, path: '/mcp' },
        outputSchema: null,
        annotations: null,
      })),
      a.connector.config.mcpToolPrefix,
      mcpFixedArgumentsOf(a.connector.config),
    );
    for (const t of merged) {
      const snapshot = a.tools.find((s) => s.name === t.name)!;
      expect(JSON.stringify(t.parameters)).not.toContain('ucp-agent');
      // The snapshot is what the server lists today, minus $schema and the profile.
      const { $schema: _schema, ...listed } = t.parameters as Record<string, unknown>;
      expect({ ...listed, properties: withoutDescriptions((listed as Schema).properties) }).toEqual({
        ...snapshot.parameters,
        properties: withoutDescriptions(snapshot.parameters.properties),
      });
    }
  });

  it('searches the catalog with the profile sent by the connector: USD prices in minor units', async () => {
    const result = (await engine.execute(
      { baseUrl: MCP_URL, authType: 'NONE', fixedArguments: { meta: { 'ucp-agent': { profile } } } },
      { method: 'search_catalog', path: '/mcp' },
      // What a model sends: no meta.
      { catalog: { query: 'hiking backpack', pagination: { limit: 2 } } },
    )) as { isError?: boolean; structuredContent?: any; content: Array<{ type: string; text?: string }> };

    expect(result.isError).not.toBe(true);
    const body = result.structuredContent ?? JSON.parse(result.content.map((c) => c.text ?? '').join(''));
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products.length).toBeLessThanOrEqual(2);
    const product = body.products[0];
    expect(product.id).toMatch(/^gid:\/\/shopify\/Product\//);
    expect(product.url).toMatch(/^https:\/\/www\.decathlon\.com\//);
    expect(Number.isInteger(product.price_range.min.amount)).toBe(true);
    expect(product.price_range.min.currency).toBe('USD');
  });
});

/** Top-level parameter descriptions may be filled in by the snapshot where the server has none. */
function withoutDescriptions(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([k, v]) => {
      const { description: _d, ...rest } = v as Record<string, unknown>;
      return [k, rest];
    }),
  );
}
