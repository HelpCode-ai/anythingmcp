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
      activeSkillsText: jest.fn(async (_o: string, _s: string, ids: string[]) =>
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
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('org-A', 'srv-1', ['c-crm'], 'auto', null);
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
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('org-A', 'srv-1', [], 'auto', null);
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

/**
 * A shared /mcp connection can reach connectors of several workspaces. Each
 * workspace's skills are read with its own organization and only its own
 * server and connector ids.
 */
describe('McpServersService — shared guide skills per workspace', () => {
  it('reads each workspace\'s skills with its own organization and ids', async () => {
    const prisma = {
      mcpServerConfig: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'srv-a', name: 'A', instructions: null, organizationId: 'org-A' },
        ]),
      },
      connector: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c-a', name: 'CRM', instructions: null, organizationId: 'org-A' },
          { id: 'c-b', name: 'Fibu', instructions: null, organizationId: 'org-B' },
        ]),
      },
    };
    const kgSkills = {
      activeSkillsText: jest.fn(async (org: string) => `## Workspace skills\n- ${org}`),
    };
    const service = new McpServersService(prisma as any, kgSkills as any, {} as any);

    const text = await service.getSharedGuide({ connectorIds: ['c-a', 'c-b'], serverIds: ['srv-a'] });

    expect(kgSkills.activeSkillsText).toHaveBeenCalledTimes(2);
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('org-A', ['srv-a'], ['c-a'], 'full', null);
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('org-B', [], ['c-b'], 'full', null);
    expect(text).toContain('- org-A');
    expect(text).toContain('- org-B');
  });
});

/**
 * A catalog connector's per-workspace facts (the Atlassian site and its
 * cloudId) reach the model with its instructions, on initialize and in the
 * shared workspace guide, while its variables go no further.
 */
describe('McpServersService — instruction facts of catalog connectors', () => {
  const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';
  const JIRA = {
    id: 'c-jira',
    name: 'Atlassian',
    instructions: 'Catalog text.',
    organizationId: 'org-A',
    envVars: { ATLASSIAN_SITE: 'acme.atlassian.net', ATLASSIAN_CLOUD_ID: CLOUD_ID, ATLASSIAN_API_TOKEN: 'ATATTsecret' },
    config: { adapterSlug: 'atlassian' },
  };
  const kgSkills = { activeSkillsText: jest.fn().mockResolvedValue(null) };

  it('adds the cloudId to the composed instructions and the visible content', async () => {
    const prisma = {
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ instructions: null, organizationId: 'org-A' }) },
      mcpServerConnector: { findMany: jest.fn().mockResolvedValue([{ connectorId: 'c-jira', connector: JIRA }]) },
      mcpResource: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new McpServersService(prisma as any, kgSkills as any, {} as any);
    const content = await service.getVisibleContent('srv-1', ['c-jira']);
    expect(content.instructions).toContain(
      `## Atlassian\nCatalog text.\n\nThis workspace's Atlassian site is acme.atlassian.net, cloudId ${CLOUD_ID}`,
    );
    expect(content.connectors).toEqual([
      { id: 'c-jira', name: 'Atlassian', instructions: expect.stringContaining(`cloudId ${CLOUD_ID}`) },
    ]);
    expect(JSON.stringify(content)).not.toContain('ATATTsecret');
  });

  it('adds the cloudId to the shared workspace guide', async () => {
    const prisma = {
      mcpServerConfig: { findMany: jest.fn().mockResolvedValue([]) },
      connector: { findMany: jest.fn().mockResolvedValue([JIRA]) },
    };
    const service = new McpServersService(prisma as any, kgSkills as any, {} as any);
    const text = await service.getSharedGuide({ connectorIds: ['c-jira'], serverIds: [] });
    expect(text).toContain(`cloudId ${CLOUD_ID}`);
    expect(text).not.toContain('ATATTsecret');
  });
});
