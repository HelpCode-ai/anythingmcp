import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis.service';

/** Default ceiling per authenticated caller and minute. */
export const DEFAULT_MCP_PRINCIPAL_LIMIT_PER_MINUTE = 1000;

/**
 * A safety net against runaway clients on the MCP endpoints (/mcp and
 * /mcp/:serverId): at most N tool calls per minute per authenticated caller.
 *
 * Runs after McpCombinedAuthGuard, so it can count per *who* is calling rather
 * than per IP (every customer behind one NAT, or every Claude user behind
 * Anthropic's egress, would otherwise share one bucket):
 *   - an MCP API key → its own bucket (user + key name, never the key itself);
 *   - a dashboard/OAuth session → the user;
 *   - anything else → the client IP.
 *
 * The ceiling is deliberately high (MCP_PRINCIPAL_RATE_LIMIT_PER_MINUTE,
 * default 1000; 0 disables): the busiest real clients peak at a few hundred
 * calls a minute. It exists for the backend integration that loops tens of
 * thousands of times a day, not to shape normal use. Only POST (JSON-RPC
 * messages) counts; the GET event stream does not. Without Redis it lets
 * everything through.
 *
 * The legacy McpRateLimitMiddleware still runs where it is mounted (self-host
 * legacy auth); on Cloud (oauth2 mode) this guard is the only limiter.
 */
@Injectable()
export class McpPrincipalRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(McpPrincipalRateLimitGuard.name);
  private readonly limit: number;
  private readonly windowSeconds = 60;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    const raw = configService.get<string>('MCP_PRINCIPAL_RATE_LIMIT_PER_MINUTE');
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    this.limit = Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : DEFAULT_MCP_PRINCIPAL_LIMIT_PER_MINUTE;
  }

  /** The bucket for this request, from what the auth guard established. */
  static bucketFor(req: any): string {
    const user = req?.user ?? {};
    // No key material in the bucket name: the auth guard already resolved
    // which user and which of their keys this is.
    if (user.authMethod === 'mcp_api_key' && user.sub) {
      return `key:${user.sub}:${String(user.apiKeyName ?? 'key').slice(0, 80)}`;
    }
    if (user.sub && (user.authMethod === 'jwt' || user.authMethod === 'mcp_api_key')) {
      return `user:${user.sub}`;
    }
    return `ip:${req?.ip ?? 'unknown'}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.limit === 0 || !this.redis.isConnected) return true;

    const req = context.switchToHttp().getRequest();
    if (req.method !== 'POST') return true;
    const res = context.switchToHttp().getResponse();

    const bucket = McpPrincipalRateLimitGuard.bucketFor(req);
    const key = `mcp:prl:${bucket}`;
    try {
      const current = await this.redis.incr(key);
      if (current === 1) await this.redis.expire(key, this.windowSeconds);
      if (current <= this.limit) return true;

      const ttl = Math.max(1, await this.redis.ttl(key));
      if (current === this.limit + 1) {
        // Once per window, not once per refused call.
        this.logger.warn(
          `MCP rate limit reached for ${bucket} (org ${req.user?.organizationId ?? '?'}): ` +
            `more than ${this.limit} calls in a minute`,
        );
      }
      res.setHeader?.('Retry-After', String(ttl));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            `Too many requests: more than ${this.limit} MCP calls in a minute from this ` +
            `client. Retry in ${ttl} s, and cache results your client reads repeatedly.`,
          retryAfter: ttl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`MCP rate limit check failed: ${(error as Error).message}`);
      return true;
    }
  }
}
