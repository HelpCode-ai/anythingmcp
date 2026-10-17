import { CodeboundMcpService } from './codebound-mcp.service';
import { CodeboundConnection } from '../mcp-server/codebound-tools';

const connection: CodeboundConnection = {
  userId: 'u1',
  email: 'a@example.com',
  organizationId: 'org-a',
  authMethod: 'mcp_api_key',
  apiKeyName: 'agent',
};
const servers = [
  { id: 's1', name: 'First', organizationId: 'org-a' },
  { id: 's2', name: 'Second', organizationId: 'org-a' },
  { id: 's3', name: 'Other workspace', organizationId: 'org-b' },
];

function setup() {
  const prisma = {
    organizationMember: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ organizationId: 'org-a', role: 'EDITOR' }]),
    },
    mcpServerConfig: {
      findMany: jest.fn(async ({ where }: any) =>
        servers.filter(
          (server) =>
            where.organizationId.in.includes(server.organizationId) &&
            where.AND.every((condition: any) =>
              typeof condition.id === 'string'
                ? condition.id === server.id
                : condition.id.in.includes(server.id),
            ),
        ),
      ),
    },
    codeboundScript: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const grants = { resolve: jest.fn().mockResolvedValue(null) };
  const runner = {
    listTools: jest.fn().mockResolvedValue([
      {
        name: 'get_post',
        description: 'Read a post',
        inputSchema: {},
        outputSchema: null,
      },
    ]),
    run: jest.fn().mockResolvedValue({ result: { id: 1 }, calls: 1 }),
  };
  const saved = {
    id: 'script-1',
    mcpServerId: 's1',
    code: 'return input;',
    input: { default: true },
    allowedTools: ['get_post'],
    revision: 1,
  };
  const scripts = {
    get: jest.fn().mockResolvedValue(saved),
    create: jest.fn().mockResolvedValue(saved),
    update: jest.fn().mockResolvedValue({ ...saved, revision: 2 }),
    run: jest.fn().mockResolvedValue({ result: 1 }),
  };
  const registry = { register: jest.fn() };
  const service = new CodeboundMcpService(
    prisma as any,
    grants as any,
    runner as any,
    scripts as any,
    registry as any,
  );
  return { service, prisma, grants, runner, scripts, registry };
}
const run = {
  serverId: 's1',
  code: 'return await tools.call("get_post", {});',
  input: {},
  allowedTools: ['get_post'],
};

describe('Codebound MCP connection scope', () => {
  it('registers the feature without importing the MCP module back into itself', () => {
    const { service, registry } = setup();
    service.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(service);
  });

  it('discovers only active-member servers and requires explicit choice on shared /mcp', async () => {
    const { service, runner } = setup();
    expect(await service.call(connection, 'codebound_list_tools', {})).toEqual(
      expect.objectContaining({
        servers: [
          { id: 's1', name: 'First' },
          { id: 's2', name: 'Second' },
        ],
      }),
    );
    await expect(
      service.call(connection, 'codebound_run', {
        code: 'return 1;',
        allowedTools: [],
      }),
    ).rejects.toThrow('Choose a serverId');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('returns real tool contracts with bounded pages and unknown output schemas', async () => {
    const { service } = setup();
    expect(
      await service.call(
        { ...connection, endpointServerId: 's1' },
        'codebound_list_tools',
        {},
      ),
    ).toEqual({
      server: { id: 's1', name: 'First' },
      tools: [
        {
          name: 'get_post',
          description: 'Read a post',
          inputSchema: {},
          outputSchema: null,
        },
      ],
      nextOffset: null,
    });
    expect(
      await service.call(connection, 'codebound_list_tools', {
        serverId: 's1',
        query: 'missing',
      }),
    ).toEqual(expect.objectContaining({ tools: [] }));
  });

  it.each(['pinnedServerId', 'endpointServerId'] as const)(
    'never lets arguments override %s',
    async (key) => {
      const { service, runner } = setup();
      await expect(
        service.call({ ...connection, [key]: 's2' }, 'codebound_run', run),
      ).rejects.toThrow('not available');
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it('intersects the API-key pin with an OAuth grant instead of widening either', async () => {
    const { service, grants, runner } = setup();
    grants.resolve.mockResolvedValue({
      mode: 'servers',
      servers: [{ id: 's2', organizationId: 'org-a' }],
    });
    await expect(
      service.call(
        { ...connection, pinnedServerId: 's1', oauthClientId: 'client' },
        'codebound_run',
        run,
      ),
    ).rejects.toThrow('not available');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('uses the granted organization and its current membership role', async () => {
    const { service, grants, prisma, runner } = setup();
    grants.resolve.mockResolvedValue({
      mode: 'organization',
      organizationId: 'org-b',
    });
    prisma.organizationMember.findMany.mockResolvedValue([
      { organizationId: 'org-b', role: 'VIEWER' },
    ]);
    await service.call(
      { ...connection, oauthClientId: 'client-b' },
      'codebound_run',
      { ...run, serverId: 's3' },
    );
    expect(grants.resolve).toHaveBeenCalledWith('client-b', 'u1');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-b',
        role: 'VIEWER',
        authMethod: 'mcp_api_key',
        apiKeyName: 'agent',
      }),
      's3',
      expect.anything(),
      undefined,
      expect.any(Function),
    );
  });

  it('does not fall back when a grant is revoked', async () => {
    const { service, grants, runner } = setup();
    grants.resolve.mockResolvedValue({ mode: 'none' });
    await expect(
      service.call(connection, 'codebound_run', run),
    ).rejects.toThrow('no workspace access');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('re-resolves grants in the callback passed to every nested call', async () => {
    const { service, grants, runner } = setup();
    await service.call(connection, 'codebound_run', run);
    const check = (runner.run.mock.calls as any)[0][4];
    grants.resolve.mockResolvedValue({ mode: 'none' });
    await expect(check()).rejects.toThrow('no workspace access');
  });

  it('refuses deactivated membership even if a token claims ADMIN', async () => {
    const { service, prisma, runner } = setup();
    prisma.organizationMember.findMany.mockResolvedValue([]);
    await expect(
      service.call(connection, 'codebound_run', run),
    ).rejects.toThrow('not available');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects hidden tool names and invalid/duplicate allowlists before running', async () => {
    const { service, runner } = setup();
    for (const allowedTools of [
      ['secret_other_tool'],
      ['get_post', 'get_post'],
    ]) {
      await expect(
        service.call(connection, 'codebound_run', { ...run, allowedTools }),
      ).rejects.toThrow();
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects identity overrides and malformed arguments', async () => {
    const { service, runner } = setup();
    for (const args of [
      { ...run, organizationId: 'org-b' },
      { ...run, input: [] },
      { ...run, limit: 999 },
      { ...run, code: '' },
    ]) {
      await expect(
        service.call(connection, 'codebound_run', args),
      ).rejects.toThrow('Invalid arguments');
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('saves under the trusted server and only updates a reviewed accessible script', async () => {
    const { service, scripts } = setup();
    const args = { ...run, name: 'Post summary' };
    const saved = await service.call(connection, 'codebound_save_script', args);
    expect(saved).not.toHaveProperty('code');
    expect(saved).not.toHaveProperty('input');
    expect(scripts.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', role: 'EDITOR' }),
      expect.objectContaining({ mcpServerId: 's1', name: 'Post summary' }),
    );
    await expect(
      service.call(connection, 'codebound_save_script', {
        ...args,
        scriptId: 'script-1',
      }),
    ).rejects.toThrow('reviewed revision');
    await service.call(connection, 'codebound_save_script', {
      ...args,
      scriptId: 'script-1',
      revision: 1,
    });
    expect(scripts.get).toHaveBeenCalledWith(
      expect.anything(),
      'script-1',
      's1',
    );
    expect(scripts.update).toHaveBeenCalledWith(
      expect.anything(),
      'script-1',
      expect.objectContaining({ revision: 1, mcpServerId: 's1' }),
    );
  });

  it('omits saved workflows with inaccessible tools without revealing their source', async () => {
    const { service, prisma } = setup();
    prisma.codeboundScript.findMany.mockResolvedValue([
      { id: 'visible', name: 'Visible', allowedTools: ['get_post'] },
      { id: 'hidden', name: 'Hidden', allowedTools: ['private_tool'] },
    ]);
    expect(
      await service.call(connection, 'codebound_list_scripts', {
        serverId: 's1',
      }),
    ).toEqual({
      items: [{ id: 'visible', name: 'Visible' }],
      nextOffset: null,
    });
    expect(prisma.codeboundScript.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', mcpServerId: 's1' },
      }),
    );
  });

  it('refuses opening or running saved workflows with newly denied tools', async () => {
    const { service, scripts } = setup();
    scripts.get.mockResolvedValue({
      id: 'hidden',
      allowedTools: ['private_tool'],
    } as any);
    for (const name of ['codebound_get_script', 'codebound_run_saved']) {
      await expect(
        service.call(connection, name, {
          serverId: 's1',
          scriptId: 'hidden',
          ...(name === 'codebound_run_saved' ? { revision: 1 } : {}),
        }),
      ).rejects.toThrow('outside this connection');
    }
    expect(scripts.run).not.toHaveBeenCalled();
  });

  it('reuses stored defaults and passes the connection restriction to saved execution', async () => {
    const { service, scripts } = setup();
    await service.call(connection, 'codebound_run_saved', {
      serverId: 's1',
      scriptId: 'script-1',
      revision: 1,
    });
    expect(scripts.run).toHaveBeenCalledWith(
      expect.anything(),
      'script-1',
      { input: { default: true }, revision: 1 },
      expect.any(Function),
      's1',
    );
  });
});
