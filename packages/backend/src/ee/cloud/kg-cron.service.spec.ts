import { KgCronService } from './kg-cron.service';

/**
 * Gating + cost-control logic for the scheduled AI extension. Verifies the
 * kill switch, per-workspace opt-in, cooldown, and "only spend on new data".
 */
describe('KgCronService.runLlmExtend (AI cron)', () => {
  const ORG = 'org-A';

  function build(over: {
    enabled?: string;
    optedIn?: boolean;
    lastRun?: number | null;
    llmEnabled?: boolean;
    newIntents?: number;
  }) {
    if (over.enabled === undefined) process.env.KG_LLM_CRON_ENABLED = 'true';
    else process.env.KG_LLM_CRON_ENABLED = over.enabled;

    const prisma = {
      orgSettings: {
        findMany: jest
          .fn()
          .mockResolvedValue(over.optedIn === false ? [] : [{ organizationId: ORG }]),
        findUnique: jest
          .fn()
          .mockResolvedValue(over.lastRun != null ? { value: String(over.lastRun) } : null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      toolInvocation: { count: jest.fn().mockResolvedValue(over.newIntents ?? 0) },
    };
    const kgLlm = {
      isEnabled: jest.fn().mockResolvedValue(over.llmEnabled ?? true),
      enrich: jest.fn().mockResolvedValue({ suggested: 2 }),
    };
    const kgSkill = { generate: jest.fn().mockResolvedValue({ created: 1 }) };
    const svc = new KgCronService(prisma as any, {} as any, {} as any, kgLlm as any, kgSkill as any);
    return { svc, prisma, kgLlm, kgSkill };
  }

  afterEach(() => {
    delete process.env.KG_LLM_CRON_ENABLED;
    delete process.env.KG_LLM_MIN_INTERVAL_HOURS;
  });

  const callExtend = (svc: KgCronService) => (svc as any).runLlmExtend();

  it('does nothing when the global kill switch is off', async () => {
    const { svc, kgLlm } = build({ enabled: 'false' });
    const r = await callExtend(svc);
    expect(r).toEqual({ llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0 });
    expect(kgLlm.enrich).not.toHaveBeenCalled();
  });

  it('does nothing when no workspace opted in', async () => {
    const { svc, kgLlm } = build({ optedIn: false });
    const r = await callExtend(svc);
    expect(r.llmOrgs).toBe(0);
    expect(kgLlm.enrich).not.toHaveBeenCalled();
  });

  it('skips a workspace still within the cooldown window', async () => {
    process.env.KG_LLM_MIN_INTERVAL_HOURS = '24';
    const { svc, kgLlm } = build({ lastRun: Date.now() - 60_000 }); // 1 min ago
    const r = await callExtend(svc);
    expect(r.llmOrgs).toBe(0);
    expect(kgLlm.enrich).not.toHaveBeenCalled();
  });

  it('skips when AI enrichment is disabled for the workspace', async () => {
    const { svc, kgLlm } = build({ llmEnabled: false });
    const r = await callExtend(svc);
    expect(kgLlm.enrich).not.toHaveBeenCalled();
    expect(r.llmOrgs).toBe(0);
  });

  it('enriches but skips skill generation when there are no new intents', async () => {
    const { svc, kgLlm, kgSkill, prisma } = build({ lastRun: null, newIntents: 0 });
    const r = await callExtend(svc);
    expect(kgLlm.enrich).toHaveBeenCalledWith(ORG, { force: false });
    expect(kgSkill.generate).not.toHaveBeenCalled();
    expect(r).toEqual({ llmOrgs: 1, llmGraphSuggested: 2, llmSkillsCreated: 0 });
    expect(prisma.orgSettings.upsert).toHaveBeenCalled(); // cooldown stamp written
  });

  it('enriches AND generates skills when new intents arrived', async () => {
    const { svc, kgLlm, kgSkill } = build({ lastRun: null, newIntents: 5 });
    const r = await callExtend(svc);
    expect(kgLlm.enrich).toHaveBeenCalled();
    expect(kgSkill.generate).toHaveBeenCalledWith(ORG);
    expect(r).toEqual({ llmOrgs: 1, llmGraphSuggested: 2, llmSkillsCreated: 1 });
  });
});

describe('KgCronService.trimOldPayloads', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  function build(results: number[]) {
    const prisma = { $executeRaw: jest.fn() };
    for (const r of results) prisma.$executeRaw.mockResolvedValueOnce(r);
    const svc = new KgCronService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma };
  }

  it('works in batches until a batch comes back short', async () => {
    process.env.INVOCATION_TRIM_BATCH = '100';
    const { svc, prisma } = build([100, 100, 37]);
    await expect(svc.trimOldPayloads()).resolves.toBe(237);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('stops at the per-run batch cap', async () => {
    process.env.INVOCATION_TRIM_BATCH = '10';
    process.env.INVOCATION_TRIM_MAX_BATCHES = '2';
    const { svc, prisma } = build([10, 10, 10]);
    await expect(svc.trimOldPayloads()).resolves.toBe(20);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('can be switched off', async () => {
    process.env.INVOCATION_PAYLOAD_RETENTION_DAYS = '0';
    const { svc, prisma } = build([]);
    await expect(svc.trimOldPayloads()).resolves.toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
