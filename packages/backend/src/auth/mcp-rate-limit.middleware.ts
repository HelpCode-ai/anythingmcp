import { Injectable, NestMiddleware, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../common/redis.service';

/**
 * Middleware for rate limiting the MCP endpoint (/mcp).
 * Uses Redis sliding window counter. Falls back gracefully if Redis unavailable.
 *
 * Env: MCP_RATE_LIMIT_PER_MINUTE (default: 60)
 */
@Injectable()
export class McpRateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(McpRateLimitMiddleware.name);
  private readonly limit: number;
  private readonly windowSeconds = 60;

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.limit = parseInt(
      this.configService.get<string>('MCP_RATE_LIMIT_PER_MINUTE', '60'),
      10,
    );
  }

  async use(req: Request, res: Response, next: NextFunction) {
    if (!this.redis.isConnected) {
      return next();
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const clientId = apiKey
      ? `mcp:rate:key:${apiKey}`
      : `mcp:rate:ip:${req.ip}`;

    try {
      const current = await this.redis.incr(clientId);

      if (current === 1) {
        await this.redis.expire(clientId, this.windowSeconds);
      }

      const remaining = Math.max(0, this.limit - current);
      const ttl = await this.redis.ttl(clientId);

      res.setHeader('X-RateLimit-Limit', String(this.limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + ttl));

      if (current > this.limit) {
        this.logger.warn(`MCP rate limit exceeded for ${clientId}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Rate limit exceeded. Max ${this.limit} requests per minute.`,
            retryAfter: ttl,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      next();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Rate limit check failed: ${(error as Error).message}`);
      next();
    }
  }
}
