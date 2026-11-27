import { createHash } from 'crypto';
import { HttpStatus } from '@nestjs/common';
import {
  emailDigest,
  formatUtc,
  PasswordSignInLimiter,
  RESET_MAILS_PER_HOUR,
  signInPausedException,
  signInPausedMessage,
  type PasswordSignInContext,
} from './password-sign-in-limiter';
import { SecurityEvents } from '../audit/security-event.service';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 14, 3);
const CTX: PasswordSignInContext = { surface: 'dashboard', ip: '203.0.113.7', userAgent: 'jest' };
const ACCOUNT = { id: 'u1', email: 'owner@example.com', organizationId: 'org-1' };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeLimiter(redis?: any) {
  const securityEvents = { log: jest.fn(async (_input: any) => undefined) };
  const emailService = { sendSignInPausedEmail: jest.fn(async (_to: string, _input: any) => true) };
  const config = { get: jest.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://app.example.test/' : undefined)) };
  const limiter = new PasswordSignInLimiter(redis, securityEvents as any, emailService as any, config as any);
  return { limiter, securityEvents, emailService };
}

async function fail(
  limiter: PasswordSignInLimiter,
  times: number,
  now: number,
  email = ACCOUNT.email,
  account: typeof ACCOUNT | null = ACCOUNT,
) {
  for (let i = 0; i < times; i++) {
    await limiter.failed(email, account ? 'wrong_password' : 'unknown_account', CTX, account, now);
  }
}

describe('PasswordSignInLimiter', () => {
  describe('counting failed sign-ins per address', () => {
    it('pauses for 15 minutes after 10 failures within 15 minutes', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 9, T0);
      expect(await limiter.check(ACCOUNT.email, T0)).toEqual({ paused: false });
      await fail(limiter, 1, T0 + 5 * MIN);
      const check = await limiter.check(ACCOUNT.email, T0 + 5 * MIN);
      expect(check).toEqual({
        paused: true,
        retryAfterMs: 15 * MIN,
        message: 'Too many sign-in attempts. Try again in 15 minutes, or reset your password.',
      });
      expect((await limiter.check(ACCOUNT.email, T0 + 19 * MIN)).paused).toBe(true);
      expect(await limiter.check(ACCOUNT.email, T0 + 20 * MIN + 1)).toEqual({ paused: false });
    });

    it('does not pause for 10 failures spread over more than 15 minutes', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 9, T0);
      await fail(limiter, 1, T0 + 16 * MIN);
      expect((await limiter.check(ACCOUNT.email, T0 + 16 * MIN)).paused).toBe(false);
    });

    it('pauses for an hour after 20 failures within an hour', async () => {
      const { limiter } = makeLimiter();
      // Never 10 within one 15-minute window, 20 within the hour.
      await fail(limiter, 9, T0);
      await fail(limiter, 9, T0 + 16 * MIN);
      await fail(limiter, 1, T0 + 32 * MIN);
      expect((await limiter.check(ACCOUNT.email, T0 + 32 * MIN)).paused).toBe(false);
      await fail(limiter, 1, T0 + 33 * MIN);
      const check = await limiter.check(ACCOUNT.email, T0 + 33 * MIN);
      expect(check.paused && check.retryAfterMs).toBe(60 * MIN);
      expect(check.paused && check.message).toBe(
        'Too many sign-in attempts. Try again in 60 minutes, or reset your password.',
      );
    });

    it('goes from a 15-minute pause to an hour when failures go on after it', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 10, T0);
      expect((await limiter.check(ACCOUNT.email, T0)).paused).toBe(true);
      await fail(limiter, 10, T0 + 16 * MIN);
      const check = await limiter.check(ACCOUNT.email, T0 + 16 * MIN);
      expect(check.paused && check.retryAfterMs).toBe(60 * MIN);
    });

    it('starts the count again after a successful sign-in', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 9, T0);
      await limiter.succeeded(ACCOUNT.email, CTX, ACCOUNT);
      await fail(limiter, 9, T0 + MIN);
      expect((await limiter.check(ACCOUNT.email, T0 + MIN)).paused).toBe(false);
    });

    it('ends the pause and starts the count again after a password reset', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 10, T0);
      expect((await limiter.check(ACCOUNT.email, T0)).paused).toBe(true);
      await limiter.clear(ACCOUNT.email);
      expect((await limiter.check(ACCOUNT.email, T0)).paused).toBe(false);
      await fail(limiter, 9, T0 + MIN);
      expect((await limiter.check(ACCOUNT.email, T0 + MIN)).paused).toBe(false);
    });

    it('counts an address with no account exactly like one with an account', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 10, T0, 'nobody@example.com', null);
      await fail(limiter, 10, T0, ACCOUNT.email, ACCOUNT);
      const unknown = await limiter.check('nobody@example.com', T0);
      const known = await limiter.check(ACCOUNT.email, T0);
      expect(unknown).toEqual(known);
      expect(unknown.paused).toBe(true);
    });

    it('treats case and surrounding spaces as the same address', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 5, T0, ' Owner@Example.COM ');
      await fail(limiter, 5, T0, 'owner@example.com');
      expect((await limiter.check('OWNER@example.com', T0)).paused).toBe(true);
    });

    it('keeps each address separate', async () => {
      const { limiter } = makeLimiter();
      await fail(limiter, 10, T0);
      expect((await limiter.check('someone-else@example.com', T0)).paused).toBe(false);
    });
  });

  describe('the owner email', () => {
    it('emails the owner once when the account enters a pause, with the time and a reset link', async () => {
      const { limiter, emailService } = makeLimiter();
      await fail(limiter, 10, T0);
      await flush();
      expect(emailService.sendSignInPausedEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendSignInPausedEmail).toHaveBeenCalledWith('owner@example.com', {
        resetUrl: 'https://app.example.test/forgot-password',
        minutes: 15,
        when: '27 November 2026, 14:03 UTC',
      });
    });

    it('sends at most one email an hour per account', async () => {
      const { limiter, emailService } = makeLimiter();
      await fail(limiter, 10, T0);
      // A second pause within the hour: no second email.
      await fail(limiter, 10, T0 + 16 * MIN);
      await flush();
      expect(emailService.sendSignInPausedEmail).toHaveBeenCalledTimes(1);
      // A pause more than an hour after the first email: a new one.
      await fail(limiter, 10, T0 + 3 * 60 * MIN);
      await flush();
      expect(emailService.sendSignInPausedEmail).toHaveBeenCalledTimes(2);
    });

    it('sends nothing for an address with no account', async () => {
      const { limiter, emailService } = makeLimiter();
      await fail(limiter, 10, T0, 'nobody@example.com', null);
      await flush();
      expect(emailService.sendSignInPausedEmail).not.toHaveBeenCalled();
    });

    it('does not fail the sign-in when the email cannot be sent', async () => {
      const { limiter, emailService } = makeLimiter();
      emailService.sendSignInPausedEmail.mockRejectedValueOnce(new Error('smtp down'));
      await expect(fail(limiter, 10, T0)).resolves.toBeUndefined();
      await flush();
    });
  });

  describe('sign-in events', () => {
    it('records a failure with its reason, the account and the request', async () => {
      const { limiter, securityEvents } = makeLimiter();
      await limiter.failed(ACCOUNT.email, 'wrong_password', CTX, ACCOUNT, T0);
      expect(securityEvents.log).toHaveBeenCalledWith({
        event: SecurityEvents.PASSWORD_LOGIN_FAILED,
        actorType: 'ANONYMOUS',
        organizationId: 'org-1',
        targetUserId: 'u1',
        metadata: { reason: 'wrong_password', surface: 'dashboard' },
        ip: '203.0.113.7',
        userAgent: 'jest',
      });
    });

    it('stores only a hash of an address with no account, never the address', async () => {
      const { limiter, securityEvents } = makeLimiter();
      await limiter.failed(' Nobody@Example.com', 'unknown_account', CTX, null, T0);
      const input = securityEvents.log.mock.calls[0][0];
      expect(input.metadata).toEqual({
        reason: 'unknown_account',
        surface: 'dashboard',
        emailHash: createHash('sha256').update('nobody@example.com').digest('hex'),
      });
      expect(input.targetUserId).toBeNull();
      expect(JSON.stringify(securityEvents.log.mock.calls)).not.toMatch(/nobody@example\.com/i);
    });

    it('records a refused sign-in while paused with reason "paused"', async () => {
      const { limiter, securityEvents } = makeLimiter();
      limiter.refused(ACCOUNT.email, CTX, ACCOUNT);
      expect(securityEvents.log.mock.calls[0][0]).toMatchObject({
        event: SecurityEvents.PASSWORD_LOGIN_FAILED,
        metadata: { reason: 'paused', surface: 'dashboard' },
      });
    });

    it('records the start of a pause once', async () => {
      const { limiter, securityEvents } = makeLimiter();
      await fail(limiter, 10, T0, 'nobody@example.com', null);
      const paused = securityEvents.log.mock.calls.map((c) => c[0]).filter((e) => e.event === SecurityEvents.SIGN_IN_PAUSED);
      expect(paused).toHaveLength(1);
      expect(paused[0].metadata).toEqual({
        pauseMinutes: 15,
        surface: 'dashboard',
        emailHash: emailDigest('nobody@example.com'),
      });
    });

    it('records a successful sign-in', async () => {
      const { limiter, securityEvents } = makeLimiter();
      await limiter.succeeded(ACCOUNT.email, { ...CTX, surface: 'authorization_page' }, ACCOUNT);
      expect(securityEvents.log).toHaveBeenCalledWith({
        event: SecurityEvents.PASSWORD_LOGIN_SUCCESS,
        actorType: 'USER',
        organizationId: 'org-1',
        actorUserId: 'u1',
        metadata: { surface: 'authorization_page' },
        ip: '203.0.113.7',
        userAgent: 'jest',
      });
    });

    it('never waits for or fails on writing an event', async () => {
      const { limiter, securityEvents } = makeLimiter();
      securityEvents.log.mockImplementation(() => new Promise(() => undefined));
      await expect(limiter.failed(ACCOUNT.email, 'wrong_password', CTX, ACCOUNT, T0)).resolves.toBeUndefined();
      securityEvents.log.mockRejectedValue(new Error('db down'));
      await expect(limiter.succeeded(ACCOUNT.email, CTX, ACCOUNT)).resolves.toBeUndefined();
    });
  });

  describe('password reset emails per address', () => {
    it(`allows ${RESET_MAILS_PER_HOUR} an hour, then refuses until the hour is over`, async () => {
      const { limiter } = makeLimiter();
      for (let i = 0; i < RESET_MAILS_PER_HOUR; i++) {
        expect(await limiter.resetMailAllowed('Owner@example.com ', T0 + i * MIN)).toBe(true);
      }
      expect(await limiter.resetMailAllowed('owner@example.com', T0 + 10 * MIN)).toBe(false);
      expect(await limiter.resetMailAllowed('other@example.com', T0 + 10 * MIN)).toBe(true);
      expect(await limiter.resetMailAllowed('owner@example.com', T0 + 61 * MIN)).toBe(true);
    });
  });

  describe('with Redis', () => {
    function fakeRedis() {
      const values = new Map<string, string>();
      return {
        values,
        isConnected: true,
        incr: jest.fn(async (key: string) => {
          const next = Number(values.get(key) ?? 0) + 1;
          values.set(key, String(next));
          return next;
        }),
        expire: jest.fn(async () => undefined),
        get: jest.fn(async (key: string) => values.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => void values.set(key, value)),
        del: jest.fn(async (key: string) => void values.delete(key)),
      };
    }

    it('keeps counts and pauses in Redis under namespaced keys without the address', async () => {
      const redis = fakeRedis();
      const { limiter } = makeLimiter(redis);
      await fail(limiter, 10, T0);
      const digest = emailDigest(ACCOUNT.email);
      expect(redis.set).toHaveBeenCalledWith(`signin:paused:${digest}`, String(T0 + 15 * MIN), 15 * 60);
      expect(redis.expire).toHaveBeenCalledWith(`signin:failures:quarter:${digest}`, 15 * 60);
      expect(redis.expire).toHaveBeenCalledWith(`signin:failures:hour:${digest}`, 60 * 60);
      for (const key of redis.values.keys()) {
        expect(key).toMatch(/^signin:/);
        expect(key).not.toContain('owner@example.com');
      }
      // Another process with the same Redis sees the pause.
      const other = makeLimiter(redis).limiter;
      expect((await other.check(ACCOUNT.email, T0 + MIN)).paused).toBe(true);
    });

    it('falls back to memory when Redis fails, without failing the sign-in', async () => {
      const redis = fakeRedis();
      redis.incr.mockRejectedValue(new Error('down'));
      redis.set.mockRejectedValue(new Error('down'));
      redis.get.mockRejectedValue(new Error('down'));
      const { limiter } = makeLimiter(redis);
      await fail(limiter, 10, T0);
      expect((await limiter.check(ACCOUNT.email, T0)).paused).toBe(true);
    });
  });

  describe('the answer while paused', () => {
    it('rounds up to whole minutes, at least one', () => {
      expect(signInPausedMessage(14 * MIN + 1)).toBe(
        'Too many sign-in attempts. Try again in 15 minutes, or reset your password.',
      );
      expect(signInPausedMessage(5_000)).toBe(
        'Too many sign-in attempts. Try again in 1 minute, or reset your password.',
      );
    });

    it('is status 429, as the throttle answers', () => {
      const err = signInPausedException({ retryAfterMs: MIN, message: signInPausedMessage(MIN) });
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(err.getResponse()).toMatchObject({ statusCode: 429, message: signInPausedMessage(MIN) });
    });

    it('formats the time of the pause in UTC', () => {
      expect(formatUtc(Date.UTC(2026, 0, 5, 9, 7))).toBe('5 January 2026, 09:07 UTC');
    });
  });
});
