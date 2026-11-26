import { Logger } from '@nestjs/common';
import type { RedisService } from '../common/redis.service';

/** Wrong codes allowed per account before its open codes are voided. */
export const MAX_WRONG_CODES = 5;

/**
 * Counts wrong email verification codes per account, for as long as a code
 * lives. EmailVerificationService voids the account's open codes once the
 * count reaches MAX_WRONG_CODES, so the user has to ask for a new one.
 *
 * Redis when connected (shared by every backend process; INCR is atomic),
 * else an in-memory map with expiry and a size cap (correct for a single
 * process). Errors fall back to memory: a lost count only means a few more
 * tries, never a failed request.
 */
export class VerificationAttemptsStore {
  static readonly MAX_MEMORY_ENTRIES = 10_000;

  private readonly logger = new Logger(VerificationAttemptsStore.name);
  /** Fallback while Redis is not connected. Insertion order = age. */
  private readonly memory = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly redis?: RedisService,
  ) {}

  private key(userId: string): string {
    return `email-verify:wrong:${userId}`;
  }

  /** Counts one more wrong code for this account; resolves to the new count. */
  async recordWrong(userId: string, now = Date.now()): Promise<number> {
    const key = this.key(userId);
    if (this.redis?.isConnected) {
      try {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, Math.ceil(this.ttlMs / 1000));
        if (count > 0) return count;
      } catch (err: any) {
        this.logger.warn(`Could not count a wrong verification code in Redis: ${err?.message ?? err}`);
      }
    }
    const entry = this.memory.get(key);
    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      return entry.count;
    }
    this.memory.delete(key);
    this.prune(now);
    this.memory.set(key, { count: 1, expiresAt: now + this.ttlMs });
    return 1;
  }

  /** Starts the count again (a new code was sent, or the code was right). */
  async reset(userId: string): Promise<void> {
    const key = this.key(userId);
    this.memory.delete(key);
    if (this.redis?.isConnected) {
      try {
        await this.redis.del(key);
      } catch {
        // The count expires with the code anyway.
      }
    }
  }

  /** Drops expired entries, then the oldest ones, to stay under the cap. */
  private prune(now: number): void {
    if (this.memory.size < VerificationAttemptsStore.MAX_MEMORY_ENTRIES) return;
    for (const [k, v] of this.memory) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
    while (this.memory.size >= VerificationAttemptsStore.MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }
}
