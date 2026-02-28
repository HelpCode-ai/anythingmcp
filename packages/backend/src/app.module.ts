import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { McpModule, McpTransportType } from '@rekog/mcp-nest';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { McpServerModule } from './mcp-server/mcp-server.module';
import { AiModule } from './ai/ai.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { McpAuthMiddleware } from './auth/mcp-auth.middleware';
import { McpRateLimitMiddleware } from './auth/mcp-rate-limit.middleware';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(__dirname, '..', '..', '..', '.env'),
        '.env',
      ],
    }),

    // Database
    PrismaModule,

    // Cache
    RedisModule,

    // Rate limiting
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // MCP Server (dynamic tools registered by McpServerModule)
    McpModule.forRoot({
      name: 'anything-to-mcp',
      version: '0.1.0',
      transport: McpTransportType.STREAMABLE_HTTP,
      mcpEndpoint: '/mcp',
      streamableHttp: {
        enableJsonResponse: true,
      },
    }),

    // Core modules
    AuthModule,
    UsersModule,
    ConnectorsModule,
    McpServerModule,
    AiModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Auth first, then rate limiting for MCP endpoint
    consumer.apply(McpAuthMiddleware, McpRateLimitMiddleware).forRoutes('mcp');
  }
}
