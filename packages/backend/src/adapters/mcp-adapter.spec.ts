import { AdaptersService } from './adapters.service';
import { getAdapter } from './catalog';
import { describeDiscoveredTools, mergeDiscoveredMcpTools } from './mcp-adapter.util';
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
});
