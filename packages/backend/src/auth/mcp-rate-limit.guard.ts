import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis.service';

/**
 * Rate limiter for the MCP endpoint, backed by Redis for distributed support.
 * Falls back to allowing all requests if Redis is unavailable.
 *
 * Config via env:
 *   MCP_RATE_LIMIT_PER_MINUTE (default: 60)
 *
 * Rate limit is per client IP or per API key.
 */
@Injectable()
export class McpRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(McpRateLimitGuard.name);
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.redis.isConnected) {
      return true; // No Redis = no rate limiting
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Identify client by API key or IP
    const apiKey = request.headers['x-api-key'];
    const clientId = apiKey
      ? `mcp:rate:key:${apiKey}`
      : `mcp:rate:ip:${request.ip}`;

    try {
      const current = await this.redis.incr(clientId);

      // Set TTL on first request in this window
      if (current === 1) {
        await this.redis.expire(clientId, this.windowSeconds);
      }

      const remaining = Math.max(0, this.limit - current);
      const ttl = await this.redis.ttl(clientId);

      // Set rate limit headers
      response.header('X-RateLimit-Limit', String(this.limit));
      response.header('X-RateLimit-Remaining', String(remaining));
      response.header('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + ttl));

      if (current > this.limit) {
        this.logger.warn(`Rate limit exceeded for ${clientId}: ${current}/${this.limit}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Rate limit exceeded. Max ${this.limit} requests per minute.`,
            retryAfter: ttl,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Redis error — allow the request
      this.logger.warn(`Rate limit check failed: ${(error as Error).message}`);
      return true;
    }
  }
}
