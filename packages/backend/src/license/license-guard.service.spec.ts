import { ForbiddenException } from '@nestjs/common';
import { LicenseGuardService, TrialEndedException } from './license-guard.service';

describe('LicenseGuardService.checkLicenseActive (cloud)', () => {
  const day = 24 * 60 * 60 * 1000;

  function make(license: any, lastInactive: any = null, cloud = true) {
    const licenseService = {
      getCurrentLicense: jest.fn().mockResolvedValue(license),
      getLatestInactiveLicense: jest.fn().mockResolvedValue(lastInactive),
    };
    const deployment = { isCloud: () => cloud };
    return new LicenseGuardService({} as any, licenseService as any, deployment as any);
  }

  it('lets an active paid licence without expiry through', async () => {
    await expect(make({ plan: 'starter', status: 'active', expiresAt: null }).checkLicenseActive('o1')).resolves.toBeUndefined();
  });

  it('lets a paid licence in its payment grace period through until the date', async () => {
    const until = new Date(Date.now() + 2 * day);
    await expect(make({ plan: 'team', status: 'active', expiresAt: until }).checkLicenseActive('o1')).resolves.toBeUndefined();
  });

  it('stops a paid licence once its expiresAt has passed (it used to apply to trials only)', async () => {
    const past = new Date(Date.now() - day);
    await expect(make({ plan: 'team', status: 'active', expiresAt: past }).checkLicenseActive('o1')).rejects.toThrow(
      "This workspace's license has expired",
    );
  });

  it('still tells a trial its trial has ended', async () => {
    const past = new Date(Date.now() - day);
    await expect(make({ plan: 'trial', status: 'active', expiresAt: past }).checkLicenseActive('o1')).rejects.toThrow(
      'trial has ended',
    );
  });

  it('stops a licence that is not active, and a workspace with none', async () => {
    await expect(make({ plan: 'starter', status: 'revoked' }).checkLicenseActive('o1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make(null).checkLicenseActive('o1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws a TrialEndedException carrying the end date for a trial past its end', async () => {
    const past = new Date(Date.now() - day);
    const err = await make({ plan: 'trial', status: 'active', expiresAt: past }).checkLicenseActive('o1').catch((e) => e);
    expect(err).toBeInstanceOf(TrialEndedException);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.trialEndedAt).toEqual(past);
    expect(err.message).toBe("This workspace's trial has ended. Ask a workspace administrator to activate a license.");
  });

  it('also once the cron has flipped the trial to expired', async () => {
    const past = new Date(Date.now() - 3 * day);
    const err = await make(null, { plan: 'trial', status: 'expired', expiresAt: past }).checkLicenseActive('o1').catch((e) => e);
    expect(err).toBeInstanceOf(TrialEndedException);
    expect(err.trialEndedAt).toEqual(past);
  });

  it('keeps the other messages, never as a TrialEndedException', async () => {
    const past = new Date(Date.now() - day);
    const cases: Array<[any, any, string]> = [
      [null, null, 'This workspace has no active license. Ask a workspace administrator to activate one.'],
      // The newest inactive licence is a paid one revoked after the trial.
      [null, { plan: 'starter', status: 'revoked', expiresAt: null }, 'This workspace has no active license.'],
      // A trial revoked by hand is not one that simply ended.
      [null, { plan: 'trial', status: 'revoked', expiresAt: past }, 'This workspace has no active license.'],
      [{ plan: 'team', status: 'active', expiresAt: past }, null, "This workspace's license has expired. Ask a workspace administrator to renew it."],
    ];
    for (const [current, last, message] of cases) {
      const err = await make(current, last).checkLicenseActive('o1').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err).not.toBeInstanceOf(TrialEndedException);
      expect(err.message).toContain(message);
    }
  });

  it('does nothing on self-hosted', async () => {
    const past = new Date(Date.now() - day);
    await expect(make({ plan: 'trial', status: 'active', expiresAt: past }, null, false).checkLicenseActive('o1')).resolves.toBeUndefined();
  });
});

describe('LicenseGuardService.getTrialState', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-06T12:00:00Z');

  function make(current: any, lastInactive: any = null, cloud = true) {
    const licenseService = {
      getCurrentLicense: jest.fn().mockResolvedValue(current),
      getLatestInactiveLicense: jest.fn().mockResolvedValue(lastInactive),
    };
    return new LicenseGuardService({} as any, licenseService as any, { isCloud: () => cloud } as any);
  }

  it('reports a running trial, with the card trial while 48 hours remain', async () => {
    const ends = new Date(now.getTime() + 5 * day);
    await expect(make({ plan: 'trial', status: 'active', expiresAt: ends }).getTrialState('o1', now)).resolves.toEqual({
      endsAt: ends,
      active: true,
      cardTrialAvailable: true,
    });
    const soon = new Date(now.getTime() + day);
    await expect(make({ plan: 'trial', status: 'active', expiresAt: soon }).getTrialState('o1', now)).resolves.toMatchObject({
      active: true,
      cardTrialAvailable: false,
    });
  });

  it('reports a trial past its end, and one whose licence is no longer active', async () => {
    const past = new Date(now.getTime() - day);
    await expect(make({ plan: 'trial', status: 'active', expiresAt: past }).getTrialState('o1', now)).resolves.toMatchObject({
      active: false,
    });
    await expect(make(null, { plan: 'trial', status: 'expired', expiresAt: past }).getTrialState('o1', now)).resolves.toEqual({
      endsAt: past,
      active: false,
      cardTrialAvailable: false,
    });
  });

  it('is null on a paid plan, with no licence, without a workspace, and on self-hosted', async () => {
    const ends = new Date(now.getTime() + 5 * day);
    await expect(make({ plan: 'starter', status: 'active', expiresAt: null }).getTrialState('o1', now)).resolves.toBeNull();
    await expect(make(null, { plan: 'starter', status: 'revoked', expiresAt: null }).getTrialState('o1', now)).resolves.toBeNull();
    await expect(make(null).getTrialState('o1', now)).resolves.toBeNull();
    await expect(make({ plan: 'trial', status: 'active', expiresAt: ends }).getTrialState(undefined, now)).resolves.toBeNull();
    await expect(make({ plan: 'trial', status: 'active', expiresAt: ends }, null, false).getTrialState('o1', now)).resolves.toBeNull();
  });
});

describe('LicenseGuardService.getUsage', () => {
  function make(features: Record<string, number>) {
    const prisma = {
      connector: { count: jest.fn().mockResolvedValue(7) },
      mcpServerConfig: { count: jest.fn().mockResolvedValue(2) },
      organizationMember: { count: jest.fn().mockResolvedValue(2) },
      user: { count: jest.fn().mockResolvedValue(1) },
    };
    const licenseService = {
      getCurrentLicense: jest.fn().mockResolvedValue({ plan: 'starter', status: 'active', features }),
    };
    const guard = new LicenseGuardService(prisma as any, licenseService as any, { isCloud: () => true } as any);
    return { guard, prisma };
  }

  it('counts the workspace users by active membership, so members invited from another workspace count', async () => {
    const { guard, prisma } = make({ maxConnectors: 5, maxMcpServers: 3, maxUsers: 1 });
    const usage = await guard.getUsage('u1', 'org_2');
    expect(prisma.organizationMember.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_2', deactivatedAt: null },
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(usage.users).toEqual({ current: 2, max: 1, isOver: true });
    expect(usage.connectors).toEqual({ current: 7, max: 5, isOver: true });
    expect(usage.mcpServers).toEqual({ current: 2, max: 3, isOver: false });
    expect(usage.isOverAny).toBe(true);
  });
});
