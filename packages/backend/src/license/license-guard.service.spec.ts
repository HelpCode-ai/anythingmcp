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
