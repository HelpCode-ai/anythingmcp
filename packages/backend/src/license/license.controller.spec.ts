import { LicenseController } from './license.controller';

/**
 * activate-trial used to answer 400 on every single signup.
 *
 * The verification flow activates the trial server-side, then the client calls
 * this endpoint too; the second call found an existing licence and turned the
 * licence API's 409 into a BadRequest. The user's trial was fine, but they were
 * shown an error, and the wasted call ate the licence API's rate budget.
 */
describe('LicenseController — activate-trial is idempotent', () => {
  const user = { id: 'u1', email: 'user@example.com', name: 'User' };
  const req = { user: { sub: 'u1', organizationId: 'org-1' } };

  function makeController(existingLicense: any) {
    const licenseService = {
      getCurrentLicense: jest.fn(async () => existingLicense),
      requestTrialLicense: jest.fn(async () => ({
        licenseKey: 'AMCP-NEW',
        plan: 'trial',
        expiresAt: '2026-10-01T00:00:00.000Z',
        trialDaysLeft: 7,
      })),
    };
    const controller = new LicenseController(
      licenseService as any,
      {} as any,
      {} as any,
      { findById: jest.fn(async () => user) } as any,
      { isCloud: () => true } as any,
    );
    return { controller, licenseService };
  }

  it('returns the existing licence as a success instead of an error', async () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const { controller, licenseService } = makeController({
      licenseKey: 'AMCP-EXISTING',
      plan: 'trial',
      expiresAt,
    });

    const result: any = await controller.activateTrial(req);

    expect(result.trialStarted).toBe(false);
    expect(result.licenseKey).toBe('AMCP-EXISTING');
    expect(result.trialDaysLeft).toBe(3);
    expect(licenseService.requestTrialLicense).not.toHaveBeenCalled();
  });

  it('still starts a real trial when the workspace has none', async () => {
    const { controller, licenseService } = makeController(null);

    const result: any = await controller.activateTrial(req);

    expect(result.trialStarted).toBe(true);
    expect(result.licenseKey).toBe('AMCP-NEW');
    expect(licenseService.requestTrialLicense).toHaveBeenCalledWith(
      'user@example.com',
      'User',
      'org-1',
    );
  });

  it('reports a perpetual licence without pretending it expires today', async () => {
    const { controller } = makeController({
      licenseKey: 'AMCP-PERPETUAL',
      plan: 'enterprise',
      expiresAt: null,
    });

    const result: any = await controller.activateTrial(req);

    expect(result.expiresAt).toBeNull();
    expect(result.trialDaysLeft).toBe(0);
  });
});
