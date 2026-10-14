/**
 * Whether an admin can start a card trial, known before Checkout: the licence
 * site gives no trial to an address that had a subscription, so the app must
 * not promise one (it used to say "€0 today" and Checkout charged today).
 */
import { CardTrialEligibilityService } from './card-trial-eligibility.service';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const DAY = 86_400_000;

function makeService(opts: { isCloud?: boolean; license?: any; history?: Record<string, boolean> | null } = {}) {
  const licenseService = {
    getCurrentLicense: jest.fn(async () =>
      opts.license === undefined
        ? { plan: 'trial', status: 'active', expiresAt: new Date(NOW.getTime() + 5 * DAY) }
        : opts.license,
    ),
    subscriptionHistory: jest.fn(async (emails: string[]) =>
      opts.history === null ? null : new Map(emails.map((e) => [e, opts.history?.[e] ?? false])),
    ),
  };
  const svc = new CardTrialEligibilityService(licenseService as any, { isCloud: () => opts.isCloud ?? true } as any);
  return { svc, licenseService };
}

describe('CardTrialEligibilityService', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('offers the card trial to an address that never had a subscription', async () => {
    const { svc } = makeService();
    await expect(svc.forAdmin('org-1', 'new@example.com')).resolves.toEqual({
      kind: 'trial',
      trialEndsAt: new Date(NOW.getTime() + 5 * DAY),
    });
  });

  it('says "pay today" to an address that had a subscription', async () => {
    const { svc } = makeService({ history: { 'back@example.com': true } });
    await expect(svc.forAdmin('org-1', 'Back@Example.com ')).resolves.toEqual({
      kind: 'pay',
      reason: 'had_subscription',
    });
  });

  it('keeps the trial when the licence site cannot answer: it checks again at checkout', async () => {
    const { svc } = makeService({ history: null });
    await expect(svc.forAdmin('org-1', 'new@example.com')).resolves.toMatchObject({ kind: 'trial' });
  });

  it.each([
    ['under 48 hours are left', { plan: 'trial', status: 'active', expiresAt: new Date(NOW.getTime() + DAY) }],
    ['the trial has ended', null],
    ['the workspace pays', { plan: 'starter', status: 'active', expiresAt: null }],
  ])('offers nothing and asks nothing when %s', async (_label, license) => {
    const { svc, licenseService } = makeService({ license });
    await expect(svc.forAdmin('org-1', 'new@example.com')).resolves.toEqual({ kind: 'none' });
    expect(licenseService.subscriptionHistory).not.toHaveBeenCalled();
  });

  it('does nothing on self-hosted', async () => {
    const { svc, licenseService } = makeService({ isCloud: false });
    await expect(svc.forAdmin('org-1', 'new@example.com')).resolves.toEqual({ kind: 'none' });
    expect(licenseService.getCurrentLicense).not.toHaveBeenCalled();
  });

  it('reuses an answer for ten minutes, and never caches "unknown"', async () => {
    const { svc, licenseService } = makeService({ history: { 'a@example.com': true } });
    await svc.hadSubscription('a@example.com');
    await svc.hadSubscription('A@example.com');
    expect(licenseService.subscriptionHistory).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW.getTime() + 11 * 60_000);
    await svc.hadSubscription('a@example.com');
    expect(licenseService.subscriptionHistory).toHaveBeenCalledTimes(2);

    const unknown = makeService({ history: null });
    await expect(unknown.svc.hadSubscription('a@example.com')).resolves.toBeNull();
    await unknown.svc.hadSubscription('a@example.com');
    expect(unknown.licenseService.subscriptionHistory).toHaveBeenCalledTimes(2);
  });

  it('asks only for the addresses it does not know yet', async () => {
    const { svc, licenseService } = makeService({ history: { 'a@example.com': true } });
    await svc.hadSubscription('a@example.com');
    const both = await svc.hadSubscriptions(['a@example.com', 'b@example.com']);
    expect(both).toEqual(new Map([['a@example.com', true], ['b@example.com', false]]));
    expect(licenseService.subscriptionHistory).toHaveBeenLastCalledWith(['b@example.com']);
  });
});
