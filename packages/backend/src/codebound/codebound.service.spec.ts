import { CodeboundService } from './codebound.service';
import { RegisteredTool } from '../mcp-server/tool-registry';
import { validate } from 'class-validator';
import { RunScriptDto } from './codebound.dto';

describe('Codebound authorization and execution', () => {
  const caller = {
    sub: 'user-a',
    email: 'a@example.com',
    organizationId: 'org-a',
  };
  const tool = {
    id: 'tool-a',
    name: 'setup_demo_get_post',
    connectorId: 'connector-a',
    organizationId: 'org-a',
    connectorType: 'REST',
    description: 'Demo post',
    parameters: { type: 'object', properties: {} },
    endpointMapping: { method: 'GET', path: '/posts/1' },
    connectorConfig: { baseUrl: 'https://example.com', authType: 'NONE' },
  } as RegisteredTool;

  function setup() {
    const prisma = {
      mcpServerConfig: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ connectors: [{ connectorId: 'connector-a' }] }),
      },
    };
    const roles = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
    const registry = { getAllTools: jest.fn().mockReturnValue([tool]) };
    const executor = {
      executeTool: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"raw":"should not be used"}' }],
        structured: { id: 1, title: 'Filtered', body: 'Data stays inside run' },
      }),
    };
    const license = {
      checkLicenseActive: jest.fn().mockResolvedValue(undefined),
    };
    const security = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new CodeboundService(
      prisma as any,
      roles as any,
      registry as any,
      executor as any,
      license as any,
      security as any,
    );
    const dto = {
      code: 'const p = await tools.call("setup_demo_get_post", {}); return {id: p.id, title: p.title};',
      input: {},
      allowedTools: [tool.name],
    };
    return {
      service,
      prisma,
      roles,
      registry,
      executor,
      license,
      security,
      dto,
    };
  }

  it('passes trusted identity to the executor and uses its filtered structured result', async () => {
    const { service, executor, security, prisma, dto } = setup();
    const result = await service.run(caller, 'server-a', dto);
    expect(result.result).toEqual({ id: 1, title: 'Filtered' });
    expect(prisma.mcpServerConfig.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'server-a', organizationId: 'org-a', isActive: true },
      }),
    );
    expect(executor.executeTool).toHaveBeenCalledWith(
      tool.name,
      {},
      expect.objectContaining({
        userId: 'user-a',
        organizationId: 'org-a',
        connectorIds: ['connector-a'],
        mcpServerId: 'server-a',
        skipCache: true,
        intent: `Codebound run ${result.runId}`,
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CODEBOUND_RUN',
        metadata: expect.objectContaining({
          runId: result.runId,
          status: 'SUCCESS',
          calls: 1,
        }),
      }),
    );
    expect(JSON.stringify(security.log.mock.calls)).not.toContain('Filtered');
  });

  it('does not return connector credentials in tool discovery', async () => {
    const { service, registry } = setup();
    registry.getAllTools.mockReturnValue([
      {
        ...tool,
        connectorConfig: {
          ...tool.connectorConfig,
          envVars: { API_KEY: 'sensitive' },
        },
      },
    ]);
    expect(
      JSON.stringify(await service.listTools(caller, 'server-a')),
    ).not.toContain('sensitive');
  });

  it('refuses a guessed server in another workspace', async () => {
    const { service, prisma, executor, dto } = setup();
    prisma.mcpServerConfig.findFirst.mockResolvedValue(null);
    await expect(service.run(caller, 'server-b', dto)).rejects.toThrow(
      'not found',
    );
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'role', 'assignment', 'write', 'not-ready', 'allowlist'])(
    'blocks %s violations before dispatch',
    async (reason) => {
      const { service, roles, registry, executor, dto } = setup();
      if (reason === 'tenant')
        registry.getAllTools.mockReturnValue([
          { ...tool, organizationId: 'org-b' },
        ]);
      if (reason === 'role') roles.getAllowedToolIds.mockResolvedValue([]);
      if (reason === 'assignment')
        registry.getAllTools.mockReturnValue([
          { ...tool, connectorId: 'connector-b' },
        ]);
      if (reason === 'write')
        registry.getAllTools.mockReturnValue([
          {
            ...tool,
            endpointMapping: { method: 'POST' },
            annotations: { readOnlyHint: true },
          },
        ]);
      if (reason === 'not-ready')
        registry.getAllTools.mockReturnValue([
          { ...tool, setupStatus: 'needs_authorization' },
        ]);
      if (reason === 'allowlist') dto.allowedTools = [];
      await expect(service.run(caller, 'server-a', dto)).rejects.toThrow();
      expect(executor.executeTool).not.toHaveBeenCalled();
    },
  );

  it('rechecks roles after each nested call', async () => {
    const { service, roles, executor, dto } = setup();
    roles.getAllowedToolIds
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue([]);
    dto.code =
      'await tools.call("setup_demo_get_post", {}); return await tools.call("setup_demo_get_post", {});';
    await expect(service.run(caller, 'server-a', dto)).rejects.toThrow(
      'access is denied',
    );
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid tool parameters before dispatch', async () => {
    const { service, registry, executor, dto } = setup();
    registry.getAllTools.mockReturnValue([
      {
        ...tool,
        parameters: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
      },
    ]);
    await expect(service.run(caller, 'server-a', dto)).rejects.toThrow(
      'input schema',
    );
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('keeps the existing license gate', async () => {
    const { service, license, executor, dto } = setup();
    license.checkLicenseActive.mockRejectedValue(new Error('License inactive'));
    await expect(service.run(caller, 'server-a', dto)).rejects.toThrow(
      'License inactive',
    );
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('does not disclose connector error payloads', async () => {
    const { service, executor, dto } = setup();
    executor.executeTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'secret' }],
    } as any);
    await expect(service.run(caller, 'server-a', dto)).rejects.toThrow(
      'Connector call failed.',
    );
  });

  it('limits simultaneous runs per workspace and recovers after errors', async () => {
    const { service, dto } = setup();
    const first = service.run(caller, 'server-a', {
      ...dto,
      code: 'throw new Error("test");',
    });
    await expect(service.run(caller, 'server-a', dto)).rejects.toThrow('busy');
    await expect(first).rejects.toThrow('test');
    expect((await service.run(caller, 'server-a', dto)).result).toEqual({
      id: 1,
      title: 'Filtered',
    });
  });

  it('validates the HTTP request shape with DTO decorators', async () => {
    const valid = Object.assign(new RunScriptDto(), {
      code: 'return input;',
      input: {},
      allowedTools: [],
    });
    expect(await validate(valid)).toEqual([]);
    const invalid = Object.assign(new RunScriptDto(), {
      code: '',
      input: [],
      allowedTools: ['a', 'a'],
    });
    expect(
      (await validate(invalid)).map((error) => error.property).sort(),
    ).toEqual(['allowedTools', 'code', 'input']);
  });
});
