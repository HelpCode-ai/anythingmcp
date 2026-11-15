import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { MANAGED_BOT_TTL_MS } from './telegram-managed-bot';

/**
 * What the server remembers between the two halves of linking a one-tap
 * Telegram bot whose username the user changed (see telegram-managed-bot.ts).
 *
 * The two halves arrive in either order, seconds or minutes apart, possibly
 * at two backend processes:
 * - Telegram says "this account created this bot" (no setup can be named);
 * - the same account sends the manager bot `/start <code>` (no bot yet).
 *
 * WHERE. Rows of `site_settings`, the instance's key/value table: it exists on
 * every instance, survives a restart and is shared by every backend process.
 * Redis is not used because a self-hosted instance may run without it, and
 * its in-memory fallback would lose the first half on a restart or a
 * blue/green switch. No schema change.
 *
 * WHAT, per Telegram account, each for 30 minutes at most:
 * - `telegram_unmatched_bot:<h>`: the id of the newest bot the account
 *   created with another username, and whether it was linked since;
 * - `telegram_claim:<h>`: the connector (and its workspace) the account asked
 *   to link;
 * plus `telegram_unmatched_bot_at`, the time of the last such bot on this
 * instance, for the page's hint.
 *
 * `<h>` is hashTelegramUserId: an HMAC of the account's id keyed with the
 * webhook secret. So no Telegram account id is stored, a row cannot be traced
 * back to a person, and rotating the secret orphans every row (the sweep
 * removes them). A bot's id has to be kept as it is: Telegram wants it to hand
 * out the token. No token, username or name is stored here.
 *
 * Nothing here decides anything: the service reads the connector again, in
 * its workspace, before it writes a token. A lost row costs the user one more
 * tap, so every method swallows its errors.
 */
@Injectable()
export class TelegramClaimStore {
  static readonly BOT_PREFIX = 'telegram_unmatched_bot:';
  static readonly CLAIM_PREFIX = 'telegram_claim:';
  static readonly LAST_UNMATCHED_KEY = 'telegram_unmatched_bot_at';
  /** Expired rows are deleted at most this often, on a write. */
  static readonly SWEEP_EVERY_MS = 10 * 60 * 1000;

  private readonly logger = new Logger(TelegramClaimStore.name);
  private lastSweepAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * An account created a bot whose username names no pending setup.
   * - 'stored': it is now the account's bot to link (the newest wins);
   * - 'used': this very bot was linked a moment ago (its second announcement,
   *   or a later token change): nothing to do;
   * - 'older': a newer bot of the account is already remembered (Telegram
   *   sent an old update again);
   * - 'failed': the row could not be written.
   */
  async rememberBot(
    creatorHash: string,
    bot: { botId: number; updateId: number | null },
    now: number,
  ): Promise<'stored' | 'used' | 'older' | 'failed'> {
    if (!isHash(creatorHash)) return 'failed';
    const key = TelegramClaimStore.BOT_PREFIX + creatorHash;
    try {
      const existing = readBot(await this.read(key), now);
      if (existing && existing.botId === bot.botId && existing.usedAt !== null) return 'used';
      if (
        existing &&
        existing.botId !== bot.botId &&
        existing.updateId !== null &&
        bot.updateId !== null &&
        bot.updateId < existing.updateId
      ) {
        return 'older';
      }
      const same = existing && existing.botId === bot.botId ? existing : null;
      await this.write(
        key,
        JSON.stringify({
          botId: bot.botId,
          updateId: newest(same?.updateId ?? null, bot.updateId),
          at: same?.at ?? now,
        }),
      );
      await this.sweep(now);
      return 'stored';
    } catch (err) {
      this.warn('remember a bot', err);
      return 'failed';
    }
  }

  /** The bot this account created and that is still to be linked, or null. */
  async botOf(creatorHash: string, now: number): Promise<{ botId: number } | null> {
    if (!isHash(creatorHash)) return null;
    try {
      const bot = readBot(await this.read(TelegramClaimStore.BOT_PREFIX + creatorHash), now);
      return bot && bot.usedAt === null ? { botId: bot.botId } : null;
    } catch (err) {
      this.warn('read a bot', err);
      return null;
    }
  }

  /**
   * The bot was linked (or Telegram no longer hands out its token): it is
   * kept as used until it expires, so that its second announcement is not
   * taken for a new bot.
   */
  async markBotUsed(creatorHash: string, botId: number, now: number): Promise<void> {
    if (!isHash(creatorHash)) return;
    const key = TelegramClaimStore.BOT_PREFIX + creatorHash;
    try {
      const existing = readBot(await this.read(key), now);
      // A newer bot took the row in the meantime: that one is still to link.
      if (existing && existing.botId !== botId) return;
      await this.write(key, JSON.stringify({ botId, updateId: existing?.updateId ?? null, at: existing?.at ?? now, usedAt: now }));
    } catch (err) {
      this.warn('mark a bot as linked', err);
    }
  }

  /** The account asked to link this setup; its bot does not exist yet. The newest request wins. */
  async rememberClaim(
    creatorHash: string,
    claim: { connectorId: string; organizationId: string; expiresAt: number },
    now: number,
  ): Promise<void> {
    if (!isHash(creatorHash) || !claim.connectorId || !claim.organizationId || !Number.isFinite(claim.expiresAt)) return;
    try {
      await this.write(TelegramClaimStore.CLAIM_PREFIX + creatorHash, JSON.stringify(claim));
      await this.sweep(now);
    } catch (err) {
      this.warn('remember a link request', err);
    }
  }

  /** The setup this account asked to link, while that setup can still be finished. */
  async claimOf(creatorHash: string, now: number): Promise<{ connectorId: string; organizationId: string } | null> {
    if (!isHash(creatorHash)) return null;
    try {
      const raw = parse(await this.read(TelegramClaimStore.CLAIM_PREFIX + creatorHash));
      if (!raw || typeof raw.connectorId !== 'string' || typeof raw.organizationId !== 'string') return null;
      if (typeof raw.expiresAt !== 'number' || raw.expiresAt < now) return null;
      if (!raw.connectorId || !raw.organizationId) return null;
      return { connectorId: raw.connectorId, organizationId: raw.organizationId };
    } catch (err) {
      this.warn('read a link request', err);
      return null;
    }
  }

  async forgetClaim(creatorHash: string): Promise<void> {
    if (!isHash(creatorHash)) return;
    try {
      await this.prisma.siteSettings.deleteMany({ where: { key: TelegramClaimStore.CLAIM_PREFIX + creatorHash } });
    } catch (err) {
      this.warn('forget a link request', err);
    }
  }

  /** A bot with another username was just created and linked to nothing. */
  async noteUnmatched(now: number): Promise<void> {
    try {
      await this.write(TelegramClaimStore.LAST_UNMATCHED_KEY, String(now));
    } catch (err) {
      this.warn('note an unmatched bot', err);
    }
  }

  /** When the last such bot was created on this instance, or null. */
  async lastUnmatchedAt(): Promise<number | null> {
    try {
      const value = Number(await this.read(TelegramClaimStore.LAST_UNMATCHED_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch (err) {
      this.warn('read the last unmatched bot', err);
      return null;
    }
  }

  private async read(key: string): Promise<string | null> {
    const row = await this.prisma.siteSettings.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
  }

  private async write(key: string, value: string): Promise<void> {
    const upsert = () => this.prisma.siteSettings.upsert({ where: { key }, update: { value }, create: { key, value } });
    try {
      await upsert();
    } catch {
      // Two processes created the same row at the same moment: the second try updates it.
      await upsert();
    }
  }

  /** Rows nobody will read again: past their 30 minutes, or keyed with a secret that was rotated. */
  private async sweep(now: number): Promise<void> {
    if (now - this.lastSweepAt < TelegramClaimStore.SWEEP_EVERY_MS) return;
    this.lastSweepAt = now;
    try {
      await this.prisma.siteSettings.deleteMany({
        where: {
          OR: [
            { key: { startsWith: TelegramClaimStore.BOT_PREFIX } },
            { key: { startsWith: TelegramClaimStore.CLAIM_PREFIX } },
          ],
          // Twice the lifetime: a row is never deleted while it can still be read.
          updatedAt: { lt: new Date(now - 2 * MANAGED_BOT_TTL_MS) },
        },
      });
    } catch (err) {
      this.warn('delete expired rows', err);
    }
  }

  /** A name only: an error's message could quote a key or a value. */
  private warn(what: string, err: unknown): void {
    this.logger.warn(`Could not ${what} for the one-tap Telegram bot (${(err as Error)?.name || 'error'})`);
  }
}

function isHash(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function newest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

function parse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const raw: unknown = JSON.parse(value);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A remembered bot, while it is younger than a setup's lifetime. */
function readBot(
  value: string | null,
  now: number,
): { botId: number; updateId: number | null; at: number; usedAt: number | null } | null {
  const raw = parse(value);
  if (!raw || typeof raw.botId !== 'number' || !Number.isSafeInteger(raw.botId)) return null;
  if (typeof raw.at !== 'number' || now - raw.at > MANAGED_BOT_TTL_MS) return null;
  return {
    botId: raw.botId,
    updateId: typeof raw.updateId === 'number' && Number.isSafeInteger(raw.updateId) ? raw.updateId : null,
    at: raw.at,
    usedAt: typeof raw.usedAt === 'number' ? raw.usedAt : null,
  };
}
