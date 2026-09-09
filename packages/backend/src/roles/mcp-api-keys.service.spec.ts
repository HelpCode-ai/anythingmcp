import { McpApiKeysService } from './mcp-api-keys.service';

describe('McpApiKeysService', () => {
  let service: McpApiKeysService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      mcpApiKey: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
      organizationMember: {
        findUnique: jest.fn().mockResolvedValue({ deactivatedAt: null }),
      },
    };
    service = new McpApiKeysService(mockPrisma);
  });

  describe('generate', () => {
    it('should create key with mcp_ prefix and 64 hex chars', async () => {
      mockPrisma.mcpApiKey.create.mockImplementation((args: any) => {
        return Promise.resolve({
          id: 'key-1',
          key: args.data.key,
          name: args.data.name,
          isActive: true,
          mcpServerId: args.data.mcpServerId,
          createdAt: new Date(),
        });
      });

      const result = await service.generate('user-1', 'org-1', 'My Key');
      expect(result.key).toMatch(/^mcp_[0-9a-f]{64}$/);
      expect(result.name).toBe('My Key');
    });

    it('should pass mcpServerId as null when not provided', async () => {
      mockPrisma.mcpApiKey.create.mockImplementation((args: any) =>
        Promise.resolve({ id: 'key-1', key: args.data.key, mcpServerId: args.data.mcpServerId }),
      );

      const result = await service.generate('user-1', 'org-1', 'Key');
      expect(result.mcpServerId).toBeNull();
    });

    it('should pass mcpServerId when provided', async () => {
      mockPrisma.mcpApiKey.create.mockImplementation((args: any) =>
        Promise.resolve({ id: 'key-1', key: args.data.key, mcpServerId: args.data.mcpServerId }),
      );

      const result = await service.generate('user-1', 'org-1', 'Key', 'server-1');
      expect(result.mcpServerId).toBe('server-1');
    });
  });

  describe('listByUser', () => {
    it('should return keys for user ordered by createdAt desc', async () => {
      const keys = [{ id: 'k1', name: 'Key 1' }];
      mockPrisma.mcpApiKey.findMany.mockResolvedValue(keys);
      const result = await service.listByUser('user-1');
      expect(result).toBe(keys);
      expect(mockPrisma.mcpApiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  describe('revoke', () => {
    it('should set isActive to false for matching id and userId', async () => {
      mockPrisma.mcpApiKey.updateMany.mockResolvedValue({ count: 1 });
      await service.revoke('key-1', 'user-1');
      expect(mockPrisma.mcpApiKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'key-1', userId: 'user-1' },
        data: { isActive: false },
      });
    });
  });

  describe('deleteKey', () => {
    it('should delete key matching id and userId', async () => {
      mockPrisma.mcpApiKey.deleteMany.mockResolvedValue({ count: 1 });
      await service.deleteKey('key-1', 'user-1');
      expect(mockPrisma.mcpApiKey.deleteMany).toHaveBeenCalledWith({
        where: { id: 'key-1', userId: 'user-1' },
      });
    });
  });

  describe('resolveUserByKey', () => {
    it('should return user data with mcpServerId when key is active', async () => {
      const record = {
        id: 'key-1',
        isActive: true,
        mcpServerId: 'srv-1',
        name: 'My Key',
        user: { id: 'u1', email: 'a@b.com', role: 'USER', mcpRoleId: 'r1' },
      };
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(record);
      mockPrisma.mcpApiKey.update.mockResolvedValue({});

      const result = await service.resolveUserByKey('mcp_abc');
      expect(result).toEqual({
        id: 'u1',
        email: 'a@b.com',
        role: 'USER',
        mcpRoleId: 'r1',
        mcpServerId: 'srv-1',
        apiKeyName: 'My Key',
      });
    });

    it('should return null when key is inactive', async () => {
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isActive: false,
        user: { id: 'u1' },
      });
      const result = await service.resolveUserByKey('mcp_abc');
      expect(result).toBeNull();
    });

    it('should return null when key not found', async () => {
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(null);
      const result = await service.resolveUserByKey('mcp_invalid');
      expect(result).toBeNull();
    });

    it('should not throw if lastUsedAt update fails', async () => {
      const record = {
        id: 'key-1',
        isActive: true,
        mcpServerId: null,
        name: 'Key',
        user: { id: 'u1', email: 'a@b.com', role: 'USER', mcpRoleId: null },
      };
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(record);
      mockPrisma.mcpApiKey.update.mockRejectedValue(new Error('DB error'));

      const result = await service.resolveUserByKey('mcp_abc');
      expect(result).toBeDefined();
      expect(result!.id).toBe('u1');
    });
  });

  describe('resolveUserByKey — membership guard', () => {
    const record = {
      id: 'k1', key: 'mcp_x', isActive: true, userId: 'u1', organizationId: 'org-1', name: 'n', mcpServerId: null,
      user: { id: 'u1', email: 'a@x', role: 'VIEWER', organizationId: 'org-1', mcpRoleId: null },
    };

    it('resolves a key whose owner is an active member', async () => {
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(record);
      mockPrisma.mcpApiKey.update.mockResolvedValue({});
      expect(await service.resolveUserByKey('mcp_x')).toMatchObject({ id: 'u1' });
      expect(mockPrisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: 'u1', organizationId: 'org-1' } },
        select: { deactivatedAt: true },
      });
    });

    // Defence in depth: even a key row that escaped deactivation must not
    // authenticate a member who was deactivated in the key's organization.
    it('refuses a key whose owner is deactivated in that organization', async () => {
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(record);
      mockPrisma.organizationMember.findUnique.mockResolvedValue({ deactivatedAt: new Date() });
      expect(await service.resolveUserByKey('mcp_x')).toBeNull();
    });

    it('refuses a key whose owner is no longer a member', async () => {
      mockPrisma.mcpApiKey.findUnique.mockResolvedValue(record);
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);
      expect(await service.resolveUserByKey('mcp_x')).toBeNull();
    });
  });
});
