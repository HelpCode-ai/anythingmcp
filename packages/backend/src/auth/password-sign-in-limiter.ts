import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../common/redis.service';
import { ExpiringCounterStore } from '../common/expiring-counter.store';
import { normalizeEmail } from '../common/email.util';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { EmailService } from '../settings/email.service';
import { maskEmail } from './mcp-email-verification';

const MINUTE = 60_000;

/**
 * Sign-in attempt limits per address. A failure counts in both windows; the
 * first rule whose window holds `maxFailures` pauses password sign-in for
 * that address for `pauseMs`. Longest pause first.
 */
export const SIGN_IN_LIMITS = [
  { name: 'hour', windowMs: 60 * MINUTE, maxFailures: 20, pauseMs: 60 * MINUTE },
  { name: 'quarter', windowMs: 15 * MINUTE, maxFailures: 10, pauseMs: 15 * MINUTE },
] as const;

/** Password reset emails per address per hour. */
export const RESET_MAILS_PER_HOUR = 3;

/** At most one "password sign-in is paused" email per account in this time. */
export const PAUSE_NOTICE_INTERVAL_MS = 60 * MINUTE;

export type PasswordSignInSurface = 'dashboard' | 'authorization_page' | 'accept_invite';

export type PasswordSignInFailure = 'unknown_account' | 'wrong_password' | 'password_login_disabled';

/** Who is signing in, for the sign-in events. */
export interface PasswordSignInContext {
  surface: PasswordSignInSurface;
  ip?: string | null;
  userAgent?: string | null;
}

/** The account behind the address, when there is one. */
export interface PasswordSignInAccount {
  id: string;
  email: string;
  organizationId?: string | null;
}

export type PasswordSignInCheck = { paused: false } | { paused: true; retryAfterMs: number; message: string };

/** SHA-256 of the normalised address: the key of its counters, and what events store for an address with no account. */
export function emailDigest(email: string): string {
  return createHash('sha256').update(normalizeEmail(String(email ?? ''))).digest('hex');
}

/** The answer while password sign-in for an address is paused. */
export function signInPausedMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / MINUTE));
  return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or reset your password.`;
}

/** The API answer while paused: status 429, as the per-address throttle answers. */
export function signInPausedException(check: { retryAfterMs: number; message: string }): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: check.message },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Sign-in attempt limits for every password check that signs someone in:
 * POST /api/auth/login, the password form of the authorization page
 * (POST /auth/login) and the password branch of POST /api/auth/accept-invite.
 *
 * Failures are counted per normalised address, whether or not it has an
 * account, so the answer is the same either way. After 10 failures within
 * 15 minutes, password sign-in for that address is paused for 15 minutes;
 * after 20 within an hour, for an hour. While paused, callers refuse before
 * any password is compared. A successful sign-in resets the count; a
 * completed password reset resets the count and ends the pause. Signing in
 * with a provider, single sign-on, an existing session and the password
 * reset flow never pass through here, so a pause does not affect them.
 *
 * When an existing account enters a pause, its owner gets one email (at most
 * one an hour). Every sign-in writes a security event. Events, emails and
 * counters never throw and never hold up the answer longer than a Redis call.
 *
 * Redis when configured (shared by every backend process), else a bounded
 * in-memory store in this process.
 */
@Injectable()
export class PasswordSignInLimiter {
  private readonly logger = new Logger(PasswordSignInLimiter.name);
  private readonly store: ExpiringCounterStore;

  constructor(
    @Optional() redis?: RedisService,
    @Optional() private readonly securityEvents?: SecurityEventService,
    @Optional() private readonly emailService?: EmailService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.store = new ExpiringCounterStore(redis);
  }

  private failuresKey(digest: string, rule: (typeof SIGN_IN_LIMITS)[number]): string {
    return `signin:failures:${rule.name}:${digest}`;
  }

  private pauseKey(digest: string): string {
    return `signin:paused:${digest}`;
  }

  /** Whether password sign-in for this address is paused right now. Run before comparing any password. */
  async check(email: string, now = Date.now()): Promise<PasswordSignInCheck> {
    try {
      const retryAfterMs = await this.store.heldFor(this.pauseKey(emailDigest(email)), now);
      if (retryAfterMs > 0) return { paused: true, retryAfterMs, message: signInPausedMessage(retryAfterMs) };
    } catch (err: any) {
      this.logger.warn(`Could not read the sign-in pause: ${err?.message ?? err}`);
    }
    return { paused: false };
  }

  /** Records a sign-in refused because the address is paused (no password was compared). */
  refused(email: string, ctx: PasswordSignInContext, account?: PasswordSignInAccount | null): void {
    this.logFailure(email, 'paused', ctx, account);
  }

  /**
   * Counts a failed password sign-in for this address and records it. Starts
   * a pause when a limit is reached. Never throws.
   */
  async failed(
    email: string,
    reason: PasswordSignInFailure,
    ctx: PasswordSignInContext,
    account?: PasswordSignInAccount | null,
    now = Date.now(),
  ): Promise<void> {
    this.logFailure(email, reason, ctx, account);
    try {
      const digest = emailDigest(email);
      const counts = await Promise.all(
        SIGN_IN_LIMITS.map((rule) => this.store.increment(this.failuresKey(digest, rule), rule.windowMs, now)),
      );
      const index = SIGN_IN_LIMITS.findIndex((rule, i) => counts[i] >= rule.maxFailures);
      if (index === -1) return;
      const rule = SIGN_IN_LIMITS[index];
      await this.store.holdFor(this.pauseKey(digest), rule.pauseMs, now);
      // This rule's count starts again; a longer window keeps counting, so
      // failures right after a short pause lead to the longer one.
      await this.store.reset(...SIGN_IN_LIMITS.slice(index).map((r) => this.failuresKey(digest, r)));
      this.logEvent(SecurityEvents.SIGN_IN_PAUSED, email, ctx, account, { pauseMinutes: rule.pauseMs / MINUTE });
      if (account) void this.noticeOwner(account, rule.pauseMs, now);
    } catch (err: any) {
      this.logger.warn(`Could not count a failed sign-in: ${err?.message ?? err}`);
    }
  }

  /** A password sign-in succeeded: the count for this address starts again. Never throws. */
  async succeeded(email: string, ctx: PasswordSignInContext, account: PasswordSignInAccount): Promise<void> {
    void this.securityEvents
      ?.log({
        event: SecurityEvents.PASSWORD_LOGIN_SUCCESS,
        actorType: 'USER',
        organizationId: account.organizationId ?? null,
        actorUserId: account.id,
        metadata: { surface: ctx.surface },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .catch(() => undefined);
    await this.resetCounts(emailDigest(email));
  }

  /** A password reset was completed: the count starts again and any pause ends. Never throws. */
  async clear(email: string): Promise<void> {
    const digest = emailDigest(email);
    await this.resetCounts(digest);
    try {
      await this.store.reset(this.pauseKey(digest));
    } catch {
      // The pause expires by itself.
    }
  }

  /**
   * Whether another password reset email may go to this address in this
   * hour; counts this request. At most RESET_MAILS_PER_HOUR. Never throws.
   */
  async resetMailAllowed(email: string, now = Date.now()): Promise<boolean> {
    try {
      const count = await this.store.increment(`pwreset:mails:${emailDigest(email)}`, 60 * MINUTE, now);
      return count <= RESET_MAILS_PER_HOUR;
    } catch {
      return true;
    }
  }

  private async resetCounts(digest: string): Promise<void> {
    try {
      await this.store.reset(...SIGN_IN_LIMITS.map((rule) => this.failuresKey(digest, rule)));
    } catch {
      // The counts expire by themselves.
    }
  }

  private logFailure(
    email: string,
    reason: PasswordSignInFailure | 'paused',
    ctx: PasswordSignInContext,
    account?: PasswordSignInAccount | null,
  ): void {
    this.logEvent(SecurityEvents.PASSWORD_LOGIN_FAILED, email, ctx, account, { reason });
  }

  /** Fire and forget: SecurityEventService.log never throws, and nothing waits for it. */
  private logEvent(
    event: string,
    email: string,
    ctx: PasswordSignInContext,
    account: PasswordSignInAccount | null | undefined,
    metadata: Record<string, unknown>,
  ): void {
    void this.securityEvents
      ?.log({
        event,
        actorType: 'ANONYMOUS',
        organizationId: account?.organizationId ?? null,
        targetUserId: account?.id ?? null,
        metadata: {
          ...metadata,
          surface: ctx.surface,
          ...(account ? {} : { emailHash: emailDigest(email) }),
        },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .catch(() => undefined);
  }

  /** Emails the owner that password sign-in is paused, at most once an hour per account. */
  private async noticeOwner(account: PasswordSignInAccount, pauseMs: number, now: number): Promise<void> {
    if (!this.emailService) return;
    try {
      const sent = await this.store.increment(`signin:pause-notice:${account.id}`, PAUSE_NOTICE_INTERVAL_MS, now);
      if (sent !== 1) return;
      const base = (
        this.configService?.get<string>('FRONTEND_URL') ||
        this.configService?.get<string>('SERVER_URL') ||
        'http://localhost:3000'
      ).replace(/\/+$/, '');
      await this.emailService.sendSignInPausedEmail(account.email, {
        resetUrl: `${base}/forgot-password`,
        minutes: Math.round(pauseMs / MINUTE),
        when: formatUtc(now),
      });
    } catch (err: any) {
      this.logger.warn(`Sign-in pause notice for ${maskEmail(account.email)} failed: ${err?.message ?? err}`);
    }
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "27 November 2026, 14:03 UTC". */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
