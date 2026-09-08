import { RolesService } from './roles.service';

describe('RolesService', () => {
  let service: RolesService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      role: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      toolRoleAccess: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
      mcpTool: {
        count: jest.fn(),
      },
      organizationMember: {
        findUnique: jest.fn(),
      },
      userRoleAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      // setUserRoles uses the callback form; run it against the same mock.
      $transaction: jest.fn((arg: any) =>
        typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg),
      ),
    };
    service = new RolesService(mockPrisma);
  });

  describe('findAll', () => {
    it('counts DISTINCT users per role, not assignment rows', async () => {
      // user_roles is unique on (user, role, SOURCE), so one person holding a
      // role both manually and through an IdP sync would otherwise count twice.
      mockPrisma.role.findMany.mockResolvedValue([
        { id: 'r1', name: 'Full Access', _count: { toolAccess: 5 } },
        { id: 'r2', name: 'Viewer', _count: { toolAccess: 1 } },
      ]);
      mockPrisma.userRoleAssignment.findMany.mockResolvedValue([
        { roleId: 'r1', userId: 'u1' },
        { roleId: 'r1', userId: 'u1' }, // same person, second source
        { roleId: 'r1', userId: 'u2' },
      ]);

      const result = await service.findAll();

      expect(result[0]._count.users).toBe(2);
      expect(result[0]._count.toolAccess).toBe(5);
      expect(result[1]._count.users).toBe(0);
    });
  });

  describe('findById', () => {
    it('should return role with tool access and user count', async () => {
      const role = { id: 'r1', name: 'Editor', toolAccess: [], _count: { users: 1 } };
      mockPrisma.role.findUnique.mockResolvedValue(role);
      const result = await service.findById('r1');
      expect(result).toBe(role);
      expect(mockPrisma.role.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'r1' } }),
      );
    });
  });

  describe('create', () => {
    it('should create role with name and description', async () => {
      const created = { id: 'r2', name: 'Viewer', description: 'Read only' };
      mockPrisma.role.create.mockResolvedValue(created);
      const result = await service.create({ name: 'Viewer', description: 'Read only' });
      expect(result).toBe(created);
      expect(mockPrisma.role.create).toHaveBeenCalledWith({
        data: { name: 'Viewer', description: 'Read only' },
      });
    });
  });

  describe('update', () => {
    it('should update role fields scoped to organization', async () => {
      mockPrisma.role.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const updated = { id: 'r1', name: 'New Name' };
      mockPrisma.role.findUnique.mockResolvedValue(updated);
      const result = await service.update('r1', 'org-1', { name: 'New Name' });
      expect(result).toBe(updated);
      expect(mockPrisma.role.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', organizationId: 'org-1' },
        data: { name: 'New Name' },
      });
    });

    it('returns null when role does not belong to organization', async () => {
      mockPrisma.role.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const result = await service.update('r1', 'org-2', { name: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should unassign users then delete role when org matches', async () => {
      mockPrisma.role.findFirst.mockResolvedValue({ id: 'r1' });
      mockPrisma.user.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.role.delete.mockResolvedValue({});
      const ok = await service.delete('r1', 'org-1');
      expect(ok).toBe(true);
      expect(mockPrisma.role.findFirst).toHaveBeenCalledWith({
        where: { id: 'r1', organizationId: 'org-1' },
        select: { id: true },
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { mcpRoleId: 'r1' },
        data: { mcpRoleId: null },
      });
      expect(mockPrisma.role.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    });

    it('returns false when role is not in the organization', async () => {
      mockPrisma.role.findFirst.mockResolvedValue(null);
      const ok = await service.delete('r1', 'org-2');
      expect(ok).toBe(false);
      expect(mockPrisma.role.delete).not.toHaveBeenCalled();
    });
  });

  describe('getToolAccess', () => {
    it('should return tool access for a role', async () => {
      const access = [{ roleId: 'r1', toolId: 't1', tool: { id: 't1', name: 'tool1' } }];
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue(access);
      const result = await service.getToolAccess('r1');
      expect(result).toBe(access);
    });
  });

  describe('setToolAccess', () => {
    it('should call $transaction with delete + create operations after validating org-ownership of tools', async () => {
      mockPrisma.mcpTool = { count: jest.fn().mockResolvedValue(2) } as any;
      mockPrisma.toolRoleAccess.deleteMany.mockReturnValue('delete-op');
      mockPrisma.toolRoleAccess.create
        .mockReturnValueOnce('create-op-1')
        .mockReturnValueOnce('create-op-2');
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.setToolAccess('r1', ['t1', 't2'], 'org-1');

      expect(mockPrisma.mcpTool.count).toHaveBeenCalledWith({
        where: {
          id: { in: ['t1', 't2'] },
          connector: { organizationId: 'org-1' },
        },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledWith([
        'delete-op',
        'create-op-1',
        'create-op-2',
      ]);
    });

    it('rejects when toolIds contain ids from another organization', async () => {
      mockPrisma.mcpTool = { count: jest.fn().mockResolvedValue(1) } as any;
      await expect(
        service.setToolAccess('r1', ['t1', 't2'], 'org-1'),
      ).rejects.toThrow('not in this organization');
    });
  });

  describe('addToolAccess', () => {
    it('should upsert tool access with compound key', async () => {
      const access = { roleId: 'r1', toolId: 't1' };
      mockPrisma.toolRoleAccess.upsert.mockResolvedValue(access);
      const result = await service.addToolAccess('r1', 't1');
      expect(result).toBe(access);
      expect(mockPrisma.toolRoleAccess.upsert).toHaveBeenCalledWith({
        where: { roleId_toolId: { roleId: 'r1', toolId: 't1' } },
        create: { roleId: 'r1', toolId: 't1' },
        update: {},
      });
    });
  });

  describe('removeToolAccess', () => {
    it('should delete matching tool access', async () => {
      mockPrisma.toolRoleAccess.deleteMany.mockResolvedValue({ count: 1 });
      await service.removeToolAccess('r1', 't1');
      expect(mockPrisma.toolRoleAccess.deleteMany).toHaveBeenCalledWith({
        where: { roleId: 'r1', toolId: 't1' },
      });
    });
  });

  describe('getAllowedToolIds', () => {
    it('should return null for ADMIN users (unrestricted)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', mcpRoleId: null });
      const result = await service.getAllowedToolIds('user-1');
      expect(result).toBeNull();
    });

    it('should return null when user has no mcpRoleId (backward compat)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER', mcpRoleId: null });
      const result = await service.getAllowedToolIds('user-1');
      expect(result).toBeNull();
    });

    it('returns the UNION of every assigned role, deduplicated', async () => {
      // The core new behaviour: being in more groups can only widen access.
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'EDITOR',
        organizationId: 'org-1',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR' });
      mockPrisma.userRoleAssignment.findMany.mockResolvedValue([
        { roleId: 'sales' },
        { roleId: 'support' },
        { roleId: 'sales' }, // duplicate source rows collapse
      ]);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([
        { toolId: 't1' },
        { toolId: 't2' },
        { toolId: 't1' }, // overlapping whitelists collapse
      ]);

      const result = await service.getAllowedToolIds('user-1', 'org-1');

      expect(mockPrisma.toolRoleAccess.findMany).toHaveBeenCalledWith({
        where: { roleId: { in: ['sales', 'support'] } },
        select: { toolId: true },
      });
      expect(result).toEqual(['t1', 't2']);
    });

    it('a role granting nothing does not shrink the union', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'EDITOR',
        organizationId: 'org-1',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR' });
      mockPrisma.userRoleAssignment.findMany.mockResolvedValue([
        { roleId: 'empty' },
        { roleId: 'sales' },
      ]);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([{ toolId: 't1' }]);

      expect(await service.getAllowedToolIds('user-1', 'org-1')).toEqual(['t1']);
    });

    it('applies grants with no organization in every org', async () => {
      // That is how a grant of an isSystem role behaves.
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'EDITOR',
        organizationId: 'org-1',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR' });
      mockPrisma.userRoleAssignment.findMany.mockResolvedValue([{ roleId: 'sys' }]);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([{ toolId: 't9' }]);

      await service.getAllowedToolIds('user-1', 'org-1');

      expect(mockPrisma.userRoleAssignment.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          OR: [{ organizationId: 'org-1' }, { organizationId: null }],
        },
        select: { roleId: true },
      });
    });


    it('reads the role from the membership of the org being acted on, not the cache', async () => {
      // V3 regression guard. `users.role` is the cache of the ACTIVE org's
      // role. In cloud every self-registered user is ADMIN of their own
      // workspace, so reading the cache handed them the ADMIN bypass — and
      // therefore EVERY tool — inside any other org they could reach.
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN', // cached: ADMIN of their personal workspace
        organizationId: 'org-personal',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: 'VIEWER', // authoritative: only a VIEWER in the corporate org
      });
      mockPrisma.userRoleAssignment.findMany.mockResolvedValue([
        { roleId: 'restricted-role' },
      ]);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([{ toolId: 't1' }]);

      const result = await service.getAllowedToolIds('user-1', 'org-corporate');

      expect(mockPrisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: {
          userId_organizationId: {
            userId: 'user-1',
            organizationId: 'org-corporate',
          },
        },
        select: { role: true },
      });
      // Restricted to the role's whitelist — NOT null/unrestricted.
      expect(result).toEqual(['t1']);
    });

    it('grants the ADMIN bypass only to an ADMIN of that same org', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'VIEWER',
        organizationId: 'org-a',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: 'ADMIN',
      });

      expect(await service.getAllowedToolIds('user-1', 'org-a')).toBeNull();
    });

    it('fails closed when the user is not a member of the org', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        organizationId: 'org-personal',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);

      // Not null (unrestricted) and not the ADMIN bypass — no tools at all.
      expect(await service.getAllowedToolIds('user-1', 'org-other')).toEqual([]);
    });

    it('falls back to the cached role when no org can be resolved', async () => {
      // Self-host / instance-level path: no org context anywhere.
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        organizationId: null,
      });

      expect(await service.getAllowedToolIds('user-1')).toBeNull();
      expect(mockPrisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });

    it('never falls back to an email lookup', async () => {
      // SECURITY regression guard. The old implementation retried
      // `findUnique({ where: { email: userId } })` when the id lookup missed,
      // which made a mutable, IdP-supplied email a key for TOOL authorization:
      // a token bearing a victim's address inherited the victim's grants.
      // An email-shaped principal must now simply fail closed.
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.getAllowedToolIds('victim@example.com');

      expect(result).toEqual([]);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'victim@example.com' },
        select: { role: true, organizationId: true },
      });
    });

    it('should return empty array when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.getAllowedToolIds('ghost');
      expect(result).toEqual([]);
    });
  });

  describe('setUserRoles', () => {
    const memberOf = (org = 'org-1') =>
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ userId: 'user-1' });

    it('replaces the manual grants and leaves IdP-derived ones alone', async () => {
      // An admin editing roles by hand must never silently undo what a group
      // mapping granted — and vice versa. Hence the source-scoped delete.
      memberOf();
      mockPrisma.role.count.mockResolvedValue(2);

      const result = await service.setUserRoles('user-1', ['r1', 'r2'], 'org-1');

      expect(mockPrisma.userRoleAssignment.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', organizationId: 'org-1', source: 'manual' },
      });
      expect(mockPrisma.userRoleAssignment.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 'user-1', roleId: 'r1', organizationId: 'org-1', source: 'manual' },
          { userId: 'user-1', roleId: 'r2', organizationId: 'org-1', source: 'manual' },
        ],
        skipDuplicates: true,
      });
      expect(result).toEqual({ userId: 'user-1', roleIds: ['r1', 'r2'] });
    });

    it('deduplicates the requested ids', async () => {
      memberOf();
      mockPrisma.role.count.mockResolvedValue(1);

      const result = await service.setUserRoles('user-1', ['r1', 'r1'], 'org-1');

      expect(result).toEqual({ userId: 'user-1', roleIds: ['r1'] });
      expect(mockPrisma.role.count).toHaveBeenCalledWith({
        where: { id: { in: ['r1'] }, OR: [{ organizationId: 'org-1' }, { isSystem: true }] },
      });
    });

    it('clears the manual grants on an empty array without touching roles', async () => {
      memberOf();

      const result = await service.setUserRoles('user-1', [], 'org-1');

      expect(mockPrisma.role.count).not.toHaveBeenCalled();
      expect(mockPrisma.userRoleAssignment.createMany).not.toHaveBeenCalled();
      expect(result).toEqual({ userId: 'user-1', roleIds: [] });
    });

    it('keeps the deprecated scalar in step for rollback safety', async () => {
      memberOf();
      mockPrisma.role.count.mockResolvedValue(2);

      await service.setUserRoles('user-1', ['r1', 'r2'], 'org-1');

      // Lossy by definition — one of N — but a rollback to the previous
      // release must still see a sensible value.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mcpRoleId: 'r1' },
      });
    });

    it('checks membership, not the cached active org', async () => {
      // users.organizationId is only the ACTIVE org, so using it would make a
      // multi-org user editable or not depending on what they are looking at.
      memberOf();
      mockPrisma.role.count.mockResolvedValue(1);

      await service.setUserRoles('user-1', ['r1'], 'org-1');

      expect(mockPrisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: 'user-1', organizationId: 'org-1' } },
        select: { userId: true },
      });
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns null when the user is not a member of the org', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);

      expect(await service.setUserRoles('user-1', ['r1'], 'org-2')).toBeNull();
      expect(mockPrisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('returns null when any role is not visible to the org', async () => {
      memberOf();
      mockPrisma.role.count.mockResolvedValue(1); // asked for 2, only 1 valid

      expect(await service.setUserRoles('user-1', ['r1', 'foreign'], 'org-1')).toBeNull();
      expect(mockPrisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('assignRoleToUser (deprecated adapter)', () => {
    it('delegates a single role to setUserRoles', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ userId: 'user-1' });
      mockPrisma.role.count.mockResolvedValue(1);

      const result = await service.assignRoleToUser('user-1', 'r1', 'org-1');

      expect(result).toEqual({ userId: 'user-1', roleIds: ['r1'] });
    });

    it('maps a null roleId to an empty set', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ userId: 'user-1' });

      const result = await service.assignRoleToUser('user-1', null, 'org-1');

      expect(result).toEqual({ userId: 'user-1', roleIds: [] });
      expect(mockPrisma.role.count).not.toHaveBeenCalled();
    });

    it('returns null when the user is not in the org', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);
      expect(await service.assignRoleToUser('user-1', 'r1', 'org-2')).toBeNull();
    });
  });

  describe('empty-role safety', () => {
    it('warns when a user is given a role that grants no tools', async () => {
      // An empty whitelist denies EVERYTHING rather than allowing everything,
      // which reads backwards — so it must not happen silently.
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ userId: 'user-1' });
      mockPrisma.role.count.mockResolvedValue(2);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([{ roleId: 'has-tools' }]);

      await service.setUserRoles('user-1', ['has-tools', 'empty'], 'org-1');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty'));
      warn.mockRestore();
    });

    it('stays quiet when every assigned role grants something', async () => {
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ userId: 'user-1' });
      mockPrisma.role.count.mockResolvedValue(1);
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([{ roleId: 'r1' }]);

      await service.setUserRoles('user-1', ['r1'], 'org-1');

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('setToolAccess on system roles', () => {
    it('refuses, matching updateRole and deleteRole', async () => {
      // System roles are global and visible to every org; without this any org
      // admin could rewrite a whitelist every other organization shares.
      mockPrisma.role.findUnique.mockResolvedValue({ isSystem: true });

      await expect(service.setToolAccess('sys', ['t1'], 'org-1')).rejects.toThrow(
        'system role',
      );
    });
  });
});
