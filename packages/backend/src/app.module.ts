import { Module, MiddlewareConsumer, NestModule, Logger, ClassSerializerInterceptor } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { MCP_STRATEGY } from '@rekog/mcp-nest';
import { McpAuthModule } from '@rekog/mcp-nest-auth';
import { mcpStrategy } from './mcp-server/mcp-strategy';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { McpServerModule } from './mcp-server/mcp-server.module';

import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { SettingsModule } from './settings/settings.module';
import { RolesModule } from './roles/roles.module';
import { KgModule } from './knowledge-graph/kg.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { LicenseModule } from './license/license.module';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { McpAuthMiddleware } from './auth/mcp-auth.middleware';
import { McpRateLimitMiddleware } from './auth/mcp-rate-limit.middleware';
import { ClientCredentialsMiddleware } from './auth/client-credentials.middleware';
import { RefreshTokenRevocationMiddleware } from './auth/refresh-token-revocation.middleware';
import { OAuthRegisterGuardMiddleware } from './auth/oauth-register-guard.middleware';
import { AuthorizePkceMiddleware } from './auth/authorize-pkce.middleware';
import { ResourceIndicatorMiddleware } from './auth/resource-indicator.middleware';
import { AuthorizationIssuerMiddleware } from './auth/authorization-issuer.middleware';
import { IdentityProvidersModule } from './identity-providers/identity-providers.module';
import { LocalOAuthProvider } from './auth/local-oauth.provider';
import { PrismaOAuthStore } from './auth/prisma-oauth.store';
import { PrismaService } from './common/prisma.service';
import { OAuthUrlRewriteInterceptor } from './auth/oauth-url-rewrite.interceptor';
import { EmailVerifiedGuard } from './auth/email-verified.guard';
import { AdaptersModule } from './adapters/adapters.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { CloudModule } from './ee/cloud/cloud.module';
import { getRequiredSecret } from './common/secrets.util';
import { AppLoggerModule } from './common/logger.module';
import { SentryContextInterceptor } from './common/sentry-context.interceptor';

// Determine deployment and auth mode from env
const useCloud = process.env.DEPLOYMENT_MODE === 'cloud';
const cloudImports = useCloud ? [CloudModule] : [];

// Determine auth mode from env
const authMode = process.env.MCP_AUTH_MODE || 'none';
const useOAuth = authMode === 'oauth2' || authMode === 'both';

// Build module imports conditionally
const conditionalImports: any[] = [];

if (useOAuth) {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:4000';
  const jwtSecret = getRequiredSecret('JWT_SECRET', process.env.JWT_SECRET);

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
        // OpenID Connect, the minimum of it: lets a relying party (ChatGPT
        // Enterprise, for one) ask who the user is via /userinfo and restrict
        // a connector to the company's e-mail domain. The scope policy only
        // grants scopes listed here, so without this line a request for
        // `openid email` is silently narrowed to nothing.
        scopesSupported: ['openid', 'email'],
      },
      // The module verifies at bootstrap that cookie-parser is mounted by
      // looking for an Express layer whose handler is named `cookieParser`.
      // With Sentry on, its Express instrumentation wraps every handler as
      // `layerHandlePatched`, the check finds nothing and throws, and the
      // backend never starts: that took the cloud down on 2026-09-24. main.ts
      // always mounts cookie-parser (see the regression test in
      // main-cookie-parser.spec.ts), so the check is skipped only then.
      skipCookieParserCheck: Sentry.isInitialized(),
    }),
  );
}

@Module({
  imports: [
    // Sentry first, so its instrumentation wraps every module below. Inert
    // when SENTRY_DSN is unset (instrument.ts never calls Sentry.init).
    SentryModule.forRoot(),

    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(__dirname, '..', '..', '..', '..', '.env'),
        join(__dirname, '..', '..', '..', '.env'),
        '.env',
      ],
    }),

    // Structured logging — replaces the default NestJS console logger with
    // Pino, attaches a request-scoped correlation id, and redacts auth headers.
    AppLoggerModule,

    // Database
    PrismaModule,

    // Cache
    RedisModule,

    // Rate limiting — single default bucket (100 req/min). Sensitive routes
    // (login, register, password reset) override this with @Throttle() so
    // they can have a much stricter cap without throttling general traffic.
    // Note: do NOT add additional named buckets here. With nestjs/throttler
    // v6, ALL configured buckets apply to every request, which means a
    // strict bucket would also throttle the MCP endpoints.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    // OAuth2 module (conditionally loaded)
    ...conditionalImports,

    // Core modules
    AuthModule,
    UsersModule,
    ConnectorsModule,
    AdaptersModule,
    McpServerModule,

    OrganizationsModule,
    AuditModule,
    IdentityProvidersModule,
    HealthModule,
    SettingsModule,
    RolesModule,
    KgModule,
    McpServersModule,
    LicenseModule,

    // Cloud-specific modules (conditionally loaded)
    ...cloudImports,
  ],
  providers: [
    // Reports exceptions Nest turns into a 500 response, which otherwise never
    // reach Sentry. HttpExceptions (4xx, auth failures) are expected and are
    // not reported. Must stay the first APP_FILTER.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_INTERCEPTOR, useClass: SentryContextInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
    // Injected by McpServerService, which registers the tools defined in the
    // database once the app is up.
    { provide: MCP_STRATEGY, useValue: mcpStrategy },
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

    // Pre-process POST /token for OAuth2 mode. The two middlewares match
    // disjoint `grant_type` values (client_credentials vs refresh_token), so
    // their order is immaterial; declaring them together makes it explicit
    // that both must run before the upstream @rekog/mcp-nest-auth controller.
    // RefreshTokenRevocationMiddleware is what makes `sessionsValidFrom`
    // actually revoke a session: without it a refresh grant mints a fresh
    // access token whose `iat` sits above the watermark.
    if (mode === 'oauth2' || mode === 'both') {
      consumer
        .apply(ClientCredentialsMiddleware, RefreshTokenRevocationMiddleware)
        .forRoutes('token');
    }

    // Reject malformed POST /register bodies before they reach the
    // upstream @rekog/mcp-nest controller (which would otherwise crash
    // with a 500 on undefined.redirect_uris). Always on — the guard is
    // a pure body-shape validator and a no-op for valid JSON requests.
    consumer.apply(OAuthRegisterGuardMiddleware).forRoutes('register');

    // Require PKCE with S256 on /authorize. Upstream only validates a code
    // challenge when one is present and defaults the method to 'plain', which
    // — with open DCR — leaves authorization codes replayable.
    if (mode === 'oauth2' || mode === 'both') {
      consumer.apply(AuthorizePkceMiddleware).forRoutes('authorize');

      // MCP 2026-07-28 alignment. Capture the client's RFC 8707 `resource`
      // (upstream ignores it) and append the RFC 9207 `iss` to authorization
      // responses — the latter MUST stay in step with
      // `authorization_response_iss_parameter_supported` in the metadata.
      consumer.apply(ResourceIndicatorMiddleware).forRoutes('authorize');
      consumer.apply(AuthorizationIssuerMiddleware).forRoutes('callback');
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
    // For 'oauth2' mode the bearer token is checked by McpCombinedAuthGuard on
    // McpEndpointController, which now serves the global /mcp too. mcp-nest v2
    // removed the `guards` option that used to apply McpAuthJwtGuard here, so
    // relying on it would leave the endpoint open.
  }
}
