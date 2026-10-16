import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolesGuard } from '../auth/roles.guard';
import { AlertsAdminController } from './alerts.controller';

function buildController(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const alerts = {
    getConfig: jest.fn().mockResolvedValue({ configured: false }),
    saveConfig: jest.fn().mockResolvedValue({}),
    deleteConfig: jest.fn().mockResolvedValue(undefined),
    testWebhook: jest.fn().mockResolvedValue({ success: true, status: 200 }),
    ...overrides,
  };
  const controller = new AlertsAdminController(alerts as any);
  return { controller, alerts };
}

const req = (organizationId = 'org1') => ({ user: { organizationId, role: 'ADMIN' } });

describe('AlertsAdminController', () => {
  it('requires the ADMIN role', () => {
    const reflector = new Reflector();
    const roles = reflector.get<string[]>(ROLES_KEY, AlertsAdminController);
    expect(roles).toEqual(['ADMIN']);
  });

  // RolesGuard's own pass/fail logic has its own spec (auth/roles.guard.spec.ts);
  // this exercises it against this controller's actual metadata, so a non-admin
  // caller hitting any of these routes is proven to get a 403, not just asserted
  // to be configured for one.
  it('rejects a non-admin caller with 403', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);
    const context = {
      getHandler: () => AlertsAdminController.prototype.getConfig,
      getClass: () => AlertsAdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: { organizationId: 'org1', role: 'EDITOR' } }) }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('lets an admin caller through', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);
    const context = {
      getHandler: () => AlertsAdminController.prototype.getConfig,
      getClass: () => AlertsAdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: { organizationId: 'org1', role: 'ADMIN' } }) }),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('getConfig delegates to the service with the caller\'s organization', async () => {
    const { controller, alerts } = buildController();
    await controller.getConfig(req('org-x'));
    expect(alerts.getConfig).toHaveBeenCalledWith('org-x');
  });

  it('saveConfig returns the secret only when the service generated one', async () => {
    const { controller, alerts } = buildController({
      saveConfig: jest.fn().mockResolvedValue({ secret: 'plain-secret' }),
    });
    const result = await controller.saveConfig(req('org-x'), {
      url: 'https://hooks.example.com/x',
      type: 'json',
    } as any);
    expect(alerts.saveConfig).toHaveBeenCalledWith('org-x', expect.objectContaining({ url: 'https://hooks.example.com/x' }));
    expect(result).toEqual({ message: 'Alert webhook saved', secret: 'plain-secret' });
  });

  it('saveConfig omits the secret field when none was generated', async () => {
    const { controller } = buildController({ saveConfig: jest.fn().mockResolvedValue({}) });
    const result = await controller.saveConfig(req(), { url: 'https://hooks.example.com/x', type: 'json' } as any);
    expect(result).toEqual({ message: 'Alert webhook saved' });
  });

  it('deleteConfig delegates to the service', async () => {
    const { controller, alerts } = buildController();
    const result = await controller.deleteConfig(req('org-x'));
    expect(alerts.deleteConfig).toHaveBeenCalledWith('org-x');
    expect(result).toEqual({ message: 'Alert webhook removed' });
  });

  it('testWebhook delegates to the service and returns its result', async () => {
    const { controller, alerts } = buildController();
    const result = await controller.testWebhook(req('org-x'));
    expect(alerts.testWebhook).toHaveBeenCalledWith('org-x');
    expect(result).toEqual({ success: true, status: 200 });
  });
});
