import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { User, UserRole } from '../generated/prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async create(data: {
    email: string;
    passwordHash: string;
    name: string;
    role?: UserRole;
    organizationId: string;
  }): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async count(): Promise<number> {
    return this.prisma.user.count();
  }

  async findAll(organizationId?: string) {
    return this.prisma.user.findMany({
      where: organizationId ? { organizationId } : undefined,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        organizationId: true,
        mcpRoleId: true,
        mcpRole: { select: { id: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async update(userId: string, data: Partial<User>): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async delete(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } });
  }

  async findAllInvitations(organizationId?: string) {
    return this.prisma.invitationToken.findMany({
      where: { usedAt: null, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteInvitation(id: string): Promise<void> {
    await this.prisma.invitationToken.delete({ where: { id } });
  }
}
