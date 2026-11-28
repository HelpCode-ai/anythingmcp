import type { RedisService } from '../common/redis.service';
import { type CounterEntry, ExpiringCounterStore } from '../common/expiring-counter.store';

/** Wrong codes allowed per account before its open codes are voided. */
export const MAX_WRONG_CODES = 5;

/**
 * One in-memory map per process, shared by every store instance: the
 * dashboard's AuthController builds its own EmailVerificationService, and the
 * authorization page uses the injected one. Both must count against the same
 * account even without Redis.
 */
const processMemory = new Map<string, CounterEntry>();

/** Empties the in-process fallback (tests). */
export function clearVerificationAttemptsMemory(): void {
  processMemory.clear();
}

/**
 * Counts wrong email verification codes per account, for as long as a code
 * lives. EmailVerificationService voids the account's open codes once the
 * count reaches MAX_WRONG_CODES, so the user has to ask for a new one.
 *
 * Stored in an ExpiringCounterStore: Redis when connected, else an in-memory
 * map with expiry and a size cap, shared by every instance in the process.
 */
export class VerificationAttemptsStore {
  static readonly MAX_MEMORY_ENTRIES = ExpiringCounterStore.MAX_MEMORY_ENTRIES;

  private readonly counter: ExpiringCounterStore;

  constructor(
    private readonly ttlMs: number,
    redis?: RedisService,
    /** Fallback while Redis is not connected. Insertion order = age. */
    private readonly memory: Map<string, CounterEntry> = processMemory,
  ) {
    this.counter = new ExpiringCounterStore(redis, memory);
  }

  private key(userId: string): string {
    return `email-verify:wrong:${userId}`;
  }

  /** Counts one more wrong code for this account; resolves to the new count. */
  async recordWrong(userId: string, now = Date.now()): Promise<number> {
    return this.counter.increment(this.key(userId), this.ttlMs, now);
  }

  /** Starts the count again (a new code was sent, or the code was right). */
  async reset(userId: string): Promise<void> {
    await this.counter.reset(this.key(userId));
  }
}
