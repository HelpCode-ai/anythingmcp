import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Structured logging — Pino over the default NestJS console logger.
 *
 *  - JSON output in production so log aggregators (Loki, CloudWatch,
 *    Datadog) can parse fields directly.
 *  - Pretty output in development for legibility.
 *  - Per-request correlation id: read from X-Request-Id, generated when
 *    missing, attached to every log line and echoed back on the response so
 *    a client can quote it when reporting bugs.
 *  - Authorization, cookies and X-API-Key headers are redacted.
 *  - The MCP endpoint is logged at trace level: it is a high-traffic JSON-RPC
 *    surface and we don't need a line per request unless debugging.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        autoLogging: {
          ignore: (req: IncomingMessage) => {
            const url = req.url || '';
            return url === '/health' || url.startsWith('/health?');
          },
        },
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const incoming =
            (req.headers['x-request-id'] as string | undefined) ||
            (req.headers['x-correlation-id'] as string | undefined);
          const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        customProps: (req: IncomingMessage) => ({
          // Surface authenticated identity (set by passport / mcp-auth guards)
          userId: (req as any).user?.sub,
          orgId: (req as any).user?.organizationId,
          authMethod: (req as any).user?.authMethod,
        }),
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.headers["set-cookie"]',
            'res.headers["set-cookie"]',
            // Common DTO field names; class-validator's whitelist already
            // strips unknown fields, but redact in case a controller logs
            // its body.
            '*.password',
            '*.passwordHash',
            '*.token',
            '*.refreshToken',
            '*.accessToken',
            '*.apiKey',
            '*.secret',
          ],
          remove: true,
        },
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'SYS:HH:MM:ss.l',
                  ignore: 'pid,hostname,req,res,responseTime',
                },
              },
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
