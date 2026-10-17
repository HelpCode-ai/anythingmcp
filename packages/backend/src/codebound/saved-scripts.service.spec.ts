import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SavedScriptsService } from './saved-scripts.service';
import {
  RunSavedScriptDto,
  SaveScriptDto,
  UpdateScriptDto,
} from './codebound.dto';

describe('Saved Codebound scripts', () => {
  const caller = {
    sub: 'user-a',
    email: 'a@example.com',
    organizationId: 'org-a',
    role: 'EDITOR',
  };
  const dto: SaveScriptDto = {
    name: 'Post summary',
    description: 'A reusable script',
    mcpServerId: 'server-a',
    code: 'return input;',
    input: { limit: 1 },
    allowedTools: ['get_post'],
  };
  const script = {
    ...dto,
    id: 'script-a',
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function setup() {
    const prisma = {
      mcpServerConfig: {
        findFirst: jest.fn().mockResolvedValue({ id: 'server-a' }),
      },
      codeboundScript: {
        findFirst: jest.fn().mockResolvedValue(script),
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ ...script, revision: 2 }),
        findMany: jest.fn().mockResolvedValue([script]),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue(script),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (work) =>
      typeof work === 'function' ? work(prisma) : Promise.all(work),
    );
    const runner = { run: jest.fn().mockResolvedValue({ result: 42 }) };
    const license = {
      checkLicenseActive: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new SavedScriptsService(
      prisma as any,
      runner as any,
      license as any,
      audit as any,
    );
    return { prisma, runner, license, audit, service };
  }

  it('saves only explicitly accepted fields in the authenticated workspace', async () => {
    const { service, prisma, audit } = setup();
    await service.create(caller, {
      ...dto,
      name: ' Post summary ',
      organizationId: 'org-b',
    } as SaveScriptDto);
    expect(prisma.codeboundScript.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ...dto, organizationId: 'org-a' },
      }),
    );
    expect(prisma.mcpServerConfig.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'server-a', organizationId: 'org-a', isActive: true },
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CODEBOUND_SCRIPT_CREATED',
        organizationId: 'org-a',
        actorUserId: 'user-a',
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('return input');
  });

  it('lists summaries with bounded pagination and a tenant-scoped count', async () => {
    const { service, prisma } = setup();
    expect(await service.list(caller, {})).toEqual({
      items: [script],
      total: 1,
    });
    expect(prisma.codeboundScript.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a' },
        skip: 0,
        take: 20,
      }),
    );
    expect(
      prisma.codeboundScript.findMany.mock.calls[0][0].select.code,
    ).toBeUndefined();
    expect(prisma.codeboundScript.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-a' },
    });
  });

  it('does not open a guessed script from another tenant', async () => {
    const { service, prisma } = setup();
    prisma.codeboundScript.findFirst.mockResolvedValue(null);
    await expect(service.get(caller, 'other-id')).rejects.toThrow(
      'Script not found',
    );
    expect(prisma.codeboundScript.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other-id', organizationId: 'org-a' },
      }),
    );
  });

  it.each(['create', 'update', 'delete'] as const)(
    'denies viewer %s before touching storage',
    async (operation) => {
      const { service, prisma } = setup();
      const viewer = { ...caller, role: 'VIEWER' };
      const action =
        operation === 'create'
          ? service.create(viewer, dto)
          : operation === 'update'
            ? service.update(viewer, 'script-a', { ...dto, revision: 1 })
            : service.delete(viewer, 'script-a');
      await expect(action).rejects.toThrow('editor or administrator');
      expect(prisma.codeboundScript.findFirst).not.toHaveBeenCalled();
      expect(prisma.codeboundScript.create).not.toHaveBeenCalled();
      expect(prisma.codeboundScript.updateMany).not.toHaveBeenCalled();
      expect(prisma.codeboundScript.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('refuses an inactive or foreign server without writing', async () => {
    const { service, prisma } = setup();
    prisma.mcpServerConfig.findFirst.mockResolvedValue(null);
    await expect(service.create(caller, dto)).rejects.toThrow(
      'Active MCP server not found',
    );
    expect(prisma.codeboundScript.create).not.toHaveBeenCalled();
  });

  it('updates atomically at the reviewed revision', async () => {
    const { service, prisma } = setup();
    expect(
      (await service.update(caller, 'script-a', { ...dto, revision: 1 }))
        .revision,
    ).toBe(2);
    expect(prisma.codeboundScript.updateMany).toHaveBeenCalledWith({
      where: { id: 'script-a', organizationId: 'org-a', revision: 1 },
      data: { ...dto, revision: { increment: 1 } },
    });
    expect(prisma.codeboundScript.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'script-a', organizationId: 'org-a' },
      }),
    );
  });

  it('rejects stale writes without returning another revision as a successful save', async () => {
    const { service, prisma } = setup();
    prisma.codeboundScript.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(caller, 'script-a', { ...dto, revision: 1 }),
    ).rejects.toThrow('Reopen it before saving');
    expect(prisma.codeboundScript.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('returns not found when a script disappears during an update', async () => {
    const { service, prisma } = setup();
    prisma.codeboundScript.updateMany.mockResolvedValue({ count: 0 });
    prisma.codeboundScript.findFirst
      .mockResolvedValueOnce(script)
      .mockResolvedValueOnce(null);
    await expect(
      service.update(caller, 'script-a', { ...dto, revision: 1 }),
    ).rejects.toThrow('Script not found');
  });

  it('scopes deletion by organization and makes a repeated delete fail', async () => {
    const { service, prisma, audit } = setup();
    expect(await service.delete(caller, 'script-a')).toEqual({ deleted: true });
    expect(prisma.codeboundScript.deleteMany).toHaveBeenCalledWith({
      where: { id: 'script-a', organizationId: 'org-a' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CODEBOUND_SCRIPT_DELETED' }),
    );
    prisma.codeboundScript.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.delete(caller, 'script-a')).rejects.toThrow(
      'Script not found',
    );
  });

  it('runs stored source and capabilities with current caller identity and per-run input', async () => {
    const { service, runner } = setup();
    const viewer = { ...caller, role: 'VIEWER' };
    await service.run(viewer, script.id, { input: { limit: 2 }, revision: 1 });
    expect(runner.run).toHaveBeenCalledWith(
      viewer,
      'server-a',
      {
        code: dto.code,
        input: { limit: 2 },
        allowedTools: dto.allowedTools,
      },
      { id: script.id, revision: 1 },
    );
  });

  it('rejects changed saved source before execution', async () => {
    const { service, runner } = setup();
    await expect(
      service.run(caller, script.id, { input: {}, revision: 5 }),
    ).rejects.toThrow('Reopen it before running');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('preserves connector authorization failures from the runner', async () => {
    const { service, runner } = setup();
    runner.run.mockRejectedValue(new Error('Tool access denied'));
    await expect(
      service.run(caller, script.id, { input: {}, revision: 1 }),
    ).rejects.toThrow('Tool access denied');
  });

  it('rejects oversized default parameters and an inactive license', async () => {
    const { service, prisma, license } = setup();
    await expect(
      service.create(caller, { ...dto, input: { value: 'é'.repeat(40000) } }),
    ).rejects.toThrow('64 KiB');
    expect(prisma.codeboundScript.create).not.toHaveBeenCalled();
    license.checkLicenseActive.mockRejectedValue(new Error('License inactive'));
    await expect(service.create(caller, dto)).rejects.toThrow(
      'License inactive',
    );
  });

  it('validates save/update/run DTOs and rejects source overrides on saved execution', async () => {
    expect(await validate(plainToInstance(SaveScriptDto, dto))).toEqual([]);
    expect(
      (await validate(plainToInstance(UpdateScriptDto, dto))).map(
        (error) => error.property,
      ),
    ).toContain('revision');
    const whitespace = plainToInstance(SaveScriptDto, { ...dto, name: '  ' });
    expect(
      (await validate(whitespace)).map((error) => error.property),
    ).toContain('name');
    const override = plainToInstance(RunSavedScriptDto, {
      input: {},
      revision: 1,
      code: 'return 999;',
    });
    expect(
      (
        await validate(override, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property),
    ).toContain('code');
  });
});
