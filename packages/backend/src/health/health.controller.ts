import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { UsersService } from '../users/users.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  @Get('server-info')
  async getServerInfo() {
    const authMode = this.configService.get<string>('MCP_AUTH_MODE') || 'none';
    const serverUrl = this.configService.get<string>('SERVER_URL') || '';
    const userCount = await this.usersService.count();
    const allowOpen = this.configService.get<string>('ALLOW_OPEN_REGISTRATION') === 'true';
    return {
      mcpAuthMode: authMode,
      serverUrl,
      mcpEndpoint: '/mcp',
      hasUsers: userCount > 0,
      registrationEnabled: userCount === 0 || allowOpen,
      oauthEndpoints: authMode === 'oauth2' || authMode === 'both'
        ? {
            wellKnown: '/.well-known/oauth-authorization-server',
            authorize: '/authorize',
            token: '/token',
            register: '/register',
          }
        : null,
    };
  }

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.checkDatabase(),
      () => this.checkRedis(),
    ]);
  }

  private async checkDatabase(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { database: { status: 'up' } };
    } catch {
      return { database: { status: 'down' } };
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    if (this.redis.isConnected) {
      return { redis: { status: 'up' } };
    }
    // Redis is optional — report as up with a message so the health check
    // does not fail when Redis is simply not configured.
    return { redis: { status: 'up', message: 'Not configured (optional)' } };
  }
}
