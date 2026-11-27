import { Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

/** What a throttler storage answers per request (not exported by the package's index). */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;
import type { RedisService } from './redis.service';

/** The application's one throttler bucket: 100 requests a minute per address, `@Throttle()` per route. */
export const DEFAULT_THROTTLERS: ThrottlerOptions[] = [{ ttl: 60_000, limit: 100 }];

/** Prefix of every throttler key in Redis. */
export const THROTTLE_KEY_PREFIX = 'throttle:';

/**
 * One request against a fixed window, atomically:
 *   KEYS[1] hits of the window, KEYS[2] block marker
 *   ARGV[1] window (ms), ARGV[2] limit, ARGV[3] block duration (ms)
 * Returns { hits, ms until the window ends, blocked (0/1), ms until the block ends }.
 *
 * While blocked, requests are not counted. A request over the limit starts a
 * block of ARGV[3] ms (or, with no block duration, is refused until the window
 * ends); once a block ends, the count starts again. The same rules as the
 * throttler's in-memory storage.
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or '0')
  local hitsTtl = redis.call('PTTL', hitsKey)
  if hitsTtl < 0 then hitsTtl = 0 end
  return {hits, hitsTtl, 1, blockTtl}
end
local hits = redis.call('INCR', hitsKey)
local hitsTtl = redis.call('PTTL', hitsKey)
if hitsTtl < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  hitsTtl = ttl
end
if hits > limit then
  if block > 0 then
    redis.call('SET', blockKey, '1', 'PX', block)
    redis.call('DEL', hitsKey)
    return {hits, hitsTtl, 1, block}
  end
  return {hits, hitsTtl, 1, hitsTtl}
end
return {hits, hitsTtl, 0, 0}
`;

/**
 * Throttler counters in Redis, so the per-address limits hold across backend
 * processes and survive a deploy (the in-memory storage starts empty on every
 * restart). Uses the application's Redis connection (RedisService); while it
 * is not connected, or when a call fails, the request is counted in the
 * stock in-memory storage of this process instead, so the limit never stops
 * a request because Redis is down.
 *
 * Keys: `throttle:<throttler>:<key>` and `…:blocked`; both expire.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private lastError: string | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly fallback: ThrottlerStorageService = new ThrottlerStorageService(),
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redis.isConnected ? this.redis.getClient() : null;
    if (client) {
      const hitsKey = `${THROTTLE_KEY_PREFIX}${throttlerName}:${key}`;
      try {
        const reply = (await client.eval(
          INCREMENT_SCRIPT,
          2,
          hitsKey,
          `${hitsKey}:blocked`,
          String(ttl),
          String(limit),
          String(Math.max(0, blockDuration)),
        )) as [number, number, number, number];
        const [totalHits, hitsMs, blocked, blockMs] = reply.map(Number);
        this.lastError = null;
        return {
          totalHits,
          timeToExpire: Math.ceil(hitsMs / 1000),
          isBlocked: blocked === 1,
          timeToBlockExpire: blocked === 1 ? Math.ceil(blockMs / 1000) : 0,
        };
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (message !== this.lastError) {
          this.lastError = message;
          this.logger.warn(`Rate limit counter in Redis failed, counting in memory: ${message}`);
        }
      }
    }
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  onApplicationShutdown(): void {
    this.fallback.onApplicationShutdown();
  }
}

/**
 * ThrottlerModule options: the default bucket, with Redis storage when
 * REDIS_URL is set and the stock in-memory storage otherwise.
 */
export function throttlerModuleOptions(redisUrl: string | undefined, redis: RedisService): ThrottlerModuleOptions {
  if (!redisUrl?.trim()) return DEFAULT_THROTTLERS;
  return { throttlers: DEFAULT_THROTTLERS, storage: new RedisThrottlerStorage(redis) };
}
