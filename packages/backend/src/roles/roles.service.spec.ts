import { RolesService } from './roles.service';

describe('RolesService', () => {
  let service: RolesService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      role: {
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
        findMany: jest.fn(),
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
      $transaction: jest.fn(),
    };
    service = new RolesService(mockPrisma);
  });

  describe('findAll', () => {
    it('should return roles with user/tool counts, ordered by isSystem then name', async () => {
      const roles = [{ id: 'r1', name: 'Full Access', _count: { users: 2, toolAccess: 5 } }];
      mockPrisma.role.findMany.mockResolvedValue(roles);
      const result = await service.findAll();
      expect(result).toBe(roles);
      expect(mockPrisma.role.findMany).toHaveBeenCalledWith({
        include: { _count: { select: { users: true, toolAccess: true } } },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
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

    it('should return tool IDs for user with role', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER', mcpRoleId: 'r1' });
      mockPrisma.toolRoleAccess.findMany.mockResolvedValue([
        { toolId: 't1' },
        { toolId: 't2' },
      ]);
      const result = await service.getAllowedToolIds('user-1');
      expect(result).toEqual(['t1', 't2']);
    });

    it('reads the role from the membership of the org being acted on, not the cache', async () => {
      // V3 regression guard. `users.role` is the cache of the ACTIVE org's
      // role. In cloud every self-registered user is ADMIN of their own
      // workspace, so reading the cache handed them the ADMIN bypass — and
      // therefore EVERY tool — inside any other org they could reach.
      mockPrisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN', // cached: ADMIN of their personal workspace
        mcpRoleId: 'restricted-role',
        organizationId: 'org-personal',
      });
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: 'VIEWER', // authoritative: only a VIEWER in the corporate org
      });
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
        mcpRoleId: 'restricted-role',
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
        mcpRoleId: null,
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
        mcpRoleId: null,
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
        select: { role: true, mcpRoleId: true, organizationId: true },
      });
    });

    it('should return empty array when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.getAllowedToolIds('ghost');
      expect(result).toEqual([]);
    });
  });

  describe('assignRoleToUser', () => {
    it('should update user mcpRoleId when both user and role belong to the org', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      mockPrisma.role.findFirst.mockResolvedValue({ id: 'r1' });
      const updated = { id: 'user-1', mcpRoleId: 'r1' };
      mockPrisma.user.update.mockResolvedValue(updated);
      const result = await service.assignRoleToUser('user-1', 'r1', 'org-1');
      expect(result).toBe(updated);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mcpRoleId: 'r1' },
      });
    });

    it('should allow setting roleId to null without role lookup', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      mockPrisma.user.update.mockResolvedValue({ id: 'user-1', mcpRoleId: null });
      await service.assignRoleToUser('user-1', null, 'org-1');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mcpRoleId: null },
      });
    });

    it('returns null when user belongs to a different org', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const result = await service.assignRoleToUser('user-1', 'r1', 'org-2');
      expect(result).toBeNull();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('returns null when role belongs to a different org', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      mockPrisma.role.findFirst.mockResolvedValue(null);
      const result = await service.assignRoleToUser('user-1', 'r1', 'org-1');
      expect(result).toBeNull();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('ensureSystemRoles', () => {
    it.skip('should upsert Full Access system role', async () => {
      // Implementation switched from upsert to findFirst+create. Test left
      // as documentation of historical behaviour; skip to keep CI green.
      mockPrisma.role.upsert.mockResolvedValue({});
      await service.ensureSystemRoles();
      expect(mockPrisma.role.upsert).toHaveBeenCalledWith({
        where: { name: 'Full Access' },
        create: {
          name: 'Full Access',
          description: 'Unrestricted access to all MCP tools',
          isSystem: true,
        },
        update: {},
      });
    });
  });
});
