// Load .env before any module imports so that top-level process.env reads
// (e.g. MCP_AUTH_MODE in app.module.ts) have access to all variables.
import { config } from 'dotenv';
import { join } from 'path';
config({ path: join(__dirname, '..', '..', '..', '..', '.env') });
config({ path: join(__dirname, '..', '..', '..', '.env') });
config({ path: '.env' });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { McpAuthExceptionFilter } from './auth/mcp-auth-exception.filter';
import { validateRequiredSecretsAtStartup } from './common/secrets.util';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Fail fast if required secrets are missing or use known placeholder values.
  // Done before NestFactory.create to surface config errors before module init.
  validateRequiredSecretsAtStartup(process.env);

  const app = await NestFactory.create(AppModule);

  // Trust proxy headers (ngrok, reverse proxies) for correct protocol/host detection
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // Increase body size limit for large API spec imports (Postman, OpenAPI, etc.)
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // Cookie parser is required for OAuth2 session management
  app.use(cookieParser());

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 4000;
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

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

  const server = await app.listen(port);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully...`);
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
