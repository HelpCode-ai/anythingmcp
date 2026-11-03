import { FileSearchAccessService } from './file-search-access.service';

function make(opts: { cloud: boolean; licences?: any[]; settings?: Record<string, string> }) {
  const licences = opts.licences ?? [];
  const prisma: any = {
    license: {
      findFirst: jest.fn(async ({ where }: any) => licences.find((l) => (where.organizationId === undefined || l.organizationId === where.organizationId) && (!where.status || l.status === where.status)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => licences.find((l) => l.licenseKey === where.licenseKey) ?? null),
    },
    siteSettings: { findUnique: jest.fn(async ({ where }: any) => (opts.settings?.[where.key] !== undefined ? { value: opts.settings[where.key] } : null)) },
  };
  return new FileSearchAccessService(prisma, { isCloud: () => opts.cloud } as any);
}
const day = 86400000;
/** The free Community key, registered as the instance key. */
const community = { organizationId: null, licenseKey: 'C', plan: 'community', status: 'active', expiresAt: null };

describe('FileSearchAccessService', () => {
  it('Cloud: no licence or an expired trial locks the feature', async () => {
    expect((await make({ cloud: true }).resolve('o1')).allowed).toBe(false);
    const expired = await make({ cloud: true, licences: [{ organizationId: 'o1', plan: 'trial', status: 'active', expiresAt: new Date(Date.now() - day) }] }).resolve('o1');
    expect(expired).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('Cloud: a trial and a paid plan get their quotas', async () => {
    const trial = await make({ cloud: true, licences: [{ organizationId: 'o1', plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + day) }] }).resolve('o1');
    expect(trial).toMatchObject({ allowed: true, plan: 'trial' });
    const team = await make({ cloud: true, licences: [{ organizationId: 'o1', plan: 'team', status: 'active', expiresAt: null }] }).resolve('o1');
    expect(team.allowed && team.quota.maxFiles).toBe(2000);
  });

  it('Self-hosted Community with a registered key and no trial is locked and offers the trial', async () => {
    const a = await make({ cloud: false, licences: [community], settings: { license_key: 'C' } }).resolve('o1');
    expect(a).toMatchObject({ allowed: false, reason: 'community', trialAvailable: true, keyRequired: null });
  });

  describe('File Search trial needs a registered licence key (self-hosted)', () => {
    const running = () => new Date(Date.now() + day).toISOString();

    it('without a key, no new trial is offered: register a Community key first', async () => {
      const a = await make({ cloud: false }).resolve('o1');
      expect(a).toMatchObject({ allowed: false, trialAvailable: false, keyRequired: 'to_start' });
      expect(!a.allowed && a.message).toMatch(/Register a free Community key under Settings → License/);
      await expect(make({ cloud: false }).assertAllowed('o1')).rejects.toMatchObject({
        response: { code: 'file_search_locked', keyRequired: 'to_start', trialAvailable: false },
      });
    });

    it('a trial started under the rule opens File Search with a key (the free Community key counts)', async () => {
      const a = await make({
        cloud: false,
        licences: [community],
        settings: { license_key: 'C', business_trial_ends_at: running(), file_search_trial_needs_key: 'true' },
      }).resolve('o1');
      expect(a).toMatchObject({ allowed: true, plan: 'trial' });
    });

    it('a trial started under the rule without a key does not open File Search', async () => {
      const a = await make({
        cloud: false,
        settings: { business_trial_ends_at: running(), file_search_trial_needs_key: 'true' },
      }).resolve('o1');
      expect(a).toMatchObject({ allowed: false, trialAvailable: false, keyRequired: 'during_trial' });
    });

    it('a trial already running before the rule keeps File Search without a key', async () => {
      const a = await make({ cloud: false, settings: { business_trial_ends_at: running() } }).resolve('o1');
      expect(a).toMatchObject({ allowed: true, plan: 'trial' });
    });

    it('paid keys are unchanged', async () => {
      const team = await make({
        cloud: false,
        licences: [{ organizationId: null, licenseKey: 'T', plan: 'team', status: 'active', expiresAt: null }],
        settings: { license_key: 'T', file_search_trial_needs_key: 'true' },
      }).resolve('o1');
      expect(team).toMatchObject({ allowed: true, plan: 'team' });
    });

    it('Cloud is unchanged: no key requirement', async () => {
      const a = await make({ cloud: true, settings: { file_search_trial_needs_key: 'true' } }).resolve('o1');
      expect(a).toMatchObject({ allowed: false, reason: 'no_licence', keyRequired: null });
      const trial = await make({
        cloud: true,
        licences: [{ organizationId: 'o1', plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + day) }],
        settings: { file_search_trial_needs_key: 'true' },
      }).resolve('o1');
      expect(trial).toMatchObject({ allowed: true, plan: 'trial' });
    });
  });

  it('Self-hosted: the running evaluation unlocks Team limits; an ended one does not', async () => {
    const running = await make({ cloud: false, settings: { business_trial_ends_at: new Date(Date.now() + day).toISOString() } }).resolve('o1');
    expect(running.allowed && running.plan).toBe('trial');
    const ended = await make({ cloud: false, settings: { business_trial_ends_at: new Date(Date.now() - day).toISOString() } }).resolve('o1');
    expect(ended).toMatchObject({ allowed: false, trialAvailable: false });
  });

  it('Self-hosted: any paid key (not only Business) unlocks it, via the instance key too', async () => {
    const starter = await make({ cloud: false, licences: [{ organizationId: null, licenseKey: 'K', plan: 'starter', status: 'active', expiresAt: null }], settings: { license_key: 'K' } }).resolve('o1');
    expect(starter.allowed && starter.quota.maxFiles).toBe(500);
  });

  it('assertAllowed throws the code the frontend recognises', async () => {
    await expect(make({ cloud: false }).assertAllowed('o1')).rejects.toMatchObject({ response: { code: 'file_search_locked' } });
  });
});
