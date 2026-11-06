import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { McpPrincipalRateLimitGuard } from '../auth/mcp-principal-rate-limit.guard';
import { RolesService, type ToolRateLimits } from '../roles/roles.service';

export interface ToolRateLimitContext {
  userId?: string;
  organizationId?: string;
  authMethod?: string;
  apiKeyName?: string;
}

interface WindowCounter { count: number; expiresAt: number }
interface Counters { minute: WindowCounter; hour: WindowCounter }
interface Refusal { error: string; retryAfter: number }

const MAX_LOCAL_BUCKETS = 10_000;

// Inspect both windows before incrementing either. Refusals consume no quota
// and never extend expiry. Both keys share a Redis Cluster hash slot.
export const TOOL_RATE_LIMIT_SCRIPT = `
local limits = {tonumber(ARGV[1]), tonumber(ARGV[2])}
local durations = {60000, 3600000}
local retry = 0
local hit = {0, 0}
for i = 1, 2 do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  local ttl = redis.call('PTTL', KEYS[i])
  if count > 0 and ttl < 0 then
    redis.call('PEXPIRE', KEYS[i], durations[i])
    ttl = durations[i]
  end
  if limits[i] > 0 and count >= limits[i] then
    hit[i] = 1
    retry = math.max(retry, math.max(1, math.ceil(ttl / 1000)))
  end
end
if retry > 0 then return {retry, hit[1], hit[2]} end
for i = 1, 2 do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('PEXPIRE', KEYS[i], durations[i]) end
end
return {0, 0, 0}
`;

@Injectable()
export class ToolRateLimitService {
  private readonly logger = new Logger(ToolRateLimitService.name);
  private readonly counters = new Map<string, Counters>();
  private lastWarningAt = -Infinity;

  constructor(private readonly roles: RolesService, private readonly redis: RedisService) {}

  async check(
    tool: { id: string; name: string },
    context?: ToolRateLimitContext,
  ): Promise<Refusal | null> {
    if (!context?.userId || !context.organizationId) return null;
    const limits = await this.roles.getToolRateLimits(context.userId, context.organizationId, tool.id);
    if (!limits || (limits.callsPerMinute === null && limits.callsPerHour === null)) return null;

    // Use precisely the principal guard's identity, including its key-name
    // truncation. Hash the tuple to avoid delimiters colliding and to keep
    // user-supplied API-key names out of Redis keys and warning messages.
    const bucket = McpPrincipalRateLimitGuard.bucketFor({
      user: { sub: context.userId, authMethod: context.authMethod, apiKeyName: context.apiKeyName },
    });
    const key = createHash('sha256')
      .update(JSON.stringify([context.organizationId, tool.id, bucket])).digest('hex');

    if (this.redis.isConfigured) {
      if (!this.redis.isConnected) {
        this.warnUnavailable();
        return null;
      }
      try {
        const client = this.redis.getClient();
        if (!client) throw new Error('Redis client unavailable');
        const [retry, minute, hour] = await client.eval(
          TOOL_RATE_LIMIT_SCRIPT, 2, `mcp:trl:{${key}}:minute`, `mcp:trl:{${key}}:hour`,
          limits.callsPerMinute ?? 0, limits.callsPerHour ?? 0,
        ) as number[];
        return retry > 0 ? this.refusal(tool.name, limits, retry, !!minute, !!hour) : null;
      } catch {
        // Do not echo Redis errors: they can contain connection credentials.
        this.warnUnavailable();
        return null;
      }
    }
    return this.checkLocal(key, tool.name, limits);
  }

  private warnUnavailable(): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = now;
    this.logger.warn('Per-tool rate limiting: Redis unavailable; allowing calls without local fallback.');
  }

  private checkLocal(key: string, name: string, limits: ToolRateLimits): Refusal | null {
    const now = Date.now();
    let counters = this.counters.get(key);
    if (!counters) {
      if (this.counters.size >= MAX_LOCAL_BUCKETS) {
        for (const [id, value] of this.counters) {
          if (value.minute.expiresAt <= now && value.hour.expiresAt <= now) this.counters.delete(id);
        }
        if (this.counters.size >= MAX_LOCAL_BUCKETS) {
          // Evicting a live bucket would let a caller reset its own allowance.
          const retryAfter = Math.max(1, Math.ceil(Math.min(...[...this.counters.values()]
            .map((value) => Math.max(value.minute.expiresAt, value.hour.expiresAt) - now)) / 1000));
          return { error: `Tool '${name}' rate limiter is at capacity; retry in ${retryAfter}s.`, retryAfter };
        }
      }
      counters = { minute: { count: 0, expiresAt: now + 60_000 }, hour: { count: 0, expiresAt: now + 3_600_000 } };
      this.counters.set(key, counters);
    }
    const minuteCounter = counters.minute.expiresAt <= now ? { count: 0, expiresAt: now + 60_000 } : counters.minute;
    const hourCounter = counters.hour.expiresAt <= now ? { count: 0, expiresAt: now + 3_600_000 } : counters.hour;
    const minute = limits.callsPerMinute !== null && minuteCounter.count >= limits.callsPerMinute;
    const hour = limits.callsPerHour !== null && hourCounter.count >= limits.callsPerHour;
    if (minute || hour) {
      const retryAfter = Math.max(1, Math.ceil(Math.max(
        minute ? minuteCounter.expiresAt - now : 0,
        hour ? hourCounter.expiresAt - now : 0,
      ) / 1000));
      return this.refusal(name, limits, retryAfter, minute, hour);
    }
    counters.minute = { count: minuteCounter.count + 1, expiresAt: minuteCounter.expiresAt };
    counters.hour = { count: hourCounter.count + 1, expiresAt: hourCounter.expiresAt };
    return null;
  }

  private refusal(name: string, limits: ToolRateLimits, retryAfter: number, minute: boolean, hour: boolean): Refusal {
    const reached = [minute ? `${limits.callsPerMinute}/min` : '', hour ? `${limits.callsPerHour}/hour` : ''].filter(Boolean).join(', ');
    return { error: `Rate limit for tool '${name}': ${reached}; retry in ${retryAfter}s.`, retryAfter };
  }
}
