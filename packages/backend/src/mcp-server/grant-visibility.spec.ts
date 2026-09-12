import { McpEndpointController } from './mcp-endpoint.controller';
import { toolVisibilityRole } from './mcp-server.service';
import type { RegisteredTool } from './tool-registry';

/**
 * What a connection grant narrows the shared `/mcp` down to.
 *
 * `attachVisibleTools` decides both halves of the answer: the names the
 * transport will list, and the connector ids the call path is then confined to.
 * The two must agree — a surface that lists less than it will execute is the
 * shape the 12 Sep cross-tenant bug took.
 */
function tool(
  id: string,
  name: string,
  organizationId: string,
  connectorId: string,
): RegisteredTool {
  return {
    id,
    connectorId,
    organizationId,
    name,
    description: name,
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/' },
  };
}

const ALL = [
  tool('t-a1', 'alpha', 'org-A', 'conn-A1'),
  tool('t-a2', 'beta', 'org-A', 'conn-A2'),
  tool('t-b1', 'gamma', 'org-B', 'conn-B1'),
  tool('t-c1', 'delta', 'org-C', 'conn-C1'),
];

function build(
  grant: unknown,
  opts: { allowedByOrg?: Record<string, string[] | null>; connectorsByServer?: Record<string, string[]> } = {},
) {
  const controller = new McpEndpointController(
    {
      getConnectorIds: jest.fn(async (id: string) => opts.connectorsByServer?.[id] ?? []),
    } as any,
    { getAllTools: () => ALL } as any,
    {} as any,
    {
      getAllowedToolIds: jest.fn(async (_sub: string, org: string) =>
        opts.allowedByOrg ? (opts.allowedByOrg[org] ?? null) : null,
      ),
    } as any,
    {} as any,
    {} as any,
    { resolve: jest.fn().mockResolvedValue(grant) } as any,
  );
  return controller;
}

async function visible(controller: McpEndpointController, user: any) {
  const req: any = { user };
  const names: Set<string> | null = await (controller as any).attachVisibleTools(req);
  return { names, user: req.user };
}

describe('grant-scoped visibility on the shared /mcp', () => {
  const caller = () => ({ sub: 'u1', organizationId: 'org-A', client_id: 'client-1' });

  // Every token issued before grants existed resolves to null. Their surface
  // must not move by a single tool.
  it('falls back to the active organization when there is no grant', async () => {
    const { names, user } = await visible(build(null), caller());

    expect([...names!].sort()).toEqual(['alpha', 'beta']);
    expect(user.grantedConnectorIds).toBeUndefined();
  });

  it('shows exactly the granted workspace, which need not be the active one', async () => {
    const { names, user } = await visible(
      build({ mode: 'organization', organizationId: 'org-B' }),
      caller(),
    );

    expect([...names!]).toEqual(['gamma']);
    expect(user.grantedConnectorIds).toEqual(['conn-B1']);
  });

  it('shows only the connectors of the granted servers', async () => {
    const controller = build(
      { mode: 'servers', servers: [{ id: 'srv-1', organizationId: 'org-A' }] },
      { connectorsByServer: { 'srv-1': ['conn-A2'] } },
    );

    const { names, user } = await visible(controller, caller());

    expect([...names!]).toEqual(['beta']);
    expect(user.grantedConnectorIds).toEqual(['conn-A2']);
  });

  it('spans organizations when the grant does, and no further', async () => {
    const controller = build(
      {
        mode: 'servers',
        servers: [
          { id: 'srv-a', organizationId: 'org-A' },
          { id: 'srv-b', organizationId: 'org-B' },
        ],
      },
      { connectorsByServer: { 'srv-a': ['conn-A1'], 'srv-b': ['conn-B1'] } },
    );

    const { names } = await visible(controller, caller());

    expect([...names!].sort()).toEqual(['alpha', 'gamma']);
    expect([...names!]).not.toContain('delta');
  });

  // A grant whose targets stopped validating is zero tools, never "everything".
  it('shows nothing for a grant that no longer resolves', async () => {
    const { names, user } = await visible(build({ mode: 'none' }), caller());

    expect([...names!]).toEqual([]);
    expect(user.grantedConnectorIds).toEqual([]);
  });

  it('plants a visibility role for every name it lists, and no other', async () => {
    const { names, user } = await visible(
      build({ mode: 'organization', organizationId: 'org-B' }),
      caller(),
    );

    expect(user.roles).toContain(toolVisibilityRole('gamma'));
    expect(user.roles).not.toContain(toolVisibilityRole('alpha'));
    expect(names!.has('gamma')).toBe(true);
  });

  // Roles belong to the organization that owns the tool. Reading them from the
  // caller's ACTIVE org would apply org-A's restrictions to org-B's tools.
  it('reads roles from the organization that owns each tool', async () => {
    const controller = build(
      {
        mode: 'servers',
        servers: [
          { id: 'srv-a', organizationId: 'org-A' },
          { id: 'srv-b', organizationId: 'org-B' },
        ],
      },
      {
        connectorsByServer: { 'srv-a': ['conn-A1'], 'srv-b': ['conn-B1'] },
        // Restricted in org-A, unrestricted in org-B.
        allowedByOrg: { 'org-A': [], 'org-B': null },
      },
    );

    const { names } = await visible(controller, caller());

    expect([...names!]).toEqual(['gamma']);
  });

  it('confines the call path to exactly what it listed', async () => {
    const controller = build(
      { mode: 'servers', servers: [{ id: 'srv-1', organizationId: 'org-A' }] },
      { connectorsByServer: { 'srv-1': ['conn-A1', 'conn-A2'] }, allowedByOrg: { 'org-A': ['t-a1'] } },
    );

    const { names, user } = await visible(controller, caller());

    expect([...names!]).toEqual(['alpha']);
    // conn-A2 was reachable but its tool is not role-allowed, so the call path
    // must not be handed it either.
    expect(user.grantedConnectorIds).toEqual(['conn-A1']);
  });
});
