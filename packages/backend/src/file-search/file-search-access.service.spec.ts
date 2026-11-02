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

  it('Self-hosted Community without trial is locked and offers the trial', async () => {
    const a = await make({ cloud: false }).resolve('o1');
    expect(a).toMatchObject({ allowed: false, reason: 'community', trialAvailable: true });
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
