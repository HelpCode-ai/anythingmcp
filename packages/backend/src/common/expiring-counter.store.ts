import { Logger } from '@nestjs/common';
import type { RedisService } from './redis.service';

export type CounterEntry = { count: number; expiresAt: number };

/**
 * Counters and markers that expire by themselves, for limits that must not
 * depend on which backend process answers.
 *
 * Redis when connected (shared by every backend process; INCR is atomic),
 * else an in-memory map with expiry and a size cap. Redis errors fall back to
 * memory: a lost count only means a few more tries, never a failed request,
 * so no method of this store throws.
 *
 * A count is a fixed window: it starts with the first `increment` and expires
 * `ttlMs` later, whatever happens in between.
 */
export class ExpiringCounterStore {
  static readonly MAX_MEMORY_ENTRIES = 10_000;

  private readonly logger = new Logger(ExpiringCounterStore.name);

  constructor(
    private readonly redis?: RedisService,
    /** Fallback while Redis is not connected. Insertion order = age. */
    readonly memory: Map<string, CounterEntry> = new Map(),
  ) {}

  /** Counts one more for `key`; resolves to the new count. */
  async increment(key: string, ttlMs: number, now = Date.now()): Promise<number> {
    if (this.redis?.isConnected) {
      try {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, Math.ceil(ttlMs / 1000));
        if (count > 0) return count;
      } catch (err: any) {
        this.logger.warn(`Could not count in Redis, counting in memory: ${err?.message ?? err}`);
      }
    }
    const entry = this.memory.get(key);
    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      return entry.count;
    }
    this.memory.delete(key);
    this.prune(now);
    this.memory.set(key, { count: 1, expiresAt: now + ttlMs });
    return 1;
  }

  /** Sets a marker on `key` that lasts `ttlMs` (replacing any earlier one). */
  async holdFor(key: string, ttlMs: number, now = Date.now()): Promise<void> {
    const until = now + ttlMs;
    if (this.redis?.isConnected) {
      try {
        await this.redis.set(key, String(until), Math.max(1, Math.ceil(ttlMs / 1000)));
        return;
      } catch (err: any) {
        this.logger.warn(`Could not store a marker in Redis, keeping it in memory: ${err?.message ?? err}`);
      }
    }
    this.memory.delete(key);
    this.prune(now);
    this.memory.set(key, { count: 1, expiresAt: until });
  }

  /** How long the marker on `key` still lasts, in milliseconds; 0 when there is none. */
  async heldFor(key: string, now = Date.now()): Promise<number> {
    if (this.redis?.isConnected) {
      try {
        const value = await this.redis.get(key);
        const until = value === null ? NaN : Number(value);
        return Number.isFinite(until) ? Math.max(0, until - now) : 0;
      } catch (err: any) {
        this.logger.warn(`Could not read a marker from Redis, reading memory: ${err?.message ?? err}`);
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return 0;
    if (entry.expiresAt <= now) {
      this.memory.delete(key);
      return 0;
    }
    return entry.expiresAt - now;
  }

  /** Drops these counters and markers. */
  async reset(...keys: string[]): Promise<void> {
    for (const key of keys) this.memory.delete(key);
    if (this.redis?.isConnected) {
      for (const key of keys) {
        try {
          await this.redis.del(key);
        } catch {
          // Every key expires by itself anyway.
        }
      }
    }
  }

  /** Drops expired entries, then the oldest ones, to stay under the cap. */
  private prune(now: number): void {
    if (this.memory.size < ExpiringCounterStore.MAX_MEMORY_ENTRIES) return;
    for (const [k, v] of this.memory) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
    while (this.memory.size >= ExpiringCounterStore.MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }
}
