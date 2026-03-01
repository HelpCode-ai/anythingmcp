import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { User, UserRole } from '@prisma/client';

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
  }): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async count(): Promise<number> {
    return this.prisma.user.count();
  }

  async findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        aiProvider: true,
        aiModel: true,
        aiApiKey: true,
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

  async updateAiConfig(
    userId: string,
    provider: string,
    apiKey: string,
    model?: string,
  ): Promise<User> {
    const data: Record<string, string> = {
      aiProvider: provider,
      aiApiKey: apiKey,
    };
    if (model) {
      data.aiModel = model;
    }
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async delete(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
