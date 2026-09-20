import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import * as v8 from 'node:v8';
import { heapStatus, readHealthHeapPercent } from '../common/process-vitals';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { UsersService } from '../users/users.service';
import { DeploymentService } from '../common/deployment.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly deployment: DeploymentService,
  ) {}

  @Get('server-info')
  async getServerInfo() {
    const authMode = this.configService.get<string>('MCP_AUTH_MODE') || 'none';
    const serverUrl = this.configService.get<string>('SERVER_URL') || '';
    const userCount = await this.usersService.count();
    const allowOpen = this.configService.get<string>('ALLOW_OPEN_REGISTRATION') === 'true';

    // Sign-in buttons for the login page — SELF-HOST ONLY.
    //
    // This endpoint is unauthenticated. On a self-hosted instance there is
    // effectively one organization, so listing its providers is the expected
    // behaviour. In cloud it would be a workspace ENUMERATION oracle: anyone
    // could read off every customer's provider names and entry links. There,
    // users reach sign-in through the opaque /sso/<initiateId> link their
    // admin distributes, which is exactly why that id is opaque.
    const ssoProviders = this.deployment.isSelfHosted()
      ? (
          await this.prisma.identityProvider.findMany({
            where: { isActive: true },
            select: { name: true, type: true, initiateId: true },
            orderBy: { createdAt: 'asc' },
          })
        ).map((p) => ({ name: p.name, type: p.type, startUrl: `/sso/${p.initiateId}` }))
      : [];

    return {
      ssoProviders,
      mcpAuthMode: authMode,
      serverUrl,
      mcpEndpoint: '/mcp',
      deploymentMode: this.deployment.mode,
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
      () => this.checkHeap(),
    ]);
  }

  /**
   * The process itself, not just its dependencies.
   *
   * On 2026-09-20 this endpoint returned 200 for the whole of four declines
   * into heap exhaustion: Postgres was up, Redis was up, and the Node process
   * was spending 8 seconds per GC cycle recovering nothing. Docker's
   * healthcheck saw a healthy container right up to the abort. The numbers
   * are reported even when up, so a probe from outside can see the trend
   * without SSH.
   */
  private checkHeap(): HealthIndicatorResult {
    const sample = {
      heapUsed: process.memoryUsage().heapUsed,
      heapLimit: v8.getHeapStatistics().heap_size_limit,
    };
    const heap = heapStatus(sample, readHealthHeapPercent());
    const result: HealthIndicatorResult = { heap };
    if (heap.status === 'down') {
      throw new HealthCheckError(
        `heap at ${heap.percent}% of its ${heap.limitMb} MB limit`,
        result,
      );
    }
    return result;
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
