import { AppApprovalTrialExtensionService } from './app-approval-trial-extension.service';

const H = 60 * 60 * 1000;
const D = 24 * H;
const now = new Date('2026-11-02T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const CONTEXT = { connectorId: 'c1', adapterSlug: 'etsy' };

type Trial = { endsAt: Date; active: boolean; cardTrialAvailable: boolean } | null;

function make(
  opts: {
    cloud?: boolean;
    /** What LicenseGuardService.getTrialState answers: null = a paid plan, a card trial or no licence. */
    trial?: Trial;
    licence?: { licenseKey: string } | null;
    answer?: any;
    extendedBefore?: boolean;
  } = {},
) {
  const trial: Trial =
    opts.trial === undefined ? { endsAt: at(-2 * D), active: false, cardTrialAvailable: false } : opts.trial;
  const prisma = {
    productEvent: { findFirst: jest.fn().mockResolvedValue(opts.extendedBefore ? { id: 'e1' } : null) },
    license: {
      findFirst: jest.fn().mockResolvedValue(opts.licence === undefined ? { licenseKey: 'AMCP-TRIAL-KEY-0001' } : opts.licence),
    },
  };
  const licenseGuard = { getTrialState: jest.fn().mockResolvedValue(trial) };
  const licenseService = { verifyLicense: jest.fn().mockResolvedValue({ valid: true }) };
  const client = {
    extendTrial: jest.fn().mockResolvedValue(opts.answer === undefined ? { ok: true, expiresAt: at(7 * D) } : opts.answer),
  };
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new AppApprovalTrialExtensionService(
    prisma as any,
    { isCloud: () => opts.cloud ?? true } as any,
    licenseGuard as any,
    licenseService as any,
    client as any,
    productEvents as any,
    securityEvents as any,
  );
  return { service, prisma, licenseGuard, licenseService, client, productEvents, securityEvents };
}

describe('AppApprovalTrialExtensionService', () => {
  it('extends an ended free trial through the existing licence-site call, and records it', async () => {
    const { service, prisma, client, licenseService, productEvents, securityEvents } = make();
    const out = await service.extendIfTooLate('org-1', CONTEXT, now);
    expect(out).toEqual({ daysAdded: 7, until: at(7 * D) });
    // The workspace's own trial licence, found by its organization.
    expect(prisma.license.findFirst.mock.calls[0][0].where).toEqual({ organizationId: 'org-1', plan: 'trial' });
    expect(client.extendTrial).toHaveBeenCalledTimes(1);
    expect(client.extendTrial).toHaveBeenCalledWith('AMCP-TRIAL-KEY-0001');
    // Read back at once, so the workspace's calls go through again.
    expect(licenseService.verifyLicense).toHaveBeenCalledWith('AMCP-TRIAL-KEY-0001', 'org-1');
    expect(securityEvents.log).toHaveBeenCalledWith({
      event: 'TRIAL_EXTENDED',
      actorType: 'SYSTEM',
      organizationId: 'org-1',
      metadata: { until: at(7 * D).toISOString(), via: 'app_approved', connectorId: 'c1' },
    });
    expect(productEvents.log).toHaveBeenCalledWith({
      event: 'trial_extended',
      organizationId: 'org-1',
      metadata: { via: 'app_approved', connectorId: 'c1', adapterSlug: 'etsy' },
    });
  });

  it('extends a trial that ends within 24 hours, and counts the days from its old end', async () => {
    const { service, client } = make({ trial: { endsAt: at(20 * H), active: true, cardTrialAvailable: false } });
    // The site gives 7 days from now: 6 days and 4 hours more than the trial had.
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toEqual({ daysAdded: 6, until: at(7 * D) });
    expect(client.extendTrial).toHaveBeenCalledTimes(1);
  });

  it('leaves a trial with more than a day left alone', async () => {
    const { service, client, prisma } = make({ trial: { endsAt: at(25 * H), active: true, cardTrialAvailable: false } });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(client.extendTrial).not.toHaveBeenCalled();
    expect(prisma.license.findFirst).not.toHaveBeenCalled();
  });

  it('is for the free trial only: never a paid plan, a card trial or a workspace without a licence', async () => {
    // getTrialState answers null for all three (plan other than 'trial', or none).
    const { service, client, licenseGuard, productEvents } = make({ trial: null });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(licenseGuard.getTrialState).toHaveBeenCalledWith('org-1', now);
    expect(client.extendTrial).not.toHaveBeenCalled();
    expect(productEvents.log).not.toHaveBeenCalled();
  });

  it('is Cloud only: self-hosted asks nothing', async () => {
    const { service, client, licenseGuard } = make({ cloud: false });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(licenseGuard.getTrialState).not.toHaveBeenCalled();
    expect(client.extendTrial).not.toHaveBeenCalled();
  });

  it('extends once: a workspace extended before is not asked for again', async () => {
    const { service, client, prisma } = make({ extendedBefore: true });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(prisma.productEvent.findFirst.mock.calls[0][0].where).toEqual({ organizationId: 'org-1', event: 'trial_extended' });
    expect(client.extendTrial).not.toHaveBeenCalled();
  });

  it('extends once: the licence site refusing a second extension adds nothing', async () => {
    const { service, licenseService, productEvents, securityEvents } = make({
      answer: { ok: false, reason: 'already_extended' },
    });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(licenseService.verifyLicense).not.toHaveBeenCalled();
    expect(productEvents.log).not.toHaveBeenCalled();
    expect(securityEvents.log).not.toHaveBeenCalled();
  });

  it('does not ask for a trial that ended over 7 days ago: the site would refuse', async () => {
    const { service, client } = make({ trial: { endsAt: at(-7 * D), active: false, cardTrialAvailable: false } });
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(client.extendTrial).not.toHaveBeenCalled();
  });

  it.each([
    ['the licence site gives no answer', { answer: null }],
    ['the licence site refuses', { answer: { ok: false, reason: 'too_late' } }],
    ['the workspace has no trial licence row', { licence: null }],
  ])('adds nothing when %s', async (_label, opts) => {
    const { service, productEvents } = make(opts as any);
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toBeNull();
    expect(productEvents.log).not.toHaveBeenCalled();
  });

  it('still counts the days when the licence cannot be read back yet', async () => {
    const { service, licenseService } = make();
    licenseService.verifyLicense.mockRejectedValue(new Error('timeout'));
    expect(await service.extendIfTooLate('org-1', CONTEXT, now)).toEqual({ daysAdded: 7, until: at(7 * D) });
  });

  it('never logs the licence key', async () => {
    const logs: string[] = [];
    const { service } = make({ answer: { ok: false, reason: 'revoked' } });
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation((m: unknown) => void logs.push(String(m)));
    }
    await service.extendIfTooLate('org-1', CONTEXT, now);
    const ok = make();
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((ok.service as any).logger, level).mockImplementation((m: unknown) => void logs.push(String(m)));
    }
    await ok.service.extendIfTooLate('org-1', CONTEXT, now);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('AMCP-TRIAL-KEY-0001');
  });
});
