import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import { SiteSettingsAdminController, SiteSettingsMemberController } from './site-settings.controller';
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

// Admins save footer links per workspace, but the footer read only the
// instance-wide list, so on Cloud a workspace's own links never showed.
describe('SiteSettingsMemberController footer links', () => {
  it("returns the caller's workspace links, or the fallback the service gives", async () => {
    const orgSettings = {
      getFooterLinks: jest.fn(async (orgId: string) =>
        orgId === 'org1' ? [{ label: 'Privacy', url: 'https://acme.test/privacy' }] : null,
      ),
    };
    const controller = new SiteSettingsMemberController(orgSettings as any);
    await expect(controller.getFooterLinks({ user: { organizationId: 'org1' } })).resolves.toEqual([
      { label: 'Privacy', url: 'https://acme.test/privacy' },
    ]);
    await expect(controller.getFooterLinks({ user: { organizationId: 'org2' } })).resolves.toEqual([]);
    expect(orgSettings.getFooterLinks).toHaveBeenCalledWith('org1');
  });

  it('answers an empty list without a workspace on the token', async () => {
    const orgSettings = { getFooterLinks: jest.fn() };
    const controller = new SiteSettingsMemberController(orgSettings as any);
    await expect(controller.getFooterLinks({ user: {} })).resolves.toEqual([]);
    expect(orgSettings.getFooterLinks).not.toHaveBeenCalled();
  });

  it('requires a signed-in user, with no role restriction', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, SiteSettingsMemberController) ?? [];
    expect(guards).toHaveLength(1);
    expect(Reflect.getMetadata('roles', SiteSettingsMemberController)).toBeUndefined();
  });
});
