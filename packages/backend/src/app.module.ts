import { Module, MiddlewareConsumer, NestModule, Logger, ClassSerializerInterceptor } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  McpModule,
  McpTransportType,
  McpAuthModule,
  McpAuthJwtGuard,
} from '@rekog/mcp-nest';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { McpServerModule } from './mcp-server/mcp-server.module';
import { AiModule } from './ai/ai.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { SettingsModule } from './settings/settings.module';
import { RolesModule } from './roles/roles.module';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { McpAuthMiddleware } from './auth/mcp-auth.middleware';
import { McpRateLimitMiddleware } from './auth/mcp-rate-limit.middleware';
import { ClientCredentialsMiddleware } from './auth/client-credentials.middleware';
import { LocalOAuthProvider } from './auth/local-oauth.provider';
import { PrismaOAuthStore } from './auth/prisma-oauth.store';
import { PrismaService } from './common/prisma.service';
import { OAuthUrlRewriteInterceptor } from './auth/oauth-url-rewrite.interceptor';

// Determine auth mode from env
const authMode = process.env.MCP_AUTH_MODE || 'none';
const useOAuth = authMode === 'oauth2' || authMode === 'both';

// Build module imports conditionally
const conditionalImports: any[] = [];

if (useOAuth) {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:4000';
  const jwtSecret =
    process.env.JWT_SECRET || 'dev-secret-change-me-at-least-32chars!!';

  conditionalImports.push(
    McpAuthModule.forRoot({
      provider: LocalOAuthProvider,
      clientId: 'local',
      clientSecret: 'local',
      jwtSecret,
      serverUrl,
      resource: `${serverUrl}/mcp`,
      storeConfiguration: {
        type: 'custom' as const,
        store: new PrismaOAuthStore(new PrismaService()),
      },
      authorizationServerMetadata: {
        grantTypesSupported: [
          'authorization_code',
          'refresh_token',
          'client_credentials',
        ],
      },
    }),
  );
}

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
      ...(useOAuth ? { guards: [McpAuthJwtGuard] } : {}),
      streamableHttp: {
        enableJsonResponse: true,
      },
    }),

    // OAuth2 module (conditionally loaded)
    ...conditionalImports,

    // Core modules
    AuthModule,
    UsersModule,
    ConnectorsModule,
    McpServerModule,
    AiModule,
    AuditModule,
    HealthModule,
    SettingsModule,
    RolesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    ...(useOAuth
      ? [{ provide: APP_INTERCEPTOR, useClass: OAuthUrlRewriteInterceptor }]
      : []),
  ],
})
export class AppModule implements NestModule {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly configService: ConfigService) {}

  configure(consumer: MiddlewareConsumer) {
    const mode = this.configService.get<string>('MCP_AUTH_MODE') || 'none';
    this.logger.log(`MCP Auth Mode: ${mode}`);

    // Apply client credentials middleware on /token for OAuth2 mode
    if (mode === 'oauth2' || mode === 'both') {
      consumer
        .apply(ClientCredentialsMiddleware)
        .forRoutes('token');
    }

    // Apply legacy auth middleware for MCP endpoint
    if (mode === 'legacy' || mode === 'both') {
      consumer
        .apply(McpAuthMiddleware, McpRateLimitMiddleware)
        .forRoutes('mcp');
    } else if (mode === 'none') {
      // No auth — only rate limiting
      consumer.apply(McpRateLimitMiddleware).forRoutes('mcp');
    }
    // For 'oauth2' mode: McpAuthJwtGuard handles auth (applied by McpAuthModule)
  }
}
