import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let mockPrisma: any;

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
    };
    service = new UsersService(mockPrisma);
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
    it('should call findMany with correct select fields', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      await service.findAll();
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          mcpRoleId: true,
          mcpRole: { select: { id: true, name: true } },
          createdAt: true,
          updatedAt: true,
        },
      });
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
