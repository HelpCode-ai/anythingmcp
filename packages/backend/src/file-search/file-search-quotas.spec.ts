import { clampInterval, nextPlan, quotaForPlan } from './file-search-quotas';

describe('File Search quotas', () => {
  it('matches the agreed Cloud limits', () => {
    expect(quotaForPlan('starter', { cloud: true })).toMatchObject({ maxConnectors: 1, maxFiles: 500, minIntervalMinutes: 1440, manualSyncsPerDay: 1 });
    expect(quotaForPlan('team', { cloud: true })).toMatchObject({ maxConnectors: 3, maxFiles: 2000, minIntervalMinutes: 1440 });
    expect(quotaForPlan('enterprise', { cloud: true })).toMatchObject({ minIntervalMinutes: 15, ocr: true, folderRules: true, policy: true });
    expect(quotaForPlan('trial', { cloud: true })).toMatchObject({ plan: 'trial', maxConnectors: 3, maxFiles: 2000, maxFileBytes: 50 * 1024 * 1024, manualSyncsPerDay: 3, ocr: false });
    expect(quotaForPlan('trial', { cloud: true })!.share).toMatchObject({ maxTtlHours: 7 * 24, maxStoredBytes: 2 * 1024 * 1024 * 1024 });
    expect(quotaForPlan('starter', { cloud: true })!.share).toMatchObject({ maxTtlHours: 24, maxStoredBytes: 100 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, publicLinks: true });
    expect(quotaForPlan('business', { cloud: true })).toMatchObject({ maxFiles: 2000, plan: 'business' });
  });

  it('locks Community: no plan means no File Search', () => {
    expect(quotaForPlan(null, { cloud: false })).toBeNull();
    expect(quotaForPlan('community', { cloud: false })).toBeNull();
    expect(quotaForPlan('trial', { cloud: false })).toMatchObject({ maxFiles: 2000, share: null });
    expect(quotaForPlan('enterprise', { cloud: false })).toMatchObject({ maxFiles: null, minIntervalMinutes: 5 });
  });

  it('applies licence overrides for Enterprise contracts', () => {
    const q = quotaForPlan('enterprise', { cloud: true, overrides: { maxFiles: 200000, share: { maxTtlHours: 720, publicLinks: false } } })!;
    expect(q.maxFiles).toBe(200000);
    expect(q.share).toMatchObject({ maxTtlHours: 720, publicLinks: false });
  });

  it('suggests the next plan and clamps the interval to the plan minimum', () => {
    expect(nextPlan('starter', true)?.plan).toBe('team');
    expect(nextPlan('trial', true)?.plan).toBe('enterprise');
    expect(nextPlan('trial', false)?.plan).toBe('enterprise');
    expect(nextPlan('enterprise', true)).toBeNull();
    expect(clampInterval(60, quotaForPlan('team', { cloud: true })!)).toBe(1440);
    expect(clampInterval(15, quotaForPlan('enterprise', { cloud: true })!)).toBe(15);
  });
});
