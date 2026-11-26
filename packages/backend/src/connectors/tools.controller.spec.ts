import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ToolsController } from './tools.controller';

const RAW = {
  pageDetails: { count: 1, totalCount: 812 },
  devices: [{ id: 1, hostname: 'PC-01', deviceType: { category: 'Desktop' }, udf: { u1: 'x' } }],
};

const TRANSFORM = {
  select: {
    total: '$.pageDetails.totalCount',
    devices: { $from: '$.devices[*]', $select: { hostname: 'hostname' } },
  },
};

const MAPPED = { total: 812, devices: [{ hostname: 'PC-01' }] };

function buildController(
  overrides: {
    prisma?: any;
    connectorsService?: any;
    mcpServer?: any;
    edition?: any;
    licenseGuard?: any;
    toolExecutor?: any;
    roles?: any;
  } = {},
) {
  const prisma = overrides.prisma ?? {
    mcpTool: {
      create: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn().mockResolvedValue({ id: 't1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 't1', responseMapping: null }),
      findUnique: jest.fn().mockResolvedValue({ id: 't1' }),
    },
    toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const connectorsService = overrides.connectorsService ?? {
    findById: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'org1', userId: 'u1', type: 'REST' }),
    executeConnectorCall: jest.fn().mockResolvedValue(RAW),
  };
  const mcpServer = overrides.mcpServer ?? {
    reloadConnectorTools: jest.fn().mockResolvedValue(undefined),
  };
  const edition = (overrides as { edition?: any }).edition ?? {
    assertEnterprise: jest.fn().mockResolvedValue(undefined),
  };
  const licenseGuard = (overrides as { licenseGuard?: any }).licenseGuard ?? {
    checkCanCreateCodeTool: jest.fn().mockResolvedValue(undefined),
  };
  const toolExecutor = (overrides as { toolExecutor?: any }).toolExecutor ?? {
    runSavedCodeTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }),
  };
  const controller = new ToolsController(
    prisma as any,
    mcpServer as any,
    connectorsService as any,
    edition as any,
    licenseGuard as any,
    toolExecutor as any,
    undefined,
    overrides.roles,
  );
  return { controller, prisma, connectorsService, mcpServer, edition, licenseGuard, toolExecutor };
}

const req = (role = 'ADMIN') => ({ user: { sub: 'u1', organizationId: 'org1', role } });

describe('ToolsController — response mapping validation', () => {
  it('rejects an unknown renderer before storing the tool', async () => {
    const { controller, prisma } = buildController();
    await expect(controller.create(req(), 'c1', {
      name: 'preview', description: 'Preview', parameters: {},
      endpointMapping: { method: 'GET', path: '/x' }, responseMapping: { render: 'browser' },
    } as any)).rejects.toThrow('render must be onenote-page');
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed transform on create instead of degrading at call time', async () => {
    const { controller, prisma } = buildController();
    await expect(
      controller.create(req(), 'c1', {
        name: 't',
        description: 'd',
        parameters: {},
        endpointMapping: { method: 'GET', path: '/x' },
        responseMapping: { transform: { select: { a: 'bad[' } } },
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('accepts a well-formed transform', async () => {
    const { controller, prisma } = buildController();
    await controller.create(req(), 'c1', {
      name: 't',
      description: 'd',
      parameters: {},
      endpointMapping: { method: 'GET', path: '/x' },
      responseMapping: { transform: TRANSFORM },
    } as any);
    expect(prisma.mcpTool.create).toHaveBeenCalled();
  });

  it('rejects a malformed transform on update', async () => {
    const { controller, prisma } = buildController();
    await expect(
      controller.update(req(), 't1', 'c1', {
        responseMapping: { transform: { mode: 'jmespath', expression: '((((' } },
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.mcpTool.updateMany).not.toHaveBeenCalled();
  });

  it('drops a stale outputSchema when the transform changes', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: { select: { a: 'a' } } } });
    await controller.update(req(), 't1', 'c1', { responseMapping: { transform: TRANSFORM } } as any);
    expect(prisma.mcpTool.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outputSchema: null }) }),
    );
  });

  it('keeps the outputSchema when the transform is unchanged', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    await controller.update(req(), 't1', 'c1', {
      responseMapping: { transform: TRANSFORM, cacheTtl: 60 },
    } as any);
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data.outputSchema).toBeUndefined();
  });

  it('drops a stale outputSchema when a renderer is enabled', async () => {
    const { controller, prisma } = buildController();
    await controller.update(req(), 't1', 'c1', { responseMapping: { render: 'onenote-page' } } as any);
    expect(prisma.mcpTool.updateMany.mock.calls[0][0].data.outputSchema).toBeNull();
  });
});

describe('ToolsController — PATCH response-mapping', () => {
  it('stores the transform while preserving cacheTtl and followUp', async () => {
    const { controller, prisma, mcpServer } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({
      responseMapping: { cacheTtl: 300, followUp: 'then call X' },
    });

    const res = await controller.setResponseMapping(req(), 't1', 'c1', { transform: TRANSFORM });

    expect(res).toEqual({ transform: TRANSFORM, active: true });
    expect(prisma.mcpTool.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          responseMapping: { cacheTtl: 300, followUp: 'then call X', transform: TRANSFORM },
        }),
      }),
    );
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
  });

  it('clears the transform on null and keeps the other keys', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({
      responseMapping: { cacheTtl: 300, transform: TRANSFORM },
    });

    const res = await controller.setResponseMapping(req(), 't1', 'c1', { transform: null });

    expect(res).toEqual({ transform: null, active: false });
    expect(prisma.mcpTool.updateMany.mock.calls[0][0].data.responseMapping).toEqual({ cacheTtl: 300 });
  });

  it('rejects a malformed transform', async () => {
    const { controller } = buildController();
    await expect(
      controller.setResponseMapping(req(), 't1', 'c1', { transform: { select: { a: 'a[' } } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a tool that does not belong to the connector', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue(null);
    await expect(
      controller.setResponseMapping(req(), 't1', 'c1', { transform: TRANSFORM }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a VIEWER', async () => {
    const { controller } = buildController();
    await expect(
      controller.setResponseMapping(req('VIEWER'), 't1', 'c1', { transform: TRANSFORM }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ToolsController — preview-mapping', () => {
  it('maps an explicit sample without calling the upstream API', async () => {
    const { controller, connectorsService } = buildController();
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      transform: TRANSFORM,
      sample: RAW,
    });

    expect(connectorsService.executeConnectorCall).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.sampleSource).toBe('body');
    expect(res.mapped).toEqual(MAPPED);
    expect(res.mappingApplied).toBe(true);
    expect(res.rawBytes).toBeGreaterThan(res.mappedBytes);
    expect(res.bytesSavedPct).toBeGreaterThan(0);
  });

  it('falls back to the most recent recorded response', async () => {
    const { controller, prisma } = buildController();
    prisma.toolInvocation.findMany.mockResolvedValue([
      { output: null, createdAt: new Date('2026-07-30') },
      { output: RAW, createdAt: new Date('2026-07-29') },
    ]);

    const res: any = await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM });

    expect(res.ok).toBe(true);
    expect(res.sampleSource).toBe('last-invocation');
    expect(res.raw).toEqual(RAW);
    expect(res.mapped).toEqual(MAPPED);
  });

  it('explains what to do when there is no sample at all', async () => {
    const { controller } = buildController();
    const res: any = await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM });
    expect(res.ok).toBe(false);
    expect(res.sampleSource).toBe('none');
    expect(res.error).toMatch(/Run the tool once/);
  });

  it('previews the stored mapping when no transform is supplied', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', { sample: RAW });
    expect(res.mapped).toEqual(MAPPED);
  });

  it('previews "no mapping" for an explicit null', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findFirst.mockResolvedValue({ responseMapping: { transform: TRANSFORM } });
    const res: any = await controller.previewMapping(req(), 't1', 'c1', {
      transform: null,
      sample: RAW,
    });
    expect(res.mappingApplied).toBe(false);
    expect(res.mapped).toEqual(RAW);
  });

  it('rejects a malformed transform', async () => {
    const { controller } = buildController();
    await expect(
      controller.previewMapping(req(), 't1', 'c1', { transform: { select: { a: 'a[' } }, sample: RAW }),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores nothing', async () => {
    const { controller, prisma } = buildController();
    await controller.previewMapping(req(), 't1', 'c1', { transform: TRANSFORM, sample: RAW });
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
    expect(prisma.mcpTool.updateMany).not.toHaveBeenCalled();
  });
});

describe('ToolsController — test endpoint', () => {
  const tool = (responseMapping?: unknown) => ({
    id: 't1',
    connectorId: 'c1',
    outputSchema: { type: 'object', properties: { pageDetails: {} } },
    endpointMapping: { method: 'GET', path: '/devices' },
    responseMapping,
    connector: { id: 'c1', authType: 'NONE', type: 'REST' },
  });

  it('keeps `result` raw and adds the mapped view', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool({ transform: TRANSFORM }));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.ok).toBe(true);
    expect(res.result).toEqual(RAW); // unchanged for existing API consumers
    expect(res.mapped).toEqual(MAPPED);
    expect(res.mappingApplied).toBe(true);
    expect(res.bytesSavedPct).toBeGreaterThan(0);
  });

  it('passes rendering to the engine and returns tile metadata without picture bytes', async () => {
    const { controller, prisma, connectorsService } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool({ render: 'onenote-page' }));
    connectorsService.executeConnectorCall.mockResolvedValue({
      __amcpOneNotePage: 1, text: 'Notes', width: 20, height: 30, warnings: [],
      tiles: [{ x: 0, y: 0, width: 20, height: 30, bytes: 7, data: 'picture-bytes' }],
    });
    const result: any = await controller.testTool('c1', 't1', req(), {});
    expect(connectorsService.executeConnectorCall.mock.calls[0][5]).toMatchObject({ responseMapping: { render: 'onenote-page' } });
    expect(result.ok).toBe(true);
    expect(result.result.tiles[0]).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain('picture-bytes');
  });

  it('reports mappingApplied=false and mapped=raw for a tool without a mapping', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool(undefined));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.mappingApplied).toBe(false);
    expect(res.mapped).toEqual(RAW);
    expect(res.rawBytes).toBe(res.mappedBytes);
    expect(res.bytesSavedPct).toBe(0);
  });

  it('previews an unsaved transform passed in the body without persisting it', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool(undefined));

    const res: any = await controller.testTool('c1', 't1', req(), { transform: TRANSFORM });

    expect(res.mapped).toEqual(MAPPED);
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
  });

  it('reports a broken mapping instead of hiding it', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue(tool({ transform: { select: { a: 'a[' } } }));

    const res: any = await controller.testTool('c1', 't1', req(), {});

    expect(res.ok).toBe(true);
    expect(res.mappingApplied).toBe(false);
    expect(res.mappingError).toMatch(/Unclosed/);
  });

  it('infers the output schema from the mapped shape when a mapping is active', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.findUnique.mockResolvedValue({ ...tool({ transform: TRANSFORM }), outputSchema: null });

    await controller.testTool('c1', 't1', req(), {});

    const inferred = prisma.mcpTool.update.mock.calls[0][0].data.outputSchema;
    expect(Object.keys(inferred.properties).sort()).toEqual(['devices', 'total']);
  });
});

describe('ToolsController — duplicate tool names', () => {
  const unique = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const dto = { name: 'get_orders', description: 'd', parameters: {}, endpointMapping: { method: 'GET', path: '/orders' } } as any;

  it('answers 409 with the name when a tool of that name already exists', async () => {
    const { controller, prisma, mcpServer } = buildController();
    prisma.mcpTool.create.mockRejectedValueOnce(unique());
    const err = await controller.create(req(), 'c1', dto).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('"get_orders" already exists');
    expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
  });

  it('answers 409 when a rename collides with another tool', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.updateMany.mockRejectedValueOnce(unique());
    await expect(controller.update(req(), 't1', 'c1', { name: 'get_orders' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('still lets any other database error through', async () => {
    const { controller, prisma } = buildController();
    prisma.mcpTool.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.create(req(), 'c1', dto)).rejects.toThrow('connection lost');
  });
});

describe('ToolsController — code tools', () => {
  const codePrisma = () => ({
    mcpTool: {
      create: jest.fn().mockResolvedValue({ id: 'code-1' }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'code-1', responseMapping: null }),
      findUnique: jest.fn().mockResolvedValue({ id: 'code-1' }),
    },
    connector: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }]) },
    toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
  });
  const codeDto = (over: Record<string, unknown> = {}) => ({
    name: 'summary',
    description: 'code tool',
    parameters: { type: 'object', properties: {} },
    endpointMapping: { method: 'code', code: 'return 1;', uses: [{ connectorId: 'c1' }], runAs: 'invoker', allowWrites: false, ...over },
  });

  it('creates a valid code tool and enforces the plan cap', async () => {
    const { controller, prisma, licenseGuard } = buildController({ prisma: codePrisma() });
    await controller.create(req('ADMIN'), 'c1', codeDto() as any);
    expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1');
    const data = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(data.endpointMapping.method).toBe('code');
  });

  it('rejects definer rights for a non-admin', async () => {
    const connectorsService = {
      findById: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'org1', userId: 'u1', type: 'REST' }),
      executeConnectorCall: jest.fn(),
    };
    const { controller } = buildController({ prisma: codePrisma(), connectorsService });
    await expect(controller.create(req('EDITOR'), 'c1', codeDto({ runAs: 'definer' }) as any)).rejects.toThrow(/admin/i);
  });

  it('requires Enterprise for a write-capable code tool', async () => {
    const edition = { assertEnterprise: jest.fn().mockRejectedValue(new ForbiddenException('nope')) };
    const { controller } = buildController({ prisma: codePrisma(), edition });
    await expect(controller.create(req('ADMIN'), 'c1', codeDto({ allowWrites: true }) as any)).rejects.toThrow();
    expect(edition.assertEnterprise).toHaveBeenCalled();
  });

  it('rejects a uses connector from another workspace', async () => {
    const prisma = codePrisma();
    prisma.connector.findMany = jest.fn().mockResolvedValue([]); // none belong to the org
    const { controller } = buildController({ prisma });
    await expect(controller.create(req('ADMIN'), 'c1', codeDto({ uses: [{ connectorId: 'foreign' }] }) as any)).rejects.toThrow(/own workspace/);
  });

  it('rejects an empty program', async () => {
    const { controller } = buildController({ prisma: codePrisma() });
    await expect(controller.create(req('ADMIN'), 'c1', codeDto({ code: '  ' }) as any)).rejects.toThrow(/non-empty/);
  });

  describe('bulk create', () => {
    const plainDto = { name: 'get_orders', description: 'd', parameters: {}, endpointMapping: { method: 'GET', path: '/orders' } };

    it('refuses a code tool whose uses names a connector of another workspace, and stores nothing', async () => {
      const prisma = codePrisma();
      prisma.connector.findMany = jest.fn().mockResolvedValue([]);
      const { controller, mcpServer } = buildController({ prisma });
      const err = await controller
        .bulkCreate(req('ADMIN'), 'c1', { tools: [plainDto, codeDto({ uses: [{ connectorId: 'foreign' }] })] } as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/^tools\[1\]: .*own workspace/);
      expect(prisma.connector.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['foreign'] }, organizationId: 'org1' },
        select: { id: true },
      });
      expect(prisma.mcpTool.create).not.toHaveBeenCalled();
      expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
    });

    it('refuses definer rights for a non-admin owner', async () => {
      const { controller, prisma } = buildController({ prisma: codePrisma() });
      await expect(
        controller.bulkCreate(req('EDITOR'), 'c1', { tools: [codeDto({ runAs: 'definer' })] } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    });

    it('applies the plan cap to the code tools of the batch', async () => {
      const licenseGuard = { checkCanCreateCodeTool: jest.fn().mockRejectedValue(new ForbiddenException('Plan limit reached')) };
      const { controller, prisma } = buildController({ prisma: codePrisma(), licenseGuard });
      await expect(
        controller.bulkCreate(req('ADMIN'), 'c1', { tools: [codeDto(), codeDto({ code: 'return 2;' }), plainDto] } as any),
      ).rejects.toThrow(/Plan limit/);
      expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1', 2);
      expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    });

    it('creates same-workspace code tools and plain tools as before', async () => {
      const { controller, prisma, licenseGuard } = buildController({ prisma: codePrisma() });
      const res: any = await controller.bulkCreate(req('ADMIN'), 'c1', { tools: [plainDto, codeDto()] } as any);
      expect(prisma.mcpTool.create).toHaveBeenCalledTimes(2);
      expect(prisma.mcpTool.create.mock.calls[1][0].data.endpointMapping).toEqual(codeDto().endpointMapping);
      expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1', 1);
      expect(res.message).toBe('Created 2 tools');
    });

    it('does not call the plan cap for a batch without code tools', async () => {
      const { controller, licenseGuard } = buildController({ prisma: codePrisma() });
      await controller.bulkCreate(req('ADMIN'), 'c1', { tools: [plainDto] } as any);
      expect(licenseGuard.checkCanCreateCodeTool).not.toHaveBeenCalled();
    });
  });

  describe('test run of a saved code tool', () => {
    const storedCodeTool = () => ({
      id: 'code-1',
      name: 'summary',
      connectorId: 'c1',
      endpointMapping: codeDto().endpointMapping,
      connector: { id: 'c1', type: 'REST', organizationId: 'org1' },
    });
    const withStoredTool = () => {
      const prisma = codePrisma();
      prisma.mcpTool.findUnique = jest.fn().mockResolvedValue(storedCodeTool());
      return prisma;
    };

    it('runs unrestricted for an admin', async () => {
      const roles = { getAllowedToolIds: jest.fn() };
      const { controller, toolExecutor } = buildController({ prisma: withStoredTool(), roles });
      await controller.testTool('c1', 'code-1', req('ADMIN') as any, {} as any);
      expect(toolExecutor.runSavedCodeTool.mock.calls[0][2].allowedToolIds).toBeNull();
      expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
    });

    it('runs with the roles of a connector owner who is not an admin', async () => {
      const roles = { getAllowedToolIds: jest.fn().mockResolvedValue(['t-allowed']) };
      const { controller, toolExecutor } = buildController({ prisma: withStoredTool(), roles });
      await controller.testTool('c1', 'code-1', req('EDITOR') as any, {} as any);
      expect(roles.getAllowedToolIds).toHaveBeenCalledWith('u1', 'org1');
      expect(toolExecutor.runSavedCodeTool.mock.calls[0][2].allowedToolIds).toEqual(['t-allowed']);
    });

    it('reaches no inner tool for a non-admin when roles cannot be read', async () => {
      const { controller, toolExecutor } = buildController({ prisma: withStoredTool() });
      await controller.testTool('c1', 'code-1', req('EDITOR') as any, {} as any);
      expect(toolExecutor.runSavedCodeTool.mock.calls[0][2].allowedToolIds).toEqual([]);
    });
  });
});
