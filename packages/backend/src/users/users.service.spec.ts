import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let mockPrisma: any;
  let organizations: any;
  let lifecycle: any;
  let securityEvents: any;

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed',
    role: 'USER',
    mcpRoleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      organizationMember: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
      },
      userRoleAssignment: { deleteMany: jest.fn() },
      mcpApiKey: { deleteMany: jest.fn() },
      $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(mockPrisma))),
    };
    organizations = { assertNotLastAdmin: jest.fn() };
    lifecycle = { deactivateInOrganization: jest.fn(async () => ({ status: 'deactivated' })) };
    securityEvents = { log: jest.fn() };
    service = new UsersService(mockPrisma, organizations, lifecycle, securityEvents);
  });

  describe('findByEmail', () => {
    it('should call findUnique with email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const result = await service.findByEmail('test@example.com');
      expect(result).toBe(mockUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });

    it('should return null when not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.findByEmail('nobody@example.com');
      expect(result).toBeNull();
    });
  });

  describe('findById', () => {
    it('should call findUnique with id', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const result = await service.findById('user-1');
      expect(result).toBe(mockUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });
  });

  describe('create', () => {
    it('should call create with provided data', async () => {
      const data = {
        email: 'new@example.com',
        passwordHash: 'hash',
        name: 'New User',
        organizationId: 'org-1',
      };
      mockPrisma.user.create.mockResolvedValue({ ...mockUser, ...data });
      const result = await service.create(data);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({ data });
      expect(result.email).toBe('new@example.com');
    });
  });

  describe('count', () => {
    it('should return user count', async () => {
      mockPrisma.user.count.mockResolvedValue(5);
      const result = await service.count();
      expect(result).toBe(5);
    });
  });

  describe('findAll', () => {
    // The member list is the MEMBERSHIP table, not the users.organization_id
    // cache: a multi-workspace user must be visible to every workspace's
    // admins, and the role shown must be the one authorization uses.
    it('lists memberships of the organization with the membership role', async () => {
      mockPrisma.organizationMember.findMany.mockResolvedValue([
        {
          role: 'VIEWER',
          joinedAt: new Date('2026-01-01'),
          deactivatedAt: null,
          user: { id: 'u1', email: 'a@x', name: 'A', mcpRoleId: null, mcpRole: null, createdAt: new Date(), updatedAt: new Date() },
        },
        {
          role: 'ADMIN',
          joinedAt: new Date('2026-01-02'),
          deactivatedAt: new Date('2026-02-01'),
          user: { id: 'u2', email: 'b@x', name: 'B', mcpRoleId: null, mcpRole: null, createdAt: new Date(), updatedAt: new Date() },
        },
      ]);
      const rows = await service.findAll('org-1');
      expect(mockPrisma.organizationMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-1' } }),
      );
      expect(rows.map((r) => [r.id, r.role, r.active, r.organizationId])).toEqual([
        ['u1', 'VIEWER', true, 'org-1'],
        ['u2', 'ADMIN', false, 'org-1'],
      ]);
      expect(rows[1].deactivatedAt).toEqual(new Date('2026-02-01'));
    });
  });

  describe('deleteInOrg', () => {
    const ctx = { reason: 'admin' as const, actor: { type: 'USER' as const, userId: 'admin' } };

    it('returns false for a non-member and touches nothing', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);
      expect(await service.deleteInOrg('u1', 'org-1', ctx)).toBe(false);
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    });

    it('refuses to remove the last active admin', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ id: 'm1' });
      organizations.assertNotLastAdmin.mockRejectedValue(new Error('LAST_ADMIN'));
      await expect(service.deleteInOrg('u1', 'org-1', ctx)).rejects.toThrow('LAST_ADMIN');
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    });

    it('deletes the account only when this was the sole workspace', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ id: 'm1' });
      mockPrisma.organizationMember.count.mockResolvedValue(0);
      expect(await service.deleteInOrg('u1', 'org-1', ctx)).toBe(true);
      expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(lifecycle.deactivateInOrganization).not.toHaveBeenCalled();
    });

    // The admin of one workspace must not be able to destroy a person's access
    // to every other workspace they belong to.
    it('removes only this membership when the user belongs to other workspaces', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ id: 'm1' });
      mockPrisma.organizationMember.count.mockResolvedValue(2);
      expect(await service.deleteInOrg('u1', 'org-1', ctx)).toBe(true);
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
      expect(lifecycle.deactivateInOrganization).toHaveBeenCalledWith('u1', 'org-1', ctx);
      expect(mockPrisma.organizationMember.delete).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: 'u1', organizationId: 'org-1' } },
      });
      expect(mockPrisma.mcpApiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', organizationId: 'org-1' } });
      expect(securityEvents.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'MEMBERSHIP_REMOVED' }));
    });
  });

  describe('update', () => {
    it('should call update with userId and data', async () => {
      const data = { name: 'Updated' };
      mockPrisma.user.update.mockResolvedValue({ ...mockUser, ...data });
      const result = await service.update('user-1', data);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data,
      });
      expect(result.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('should call delete with userId', async () => {
      mockPrisma.user.delete.mockResolvedValue(mockUser);
      await service.delete('user-1');
      expect(mockPrisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });
  });
});
