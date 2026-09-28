import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  BUSINESS_TRIAL_DAYS,
  COMMUNITY_SEAT_LIMIT,
  EditionService,
  TRANSITION_DAYS,
} from './edition.service';

const DAY = 24 * 60 * 60 * 1000;

function make(opts: {
  cloud?: boolean;
  license?: any;
  settings?: Record<string, string>;
  seats?: number;
  providers?: number;
  activeMemberships?: number;
}) {
  const settings: Record<string, string> = { ...(opts.settings ?? {}) };
  const prisma = {
    user: { count: jest.fn(async () => opts.seats ?? 1) },
    identityProvider: { count: jest.fn(async () => opts.providers ?? 0) },
    organizationMember: { count: jest.fn(async () => opts.activeMemberships ?? 0) },
  };
  const siteSettings = {
    get: jest.fn(async (k: string) => (k in settings ? settings[k] : null)),
    set: jest.fn(async (k: string, v: string) => {
      settings[k] = v;
    }),
  };
  const licenses = { getCurrentLicense: jest.fn(async () => opts.license ?? null) };
  const deployment = { isCloud: () => !!opts.cloud };
  const service = new EditionService(
    prisma as any,
    deployment as any,
    siteSettings as any,
    licenses as any,
  );
  return { service, settings, prisma };
}

describe('EditionService', () => {
  describe('getState', () => {
    it('is Community with the Community user limit by default', async () => {
      const { service } = make({ seats: 2 });
      const s = await service.getState();
      expect(s).toMatchObject({
        edition: 'community',
        business: false,
        source: null,
        seatLimit: COMMUNITY_SEAT_LIMIT,
        seatsUsed: 2,
        trialAvailable: true,
      });
    });

    it('treats a community licence key as Community', async () => {
      const { service } = make({ license: { plan: 'community', status: 'active', expiresAt: null } });
      expect((await service.getState()).edition).toBe('community');
    });

    it('is Business with an active paid licence, using its user count when higher', async () => {
      const { service } = make({
        license: { plan: 'business', status: 'active', expiresAt: null, features: { maxUsers: 10 } },
      });
      const s = await service.getState();
      expect(s).toMatchObject({ edition: 'business', source: 'license', seatLimit: 10, trialAvailable: false });
    });

    it('never gives a paid licence fewer users than Community', async () => {
      const { service } = make({
        license: { plan: 'starter', status: 'active', expiresAt: null, features: { maxUsers: 1 } },
      });
      expect((await service.getState()).seatLimit).toBe(COMMUNITY_SEAT_LIMIT);
    });

    it('has no user limit when the licence carries none', async () => {
      const { service } = make({
        license: { plan: 'enterprise', status: 'active', expiresAt: null, features: { maxUsers: null } },
      });
      expect((await service.getState()).seatLimit).toBeNull();
    });

    it('falls back to Community when the licence is expired, revoked or past its date', async () => {
      for (const license of [
        { plan: 'business', status: 'expired', expiresAt: null },
        { plan: 'business', status: 'revoked', expiresAt: null },
        { plan: 'team', status: 'active', expiresAt: new Date(Date.now() - DAY) },
      ]) {
        const { service } = make({ license });
        expect((await service.getState()).edition).toBe('community');
      }
    });

    it('is Business without a user limit during the trial, and Community after it', async () => {
      const now = new Date();
      const running = make({ settings: { business_trial_ends_at: new Date(now.getTime() + DAY).toISOString() } });
      expect(await running.service.getState(now)).toMatchObject({
        edition: 'business',
        source: 'trial',
        seatLimit: null,
        trialAvailable: false,
      });

      const over = make({ settings: { business_trial_ends_at: new Date(now.getTime() - DAY).toISOString() } });
      expect(await over.service.getState(now)).toMatchObject({
        edition: 'community',
        trialAvailable: false,
        trialEndsAt: expect.any(String),
      });
    });

    it('is Business during the transition period, and reports its end', async () => {
      const until = new Date(Date.now() + 10 * DAY).toISOString();
      const { service } = make({ settings: { business_transition_until: until } });
      expect(await service.getState()).toMatchObject({ source: 'transition', transitionUntil: until });
    });

    it('is never limited in cloud', async () => {
      const { service } = make({ cloud: true, seats: 50 });
      expect(await service.getState()).toMatchObject({ edition: 'cloud', business: true, seatLimit: null });
    });
  });

  describe('seats', () => {
    it('refuses a new user once the limit is reached, with a recognisable code', async () => {
      const { service } = make({ seats: COMMUNITY_SEAT_LIMIT });
      await expect(service.assertSeatAvailable()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.assertSeatAvailable()).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'seat_limit' }),
      });
    });

    it('lets a new user in below the limit', async () => {
      const { service } = make({ seats: COMMUNITY_SEAT_LIMIT - 1 });
      await expect(service.assertSeatAvailable()).resolves.toBeUndefined();
    });

    it('does not count a user who is already active elsewhere on the instance', async () => {
      const { service } = make({ seats: 10, activeMemberships: 1 });
      await expect(service.assertSeatAvailable('u1')).resolves.toBeUndefined();
    });

    it('counts a user whose memberships are all deactivated', async () => {
      const { service } = make({ seats: COMMUNITY_SEAT_LIMIT, activeMemberships: 0 });
      await expect(service.assertSeatAvailable('u1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('never limits cloud', async () => {
      const { service } = make({ cloud: true, seats: 500 });
      await expect(service.assertSeatAvailable()).resolves.toBeUndefined();
    });
  });

  describe('assertBusiness', () => {
    it('names the capability in the refusal', async () => {
      const { service } = make({});
      await expect(service.assertBusiness('Single sign-on')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'edition_required',
          message: expect.stringContaining('Single sign-on'),
        }),
      });
    });

    it('passes with Business', async () => {
      const { service } = make({ license: { plan: 'business', status: 'active', expiresAt: null } });
      await expect(service.assertBusiness('Single sign-on')).resolves.toBeUndefined();
    });
  });

  describe('startTrial', () => {
    it('starts once, for BUSINESS_TRIAL_DAYS', async () => {
      const now = new Date('2026-10-01T00:00:00Z');
      const { service, settings } = make({});
      const s = await service.startTrial(now);
      expect(settings.business_trial_ends_at).toBe(new Date(now.getTime() + BUSINESS_TRIAL_DAYS * DAY).toISOString());
      expect(s).toMatchObject({ edition: 'business', source: 'trial' });
      await expect(service.startTrial(now)).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not exist in cloud', async () => {
      const { service } = make({ cloud: true });
      await expect(service.startTrial()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordTransition', () => {
    const now = new Date('2026-10-01T00:00:00Z');

    it('keeps Business for an instance that already has an identity provider', async () => {
      const { service, settings } = make({ providers: 1 });
      await service.recordTransition(now);
      expect(settings.business_transition_until).toBe(new Date(now.getTime() + TRANSITION_DAYS * DAY).toISOString());
    });

    it('keeps Business for an instance with more users than Community includes', async () => {
      const { service, settings } = make({ seats: COMMUNITY_SEAT_LIMIT + 1 });
      await service.recordTransition(now);
      expect(settings.business_transition_until).not.toBe('none');
    });

    it('records "none" for any other instance, including a fresh one', async () => {
      const { service, settings } = make({ seats: 0 });
      await service.recordTransition(now);
      expect(settings.business_transition_until).toBe('none');
    });

    it('runs only once', async () => {
      const { service, settings, prisma } = make({ settings: { business_transition_until: 'none' }, providers: 3 });
      await service.recordTransition(now);
      expect(settings.business_transition_until).toBe('none');
      expect(prisma.identityProvider.count).not.toHaveBeenCalled();
    });
  });
});
