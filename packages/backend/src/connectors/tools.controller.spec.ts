import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

function buildController(overrides: { prisma?: any; connectorsService?: any; mcpServer?: any } = {}) {
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
  const controller = new ToolsController(prisma as any, mcpServer as any, connectorsService as any);
  return { controller, prisma, connectorsService, mcpServer };
}

const req = (role = 'ADMIN') => ({ user: { sub: 'u1', organizationId: 'org1', role } });

describe('ToolsController — response mapping validation', () => {
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
