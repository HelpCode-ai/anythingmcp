// Load .env before any module imports so that top-level process.env reads
// (e.g. MCP_AUTH_MODE in app.module.ts) have access to all variables.
import { config } from 'dotenv';
import { join } from 'path';
config({ path: join(__dirname, '..', '..', '..', '..', '.env') });
config({ path: join(__dirname, '..', '..', '..', '.env') });
config({ path: '.env' });

// Sentry must be imported before any other application code so the
// auto-instrumentation can wrap http/express/prisma. No-op when SENTRY_DSN
// is not set.
import './instrument';

// OpenTelemetry tracing must register its instrumentations BEFORE any
// module that uses http/express/prisma is required. No-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is unset.
import { startTracing } from './tracing';
startTracing();

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { mcpStrategy } from './mcp-server/mcp-strategy';
import { McpAuthExceptionFilter } from './auth/mcp-auth-exception.filter';
import { validateRequiredSecretsAtStartup } from './common/secrets.util';

async function bootstrap() {
  // Fail fast if required secrets are missing or use known placeholder values.
  // Done before NestFactory.create to surface config errors before module init.
  validateRequiredSecretsAtStartup(process.env);

  // bufferLogs lets pre-app.useLogger() messages flush through Pino once it's
  // wired, instead of going through the default NestJS console logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  const logger = app.get(PinoLogger);

  // Trust proxy headers (ngrok, reverse proxies) for correct protocol/host detection
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // Increase body size limit for large API spec imports (Postman, OpenAPI, etc.)
  // `application/scim+json` is what Entra ID sends to the SCIM endpoint.
  // body-parser's default `type` matches only application/json, so without
  // this every SCIM POST/PATCH would arrive as an empty body and fail in ways
  // that look nothing like a content-type problem.
  app.use(json({ limit: '10mb', type: ['application/json', 'application/scim+json'] }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 4000;
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  // Cookie parser with HMAC secret so we can use signed cookies for the
  // OAuth callback flow. Falls back to JWT_SECRET to avoid forcing every
  // self-hoster to add a new env var; logs a startup warning when the
  // fallback is used in production.
  const cookieSecret =
    configService.get<string>('COOKIE_SECRET') ||
    configService.get<string>('JWT_SECRET');
  if (!cookieSecret) {
    throw new Error(
      'COOKIE_SECRET (or fallback JWT_SECRET) must be set for signed cookies',
    );
  }
  if (
    isProduction &&
    !configService.get<string>('COOKIE_SECRET')
  ) {
    Logger.warn(
      'COOKIE_SECRET not set in production — falling back to JWT_SECRET. Set COOKIE_SECRET to a separate value for defense-in-depth.',
      'Bootstrap',
    );
  }
  app.use(cookieParser(cookieSecret));

  // Security headers (CSP relaxed because Swagger UI ships inline scripts/styles)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      strictTransportSecurity: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,
    }),
  );

  // Add WWW-Authenticate header to MCP 401 responses for OAuth discovery
  app.useGlobalFilters(new McpAuthExceptionFilter());

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS — never use wildcard with credentials. In production an explicit
  // CORS_ORIGIN list is required. In development a sensible localhost default
  // is used when CORS_ORIGIN is not set.
  const corsOrigin = resolveCorsOrigin(configService, isProduction);
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AnythingMCP API')
    .setDescription(
      'Backend API for AnythingMCP — convert any API into an MCP server. ' +
        'Manage connectors, configure MCP tools, and monitor usage.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      'api-key',
    )
    .addTag('Auth', 'Authentication and user management')
    .addTag('Connectors', 'Manage API connectors')
    .addTag('Tools', 'MCP tool configuration')
    .addTag('AI', 'AI-assisted configuration')
    .addTag('MCP', 'MCP server management')
    .addTag('Health', 'Health checks')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // Drain in-flight requests and close DB / Redis connections cleanly when
  // the platform sends SIGTERM (k8s rolling deploy, docker stop, Railway
  // restart). Without this, long-running tool invocations would be killed
  // mid-flight and the audit log entry never written.
  app.enableShutdownHooks();

  // The MCP server is a microservice transport strategy in mcp-nest v2, not a
  // module, so it has to be connected and started explicitly. `setHttpAdapter`
  // gives it the same HTTP server Nest is about to listen on; without it the
  // HTTP transports have nowhere to attach.
  //
  // Order matters: `startAllMicroservices()` must run BEFORE `listen()` so the
  // MCP routes exist before the server accepts its first connection.
  mcpStrategy.setHttpAdapter(app.getHttpAdapter());
  app.connectMicroservice({ strategy: mcpStrategy });
  await app.startAllMicroservices();

  const server = await app.listen(port);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // A SIGTERM must end in an exit, every time, within a bounded time.
  //
  // It did not. `app.close()` calls `server.close()`, which resolves only
  // once every connection has gone away — and an MCP server has connections
  // that never go away on their own: SSE subscription streams held open for
  // minutes, and keep-alive sockets idling for up to keepAliveTimeout. In the
  // split-container layout the backend is PID 1 and its exit is what makes
  // Docker restart it; tested with a plain SIGTERM, the process closed its
  // listener and then sat there, unhealthy, for as long as anyone cared to
  // wait. The heap guard's own exit path (process-vitals.service.ts) would
  // have hung the same way but for its 30-second fallback.
  //
  // So: stop accepting, give in-flight requests a moment, then cut what is
  // left and exit — and if even that stalls, exit anyway. The deadline is the
  // guarantee; everything before it is courtesy.
  const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 20_000;
  const cutConnectionsAfterMs = Math.min(5_000, shutdownTimeoutMs / 2);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully (deadline ${shutdownTimeoutMs} ms)...`);
      const deadline = setTimeout(() => {
        logger.error(`Graceful shutdown exceeded ${shutdownTimeoutMs} ms — exiting now.`);
        process.exit(1);
      }, shutdownTimeoutMs);
      deadline.unref();
      // Idle keep-alive sockets can go immediately; nothing is in flight on them.
      server.closeIdleConnections?.();
      // Streams and slow calls get a grace period, then are closed so that
      // server.close() can actually complete.
      const cutter = setTimeout(() => {
        logger.warn('Closing remaining connections so shutdown can complete.');
        server.closeAllConnections?.();
      }, cutConnectionsAfterMs);
      cutter.unref();
      try {
        await app.close();
        logger.log('Shutdown complete.');
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err}`);
        process.exit(1);
      }
    });
  }

  logger.log(`AnythingMCP backend running on: http://localhost:${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  logger.log(`MCP endpoint (global): http://localhost:${port}/mcp`);
  logger.log(`MCP endpoint (per-server): http://localhost:${port}/mcp/:serverId`);
}

function resolveCorsOrigin(
  configService: ConfigService,
  isProduction: boolean,
): string | string[] | RegExp[] | boolean {
  const raw = configService.get<string>('CORS_ORIGIN');

  if (!raw || raw.trim() === '') {
    if (isProduction) {
      throw new Error(
        '[cors] CORS_ORIGIN must be set explicitly in production (comma-separated allowlist of origins).',
      );
    }
    return ['http://localhost:3000', 'http://127.0.0.1:3000'];
  }

  if (raw.trim() === '*') {
    if (isProduction) {
      throw new Error(
        "[cors] CORS_ORIGIN='*' is not allowed in production with credentials enabled.",
      );
    }
    return true;
  }

  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

bootstrap();
