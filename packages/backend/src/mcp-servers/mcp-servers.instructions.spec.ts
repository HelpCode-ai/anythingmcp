import { McpServersService } from './mcp-servers.service';

/**
 * initialize instructions used to include every assigned connector, so a
 * role-restricted caller was told how to use connectors their role denies.
 * They are now composed from the caller's visible connector set only.
 */
describe('McpServersService — caller-scoped instructions and resources', () => {
  const SERVER = { instructions: 'SERVER-GUIDANCE', organizationId: 'org-A' };
  const ASSIGNED = [
    { connectorId: 'c-crm', connector: { id: 'c-crm', name: 'CRM', instructions: 'Use the CRM.' } },
    { connectorId: 'c-fibu', connector: { id: 'c-fibu', name: 'Fibu', instructions: 'Ledger rules.' } },
    { connectorId: 'c-bare', connector: { id: 'c-bare', name: 'Bare', instructions: null } },
  ];

  function make(server: unknown = SERVER, resourceRows: unknown[] = []) {
    const prisma = {
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue(server) },
      mcpServerConnector: {
        findMany: jest.fn(async ({ where }: any) =>
          ASSIGNED.filter((a) => where.connectorId.in.includes(a.connectorId)),
        ),
      },
      mcpResource: { findMany: jest.fn().mockResolvedValue(resourceRows) },
    };
    const kgSkills = {
      activeSkillsText: jest.fn(async (_s: string, ids: string[]) =>
        ids.length ? `## Workspace skills\n- for ${ids.join(',')}` : '## Workspace skills\n- server-wide',
      ),
    };
    const service = new McpServersService(prisma as any, kgSkills as any, {} as any);
    return { service, prisma, kgSkills };
  }

  it('is unchanged for a caller who sees every assigned connector', async () => {
    const { service } = make();
    expect(await service.getComposedInstructions('srv-1', ['c-crm', 'c-fibu', 'c-bare'])).toBe(
      'SERVER-GUIDANCE\n\n## CRM\nUse the CRM.\n\n## Fibu\nLedger rules.\n\n' +
        '## Workspace skills\n- for c-crm,c-fibu,c-bare',
    );
  });

  it('drops a denied connector and its connector-scoped skills', async () => {
    const { service, kgSkills } = make();
    const text = await service.getComposedInstructions('srv-1', ['c-crm']);
    expect(text).toContain('Use the CRM.');
    expect(text).not.toContain('Ledger rules.');
    expect(text).not.toContain('Fibu');
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('srv-1', ['c-crm']);
  });

  it('scopes the assignment query to the visible ids AND the server organization', async () => {
    const { service, prisma } = make();
    await service.getComposedInstructions('srv-1', ['c-crm', 'c-crm']);
    expect(prisma.mcpServerConnector.findMany.mock.calls[0][0].where).toEqual({
      mcpServerId: 'srv-1',
      connectorId: { in: ['c-crm'] },
      connector: { organizationId: 'org-A' },
    });
  });

  it('with no visible connector, keeps only the server-level text and queries no connector', async () => {
    const { service, prisma, kgSkills } = make();
    const text = await service.getComposedInstructions('srv-1', []);
    expect(text).toBe('SERVER-GUIDANCE\n\n## Workspace skills\n- server-wide');
    expect(prisma.mcpServerConnector.findMany).not.toHaveBeenCalled();
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('srv-1', []);
  });

  it('getVisibleContent returns the visible connectors with instructions and their stored rows', async () => {
    const rows = [
      {
        connectorId: 'c-crm',
        uri: 'crm://schema',
        name: 'schema',
        description: null,
        mimeType: 'text/markdown',
        fetchConfig: { text: 'x' },
      },
    ];
    const { service, prisma } = make(SERVER, rows);
    const content = await service.getVisibleContent('srv-1', ['c-crm', 'c-bare']);

    expect(content.connectors).toEqual([{ id: 'c-crm', name: 'CRM', instructions: 'Use the CRM.' }]);
    expect(content.resources).toEqual(rows);
    expect(content.instructions).toContain('Use the CRM.');
    expect(prisma.mcpResource.findMany.mock.calls[0][0].where).toEqual({
      connectorId: { in: ['c-crm', 'c-bare'] },
      connector: {
        organizationId: 'org-A',
        mcpServers: { some: { mcpServerId: 'srv-1' } },
      },
    });
  });

  it('getVisibleContent reads no stored rows when no connector is visible', async () => {
    const { service, prisma } = make();
    const content = await service.getVisibleContent('srv-1', []);
    expect(content.connectors).toEqual([]);
    expect(content.resources).toEqual([]);
    expect(prisma.mcpResource.findMany).not.toHaveBeenCalled();
  });

  it('getVisibleContent fails closed for an unknown server', async () => {
    const { service, prisma } = make(null);
    const content = await service.getVisibleContent('srv-gone', ['c-crm']);
    expect(content.connectors).toEqual([]);
    expect(content.resources).toEqual([]);
    expect(prisma.mcpServerConnector.findMany).not.toHaveBeenCalled();
    expect(prisma.mcpResource.findMany).not.toHaveBeenCalled();
  });
});
