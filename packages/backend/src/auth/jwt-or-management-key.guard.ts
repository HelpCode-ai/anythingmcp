import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { apiKeyLookupWhere, apiKeySuffix, hashApiKey } from '../common/crypto/api-key-hash.util';

/** Default per-key ceiling for the management API, per minute. 0 disables. */
export const DEFAULT_MANAGEMENT_RATE_LIMIT_PER_MINUTE = 300;

/**
 * Authorizes a management (`/api/*`) request with EITHER a dashboard session
 * JWT (the existing behaviour, unchanged) OR a management-scoped MCP API key
 * presented as a bearer token. It is a drop-in replacement for
 * `AuthGuard('jwt')` on management controllers.
 *
 * The key carries the owner's identity and role; it never grants privilege.
 * `@Roles('ADMIN')` still runs after this guard, so a non-admin's key gets the
 * same 403s it would in the dashboard. Scope is only a downward cap:
 *   - MCP               → rejected here (tool-call keys cannot reach /api).
 *   - MANAGEMENT_READ   → safe methods only (GET/HEAD/OPTIONS).
 *   - MANAGEMENT_ADMIN  → any method, still role-capped by RolesGuard.
 *
 * Only Prisma is required (PrismaModule is @Global). Redis is optional: the
 * guard also sits on controllers that processes without RedisModule load (the
 * File Search worker imports SettingsModule), and without Redis the per-key
 * rate limit falls open, as it does when Redis is down.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class JwtOrManagementKeyGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtOrManagementKeyGuard.name);
  private readonly rateLimit: number;
  private readonly windowSeconds = 60;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {
    super();
    const raw = process.env.MANAGEMENT_RATE_LIMIT_PER_MINUTE;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    this.rateLimit =
      Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : DEFAULT_MANAGEMENT_RATE_LIMIT_PER_MINUTE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const presentedKey = extractApiKey(request.headers);

    // No API key presented → fall back to the unchanged JWT behaviour.
    if (!presentedKey) {
      return (await super.canActivate(context)) as boolean;
    }

    const record = await this.prisma.mcpApiKey.findFirst({
      where: apiKeyLookupWhere(presentedKey),
      include: {
        user: {
          select: { id: true, email: true, role: true, organizationId: true },
        },
      },
    });
    // Same answer for missing, inactive, or non-management keys: do not reveal
    // which it was.
    if (!record || !record.isActive || record.scope === 'MCP') {
      throw new UnauthorizedException(
        'Invalid or non-management API key for the management API',
      );
    }

    // Defence in depth: the key must not authenticate a user deactivated in the
    // key's organization, even if the key row escaped deactivation.
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId: record.userId,
          organizationId: record.organizationId,
        },
      },
      select: { deactivatedAt: true },
    });
    if (!membership || membership.deactivatedAt) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (
      record.scope === 'MANAGEMENT_READ' &&
      !SAFE_METHODS.has(request.method)
    ) {
      throw new ForbiddenException('This API key is read-only');
    }

    // Safety net against a runaway client (e.g. an agent in a loop): at most
    // N requests per minute per key. Counts every method, falls open without
    // Redis, and is independent of the global per-IP ThrottlerGuard.
    await this.enforceRateLimit(record.id, record.organizationId);

    request.user = {
      sub: record.user.id,
      email: record.user.email,
      role: record.user.role,
      organizationId: record.organizationId,
    };
    (request as { mcpKeyScope?: string }).mcpKeyScope = record.scope;

    // Best-effort last-used stamp (and hash for a row not hashed yet); never
    // block the request on it.
    void this.prisma.mcpApiKey
      .update({
        where: { id: record.id },
        data: {
          lastUsedAt: new Date(),
          ...(record.keyHash
            ? {}
            : { keyHash: hashApiKey(presentedKey), keySuffix: apiKeySuffix(presentedKey) }),
        },
      })
      .catch(() => undefined);

    return true;
  }

  private async enforceRateLimit(keyId: string, organizationId: string): Promise<void> {
    if (this.rateLimit === 0 || !this.redis?.isConnected) return;
    const redisKey = `api:prl:key:${keyId}`;
    try {
      const current = await this.redis.incr(redisKey);
      if (current === 1) await this.redis.expire(redisKey, this.windowSeconds);
      if (current <= this.rateLimit) return;

      const ttl = Math.max(1, await this.redis.ttl(redisKey));
      if (current === this.rateLimit + 1) {
        // Once per window, not once per refused call.
        this.logger.warn(
          `Management API rate limit reached for key ${keyId} (org ${organizationId}): ` +
            `more than ${this.rateLimit} requests in a minute`,
        );
      }
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            `Too many requests: more than ${this.rateLimit} management API calls in a minute ` +
            `with this key. Retry in ${ttl} s.`,
          retryAfter: ttl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Management rate limit check failed: ${(error as Error).message}`);
    }
  }
}

function extractApiKey(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const authorization = headers['authorization'];
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    // A dashboard JWT also arrives as a bearer token; only an `mcp_` key is
    // treated as a key, so JWTs fall through to the JWT strategy unchanged.
    if (/^mcp_[a-f0-9]+$/i.test(token)) return token;
  }
  const headerKey = headers['x-api-key'];
  if (typeof headerKey === 'string' && /^mcp_[a-f0-9]+$/i.test(headerKey)) {
    return headerKey;
  }
  return undefined;
}
