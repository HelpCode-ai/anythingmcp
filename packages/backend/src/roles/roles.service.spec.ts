import { RolesService } from './roles.service';

describe('RolesService', () => {
  let service: RolesService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      role: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      toolRoleAccess: {
        findMany: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
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
    it('should update role fields', async () => {
      const updated = { id: 'r1', name: 'New Name' };
      mockPrisma.role.update.mockResolvedValue(updated);
      const result = await service.update('r1', { name: 'New Name' });
      expect(result).toBe(updated);
      expect(mockPrisma.role.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { name: 'New Name' },
      });
    });
  });

  describe('delete', () => {
    it('should unassign users then delete role', async () => {
      mockPrisma.user.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.role.delete.mockResolvedValue({});
      await service.delete('r1');
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { mcpRoleId: 'r1' },
        data: { mcpRoleId: null },
      });
      expect(mockPrisma.role.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
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
    it('should call $transaction with delete + create operations', async () => {
      mockPrisma.toolRoleAccess.deleteMany.mockReturnValue('delete-op');
      mockPrisma.toolRoleAccess.create
        .mockReturnValueOnce('create-op-1')
        .mockReturnValueOnce('create-op-2');
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.setToolAccess('r1', ['t1', 't2']);

      expect(mockPrisma.$transaction).toHaveBeenCalledWith([
        'delete-op',
        'create-op-1',
        'create-op-2',
      ]);
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

    it('should fall back to email lookup when id lookup fails', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ role: 'ADMIN', mcpRoleId: null });
      const result = await service.getAllowedToolIds('user@example.com');
      expect(result).toBeNull();
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(mockPrisma.user.findUnique).toHaveBeenLastCalledWith({
        where: { email: 'user@example.com' },
        select: { role: true, mcpRoleId: true },
      });
    });

    it('should return empty array when user not found', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const result = await service.getAllowedToolIds('ghost');
      expect(result).toEqual([]);
    });
  });

  describe('assignRoleToUser', () => {
    it('should update user mcpRoleId', async () => {
      const updated = { id: 'user-1', mcpRoleId: 'r1' };
      mockPrisma.user.update.mockResolvedValue(updated);
      const result = await service.assignRoleToUser('user-1', 'r1');
      expect(result).toBe(updated);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mcpRoleId: 'r1' },
      });
    });

    it('should allow setting roleId to null', async () => {
      mockPrisma.user.update.mockResolvedValue({ id: 'user-1', mcpRoleId: null });
      await service.assignRoleToUser('user-1', null);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mcpRoleId: null },
      });
    });
  });

  describe('ensureSystemRoles', () => {
    it('should upsert Full Access system role', async () => {
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
