import { AdaptersService } from './adapters.service';
import { getAdapter, listAdapters } from './catalog';
import { setupKind } from './env-var-meta';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { mcpToolPrefixOf } from '../connectors/mcp-connector-config.util';
import { catalogMcpToolsFor, describeDiscoveredTools, mergeDiscoveredMcpTools } from './mcp-adapter.util';
import type { DiscoveredMcpTool } from '../connectors/connectors.service';

/**
 * Catalog adapters that bridge a vendor's own MCP server (Splunk first):
 * the tools come from the workspace's server at install, the catalog only
 * adds policy (tools switched off by default, annotation overrides), and the
 * catalog's snapshot is the fallback when the server cannot be reached.
 */

const remote = (name: string, extra: Partial<DiscoveredMcpTool> = {}): DiscoveredMcpTool => ({
  name,
  description: `${name} from the server`,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  endpointMapping: { method: name, path: '/mcp' },
  outputSchema: null,
  annotations: { readOnlyHint: true },
  ...extra,
});

describe('mergeDiscoveredMcpTools', () => {
  const catalog = [
    { name: 'a_read', description: 'old', parameters: {}, endpointMapping: { method: 'a_read', path: '/mcp' } },
    {
      name: 'a_write',
      description: 'old',
      parameters: {},
      endpointMapping: { method: 'a_write', path: '/mcp' },
      annotations: { readOnlyHint: false, destructiveHint: true },
      enabled: false,
    },
    { name: 'a_gone', description: 'old', parameters: {}, endpointMapping: { method: 'a_gone', path: '/mcp' } },
  ];

  const merged = mergeDiscoveredMcpTools(catalog, [remote('a_read'), remote('a_write'), remote('a_new')]);

  it('installs what the server lists, as the server describes it', () => {
    expect(merged.map((t) => t.name)).toEqual(['a_read', 'a_write', 'a_new']);
    expect(merged[0].description).toBe('a_read from the server');
    expect(merged[0].parameters).toEqual(remote('a_read').parameters);
  });

  it('keeps the catalog policy: switched off; annotations fill what the server leaves out', () => {
    const write = merged.find((t) => t.name === 'a_write')!;
    expect(write.enabled).toBe(false);
    // The server says readOnlyHint: true and wins on it; destructiveHint only the catalog has.
    expect(write.annotations).toEqual({ readOnlyHint: true, destructiveHint: true });
    expect(merged.find((t) => t.name === 'a_read')!.enabled).toBeUndefined();
    expect(merged.find((t) => t.name === 'a_read')!.annotations).toEqual({ readOnlyHint: true });
  });

  it('drops catalog tools the server no longer has', () => {
    expect(merged.find((t) => t.name === 'a_gone')).toBeUndefined();
  });

  it('names the tools with the prefix, matches the policy by local or remote name, and calls the remote name', () => {
    const prefixed = mergeDiscoveredMcpTools(
      [
        // Snapshot entries carry the local name and call the remote one.
        { name: 'acme_delete_page', description: '', parameters: {}, endpointMapping: { method: 'delete-page', path: '/mcp' }, enabled: false },
        { name: 'acme_search', description: '', parameters: {}, endpointMapping: { method: 'search', path: '/mcp' }, annotations: { idempotentHint: true } },
      ],
      [remote('delete-page'), remote('search'), remote('acme_fetch')],
      'acme_',
    );
    expect(prefixed.map((t) => [t.name, t.endpointMapping.method, t.enabled])).toEqual([
      ['acme_delete_page', 'delete-page', false],
      ['acme_search', 'search', undefined],
      // Already prefixed upstream: not doubled.
      ['acme_fetch', 'acme_fetch', undefined],
    ]);
    expect(prefixed[1].annotations).toEqual({ idempotentHint: true, readOnlyHint: true });
  });

  it('applies the catalog policy to tools discovered later, and only the prefix to a hand-made connector', () => {
    const later = catalogMcpToolsFor({ adapterSlug: 'splunk' }, [remote('splunk_update_dashboard'), remote('splunk_x')]);
    expect(later.map((t) => [t.name, t.enabled, t.origin])).toEqual([
      ['splunk_update_dashboard', false, 'catalog'],
      ['splunk_x', undefined, 'catalog'],
    ]);
    const own = catalogMcpToolsFor({ mcpToolPrefix: 'mine_' }, [remote('list')]);
    expect(own).toEqual([
      expect.objectContaining({ name: 'mine_list', endpointMapping: { method: 'list', path: '/mcp' } }),
    ]);
    expect(own[0]).not.toHaveProperty('origin');
    expect(catalogMcpToolsFor(null, [remote('list')])[0].name).toBe('list');
  });

  it('describes the discovered tools in one line', () => {
    expect(describeDiscoveredTools([{ name: 'x' }, { name: 'y' }])).toBe('2 tools on the server: x, y');
    expect(describeDiscoveredTools([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2)).toBe(
      '3 tools on the server: a, b, … (1 more)',
    );
  });
});

describe('importAdapter for an MCP adapter (splunk)', () => {
  const build = (discover: jest.Mock) => {
    const created: any[] = [];
    const prisma = {
      connector: {
        create: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data })),
      },
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
    return { service, prisma, created };
  };
  const creds = { SPLUNK_HOST: 'acme.splunkcloud.com', SPLUNK_MCP_TOKEN: 'tok' };

  it('creates the connector on the management port and installs the server tools', async () => {
    const discover = jest.fn().mockResolvedValue([
      remote('splunk_run_query'),
      remote('splunk_update_dashboard'),
      remote('splunk_brand_new_tool'),
    ]);
    const { service, prisma, created } = build(discover);
    const out = await service.importAdapter('splunk', 'u1', 'o1', creds);

    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.type).toBe('MCP');
    expect(data.baseUrl).toBe('https://acme.splunkcloud.com:8089/services/mcp');
    expect(data.authType).toBe('BEARER_TOKEN');
    expect(discover).toHaveBeenCalledTimes(1);

    expect(created.map((t) => t.name)).toEqual([
      'splunk_run_query',
      'splunk_update_dashboard',
      'splunk_brand_new_tool',
    ]);
    // The catalog switches the dashboard writes off; the server's other tools stay on.
    expect(created.find((t) => t.name === 'splunk_update_dashboard').isEnabled).toBe(false);
    expect(created.find((t) => t.name === 'splunk_run_query').isEnabled).toBe(true);
    expect(created.every((t) => t.origin === 'catalog')).toBe(true);

    expect(out.toolsCreated).toBe(3);
    expect(out.probe).toMatchObject({ ok: true, toolName: 'tools/list' });
    expect((out.probe as any).sample).toContain('3 tools on the server');
  });

  it('falls back to the catalog snapshot and reports why when the server cannot be listed', async () => {
    const err = Object.assign(new Error('Error POSTing to endpoint (HTTP 403): invalid token audience'), {
      code: 403,
    });
    const discover = jest.fn().mockRejectedValue(err);
    const { service, created } = build(discover);
    const out = await service.importAdapter('splunk', 'u1', 'o1', creds);

    const snapshot = getAdapter('splunk')!.tools;
    expect(created).toHaveLength(snapshot.length);
    expect(created.find((t) => t.name === 'splunk_create_dashboard').isEnabled).toBe(false);
    expect(out.probe).toMatchObject({ ok: false, toolName: 'tools/list', status: 403 });
    expect((out.probe as any).message).toContain('invalid token audience');
  });

  it('inserts the tools in one batch, and one by one only if the batch fails', async () => {
    const discover = jest.fn().mockResolvedValue([remote('splunk_get_info'), remote('splunk_get_indexes')]);
    const { service, prisma } = build(discover);
    await service.importAdapter('splunk', 'u1', 'o1', creds);
    expect(prisma.mcpTool.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();

    const fallback = build(jest.fn().mockResolvedValue([remote('splunk_get_info'), remote('splunk_get_indexes')]));
    fallback.prisma.mcpTool.createMany.mockRejectedValueOnce(new Error('batch refused'));
    const out = await fallback.service.importAdapter('splunk', 'u1', 'o1', creds);
    expect(fallback.prisma.mcpTool.create).toHaveBeenCalledTimes(2);
    expect(out.toolsCreated).toBe(2);
  });

  it('prefixes the tools of a bridge that sets a tool prefix (linear), calling them by the remote name', async () => {
    const discover = jest.fn().mockResolvedValue([remote('list_issues'), remote('delete_comment'), remote('brand_new')]);
    const { service, prisma, created } = build(discover);
    await service.importAdapter('linear', 'u1', 'o1', { LINEAR_API_KEY: 'lin_api_x' });

    expect(prisma.connector.create.mock.calls[0][0].data.config).toMatchObject({ mcpToolPrefix: 'linear_' });
    expect(created.map((t) => [t.name, t.endpointMapping.method, t.isEnabled])).toEqual([
      ['linear_list_issues', 'list_issues', true],
      ['linear_delete_comment', 'delete_comment', false],
      ['linear_brand_new', 'brand_new', true],
    ]);
  });

  it('installs the snapshot of a bridge that needs a sign-in without trying to list it (notion)', async () => {
    const discover = jest.fn();
    const { service, prisma, created } = build(discover);
    const out = await service.importAdapter('notion', 'u1', 'o1', {});

    expect(discover).not.toHaveBeenCalled();
    expect(out.probe).toBeNull();
    expect(created).toHaveLength(getAdapter('notion')!.tools.length);
    expect(prisma.connector.create.mock.calls[0][0].data).toMatchObject({
      authType: 'OAUTH2',
      config: { mcpOAuth: { registration: 'dcr' } },
    });
  });
});

describe('MCP bridge adapters in the catalog', () => {
  const bridges = listAdapters()
    .map((a) => getAdapter(a.slug)!)
    .filter((a) => a.connector.type === 'MCP');

  it('includes the vendor bridges', () => {
    expect(bridges.map((a) => a.slug).sort()).toEqual(
      expect.arrayContaining(['apify', 'atlassian', 'firecrawl', 'github', 'helium10', 'linear', 'notion', 'snowflake', 'splunk', 'stripe']),
    );
  });

  it.each(bridges.filter((a) => a.slug !== 'splunk').map((a) => [a.slug, a]))(
    '%s sets a tool prefix, lists prerequisites and ships no tool named twice',
    (_slug, a) => {
      const prefix = mcpToolPrefixOf(a.connector.config);
      expect(prefix).toBe(`${a.slug.replace(/-/g, '_')}_`);
      expect(a.prerequisites?.length).toBeGreaterThan(0);
      const names = a.tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it('keeps Stripe in payments, so the shared /mcp never offers it', () => {
    expect(getAdapter('stripe')!.category).toBe('payments');
    expect(getAdapter('stripe')!.tools.find((t) => t.endpointMapping.method === 'stripe_api_write')?.enabled).toBe(false);
  });

  it('counts the OAuth bridges as a sign-in at the provider, and the key ones as credentials', () => {
    expect(setupKind(getAdapter('notion')!)).toBe('oauth_browser');
    expect(setupKind(getAdapter('helium10')!)).toBe('oauth_browser');
    expect(setupKind(getAdapter('linear')!)).toBe('credentials');
  });

  it('holds an installed OAuth bridge back from MCP until it is authorized', () => {
    const base = { authType: 'OAUTH2', baseUrl: 'https://mcp.notion.com/mcp', config: { adapterSlug: 'notion' } };
    expect(computeSetupState({ ...base, authConfig: {} }).status).toBe('needs_authorization');
    expect(computeSetupState({ ...base, authConfig: { accessToken: 'at' } }).status).toBe('ready');
    // A hand-made MCP connector with a pasted token is left as it was.
    expect(computeSetupState({ ...base, config: null, authConfig: {} }).status).toBe('ready');
  });
});
