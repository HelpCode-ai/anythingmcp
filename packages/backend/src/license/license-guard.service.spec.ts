import { ForbiddenException } from '@nestjs/common';
import { LicenseGuardService } from './license-guard.service';

describe('LicenseGuardService.checkLicenseActive (cloud)', () => {
  const day = 24 * 60 * 60 * 1000;

  function make(license: any) {
    const licenseService = { getCurrentLicense: jest.fn().mockResolvedValue(license) };
    const deployment = { isCloud: () => true };
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
