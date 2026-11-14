import { RolesService } from './roles.service';
import { RolesController, SetToolRateLimitsDto } from './roles.controller';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('role/tool rate-limit policy', () => {
  let prisma: any;
  let roles: RolesService;
  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org' }) },
      organizationMember: { findUnique: jest.fn().mockResolvedValue({ role: 'EDITOR', deactivatedAt: null }) },
      userRoleAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      toolRoleAccess: {
        findFirst: jest.fn().mockResolvedValue({ id: 'configured' }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    roles = new RolesService(prisma);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('coalesces first probes and skips membership/grant reads in an unconfigured workspace', async () => {
    prisma.toolRoleAccess.findFirst.mockResolvedValue(null);
    expect(await Promise.all(Array.from({ length: 50 }, (_, i) =>
      roles.getToolRateLimits(`user-${i}`, 'org', `tool-${i}`))))
      .toEqual(Array(50).fill(null));
    await roles.getToolRateLimits('another-user', 'org', 'another-tool');
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledWith({
      where: {
        tool: { connector: { organizationId: 'org' } },
        role: { OR: [{ organizationId: 'org' }, { isSystem: true }] },
        OR: [{ callsPerMinute: { not: null } }, { callsPerHour: { not: null } }],
      },
      select: { id: true },
    });
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.toolRoleAccess.findMany).not.toHaveBeenCalled();
  });

  it('invalidates a cached absence immediately after setting a limit', async () => {
    prisma.toolRoleAccess.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'configured' });
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    await roles.setToolRateLimits('role', 'tool', 'org', { callsPerMinute: 7 });
    prisma.toolRoleAccess.findMany.mockResolvedValue([{ callsPerMinute: 7, callsPerHour: null }]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: 7, callsPerHour: null });
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
  });

  it('observes limits configured by another replica after the five-second presence TTL', async () => {
    jest.useFakeTimers(); jest.setSystemTime(0);
    prisma.toolRoleAccess.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'configured' });
    prisma.toolRoleAccess.findMany.mockResolvedValue([{ callsPerMinute: 3, callsPerHour: null }]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    jest.setSystemTime(4_999);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    jest.setSystemTime(5_000);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: 3, callsPerHour: null });
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
  });

  it('isolates presence flags between workspaces', async () => {
    prisma.toolRoleAccess.findFirst.mockImplementation(async (query: any) =>
      query.where.tool.connector.organizationId === 'limited' ? { id: 'configured' } : null);
    prisma.toolRoleAccess.findMany.mockResolvedValue([{ callsPerMinute: 3, callsPerHour: null }]);
    expect(await roles.getToolRateLimits('u', 'unlimited', 'tool')).toBeNull();
    expect(await roles.getToolRateLimits('u', 'limited', 'tool')).toEqual({ callsPerMinute: 3, callsPerHour: null });
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledTimes(1);
    expect(await roles.getToolRateLimits('u', 'unlimited', 'tool')).toBeNull();
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
  });

  it('does not cache probe failures', async () => {
    prisma.toolRoleAccess.findFirst.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(null);
    await expect(roles.getToolRateLimits('u', 'org', 'tool')).rejects.toThrow('unavailable');
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
  });

  it('does not let an old in-flight absence repopulate the cache after invalidation', async () => {
    let finishOldProbe!: (row: null) => void;
    prisma.toolRoleAccess.findFirst.mockReturnValueOnce(new Promise((resolve) => { finishOldProbe = resolve; }))
      .mockResolvedValue({ id: 'configured' });
    prisma.toolRoleAccess.findMany.mockResolvedValue([{ callsPerMinute: 3, callsPerHour: null }]);
    const oldRead = roles.getToolRateLimits('u', 'org', 'tool');
    await roles.setToolRateLimits('role', 'tool', 'org', { callsPerMinute: 3 });
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: 3, callsPerHour: null });
    finishOldProbe(null);
    expect(await oldRead).toBeNull();
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: 3, callsPerHour: null });
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
  });

  it('bounds presence-cache storage, evicting only a flag and rechecking the database', async () => {
    jest.useFakeTimers(); jest.setSystemTime(0);
    prisma.toolRoleAccess.findFirst.mockResolvedValue(null);
    for (let i = 0; i <= 1_000; i++) await roles.getToolRateLimits('u', `org-${i}`, 'tool');
    await roles.getToolRateLimits('u', 'org-0', 'tool');
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(1_002);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('refreshes presence after revoking a grant through the legacy helper', async () => {
    prisma.toolRoleAccess.findMany.mockResolvedValue([{ callsPerMinute: 3, callsPerHour: null }]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).not.toBeNull();
    await roles.removeToolAccess('role', 'tool');
    prisma.toolRoleAccess.findFirst.mockResolvedValue(null);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    expect(prisma.toolRoleAccess.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.toolRoleAccess.findMany).toHaveBeenCalledTimes(1);
  });

  it('combines granting roles independently per window, even if neither role grants that pair', async () => {
    prisma.toolRoleAccess.findMany.mockResolvedValue([
      { callsPerMinute: 100, callsPerHour: 200 },
      { callsPerMinute: 10, callsPerHour: 10_000 },
    ]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: 100, callsPerHour: 10_000 });
    expect(prisma.toolRoleAccess.findMany).toHaveBeenCalledWith({
      where: {
        toolId: 'tool', tool: { connector: { organizationId: 'org' } },
        role: {
          OR: [{ organizationId: 'org' }, { isSystem: true }],
          assignments: { some: { userId: 'u', OR: [{ organizationId: 'org' }, { organizationId: null }] } },
        },
      },
      select: { callsPerMinute: true, callsPerHour: true },
    });
  });

  it('treats null as unlimited in that window only', async () => {
    prisma.toolRoleAccess.findMany.mockResolvedValue([
      { callsPerMinute: null, callsPerHour: 20 },
      { callsPerMinute: 10, callsPerHour: 10 },
    ]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: null, callsPerHour: 20 });
    prisma.toolRoleAccess.findMany.mockResolvedValue([
      { callsPerMinute: 10, callsPerHour: 20 },
      { callsPerMinute: null, callsPerHour: null },
    ]);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toEqual({ callsPerMinute: null, callsPerHour: null });
  });

  it('gives an org ADMIN no per-tool policy, even when they hold limited MCP roles', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
    expect(await roles.getAllowedToolIds('u', 'org')).toBeNull();
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    expect(prisma.toolRoleAccess.findMany).not.toHaveBeenCalled();
  });

  it('gives an unrestricted member with no roles in an org without whitelists no per-tool policy', async () => {
    prisma.toolRoleAccess.findFirst.mockResolvedValue(null);
    expect(await roles.getAllowedToolIds('u', 'org')).toBeNull();
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
  });

  it.each([null, { role: 'EDITOR', deactivatedAt: new Date() }])('does not read grants for an inactive/non-member (%p)', async (membership) => {
    prisma.organizationMember.findUnique.mockResolvedValue(membership);
    expect(await roles.getToolRateLimits('u', 'org', 'tool')).toBeNull();
    expect(prisma.toolRoleAccess.findMany).not.toHaveBeenCalled();
  });

  it('updates only an existing org-owned grant and preserves omitted windows', async () => {
    await roles.setToolRateLimits('role', 'tool', 'org', { callsPerMinute: null });
    expect(prisma.toolRoleAccess.updateMany).toHaveBeenCalledWith({
      where: {
        roleId: 'role', toolId: 'tool', role: { organizationId: 'org', isSystem: false },
        tool: { connector: { organizationId: 'org' } },
      },
      data: { callsPerMinute: null },
    });
  });

  it('returns 404 instead of creating a grant for a foreign or unassigned tool', async () => {
    prisma.toolRoleAccess.updateMany.mockResolvedValue({ count: 0 });
    await expect(roles.setToolRateLimits('role', 'tool', 'org', { callsPerHour: 10 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('rate-limit configuration API', () => {
  it.each([0, -1, 1.2, '10', true, 2147483648])('rejects an invalid limit (%p)', async (value) => {
    for (const field of ['callsPerMinute', 'callsPerHour']) {
      const dto = plainToInstance(SetToolRateLimitsDto, { [field]: value });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  it.each([{}, { callsPerMinute: null, callsPerHour: 2147483647 }, { callsPerMinute: 1, callsPerHour: null }])('accepts valid values, explicit null and omission (%p)', async (data) => {
    expect(await validate(plainToInstance(SetToolRateLimitsDto, data))).toHaveLength(0);
  });

  it('scopes a configuration request to the authenticated workspace', async () => {
    const service = {
      findByIdForOrg: jest.fn().mockResolvedValue({ isSystem: false }),
      setToolRateLimits: jest.fn(),
    };
    const controller = new RolesController(service as any);
    await controller.setToolRateLimits({ user: { organizationId: 'org' } }, 'role', 'tool', { callsPerMinute: 5 });
    expect(service.findByIdForOrg).toHaveBeenCalledWith('role', 'org');
    expect(service.setToolRateLimits).toHaveBeenCalledWith('role', 'tool', 'org', { callsPerMinute: 5 });
  });

  it.each([[null, 404], [{ isSystem: true }, 403]])('refuses foreign/missing roles and system roles', async (role, status) => {
    const service = { findByIdForOrg: jest.fn().mockResolvedValue(role), setToolRateLimits: jest.fn() };
    const controller = new RolesController(service as any);
    await expect(controller.setToolRateLimits({ user: { organizationId: 'org' } }, 'role', 'tool', {}))
      .rejects.toMatchObject({ status });
    expect(service.setToolRateLimits).not.toHaveBeenCalled();
  });
});
