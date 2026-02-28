import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 4000;
  const corsOrigin = configService.get<string>('CORS_ORIGIN') || '*';

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AnythingToMCP API')
    .setDescription(
      'Backend API for AnythingToMCP — convert any API into an MCP server. ' +
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

  await app.listen(port);
  logger.log(`AnythingToMCP backend running on: http://localhost:${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  logger.log(`MCP endpoint: http://localhost:${port}/mcp`);
}

bootstrap();
