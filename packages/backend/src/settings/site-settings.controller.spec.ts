import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import { SiteSettingsAdminController } from './site-settings.controller';
import { SelfHostedOnlyGuard } from '../common/self-hosted-only.guard';
import { DeploymentService } from '../common/deployment.service';

// The SSRF allowlist is instance-wide. In cloud every sign-up is the ADMIN of
// its own workspace, so the routes that read and write it must be closed there.
describe('SiteSettingsAdminController SSRF allowlist routes', () => {
  const proto = SiteSettingsAdminController.prototype as any;

  it.each(['getSsrfAllowedHosts', 'setSsrfAllowedHosts'])(
    '%s is self-hosted only',
    (method) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, proto[method]) ?? [];
      expect(guards).toContain(SelfHostedOnlyGuard);
    },
  );

  it('the guard answers 404 in cloud and lets self-hosted through', () => {
    const cloud = new SelfHostedOnlyGuard({ isSelfHosted: () => false } as DeploymentService);
    const selfHosted = new SelfHostedOnlyGuard({ isSelfHosted: () => true } as DeploymentService);
    expect(() => cloud.canActivate({} as any)).toThrow(NotFoundException);
    expect(selfHosted.canActivate({} as any)).toBe(true);
  });
});
