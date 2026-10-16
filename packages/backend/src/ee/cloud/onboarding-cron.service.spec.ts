import { OnboardingCronService, winbackTestArm } from './onboarding-cron.service';

/**
 * The repair pass talks to the licence API, so every test here stubs it. Its
 * own behaviour is covered in license-trial.service.spec.ts.
 */
function makeLicense(repaired = 0) {
  return {
    repairMissingTrials: jest
      .fn()
      .mockResolvedValue({ examined: repaired, repaired, failed: 0 }),
    reverifyPaidLicenses: jest
      .fn()
      .mockResolvedValue({ checked: 3, deactivated: 1, inGrace: 1, unreachable: 0 }),
  } as any;
}

/** LicenseService.workspacesWithPaidPlan over a stubbed subscriptionHistory, without local licences. */
function paidPlanFromHistory(license: { subscriptionHistory: (emails: string[]) => Promise<Map<string, boolean> | null> }) {
  return jest.fn(async (workspaces: Array<{ organizationId: string; adminEmails: string[] }>) => {
    const out = { paid: new Set<string>(), unknown: new Set<string>() };
    const history = await license.subscriptionHistory(workspaces.flatMap((w) => w.adminEmails));
    for (const w of workspaces) {
      if (!history) out.unknown.add(w.organizationId);
      else if (w.adminEmails.some((e) => history.get(e.toLowerCase()) === true)) out.paid.add(w.organizationId);
    }
    return out;
  });
}

function makeRelease(released = 0) {
  return {
    releaseOrphanedLicenses: jest
      .fn()
      .mockResolvedValue({ examined: released, released, refused: 0, failed: 0 }),
  } as any;
}

describe('OnboardingCronService — activation pass', () => {
  function makeService(overrides: {
    onboardingCandidates?: any[];
    stuckUsers?: any[];
    sendOk?: boolean;
    trials?: any[];
  }) {
    const findMany = jest
      .fn()
      // 1st call: onboarding (no-connector) cohort
      .mockResolvedValueOnce(overrides.onboardingCandidates ?? [])
      // 2nd call: activation (stuck) cohort
      .mockResolvedValueOnce(overrides.stuckUsers ?? []);
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      user: { findMany, update },
      // The trial-lifecycle pass runs after the activation pass; with no
      // trials it's a no-op. Stub just enough so it doesn't throw here.
      license: {
        findMany: jest.fn().mockResolvedValue(overrides.trials ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;
    const email = {
      sendOnboardingReminderEmail: jest.fn().mockResolvedValue(true),
      sendActivationReminderEmail: jest
        .fn()
        .mockResolvedValue(overrides.sendOk ?? true),
    } as any;
    const license = makeLicense();
    return {
      service: new OnboardingCronService(prisma, email, license, makeRelease()),
      findMany,
      update,
      email,
    };
  }

  it('emails the stuck cohort and stamps activationReminderAt, deep-linking the connector', async () => {
    const { service, update, email } = makeService({
      stuckUsers: [
        {
          id: 'u1',
          email: 'stuck@example.com',
          name: 'Sam',
          connectors: [{ id: 'conn123' }],
          mcpServers: [],
        },
      ],
    });

    const out = await service.run();

    expect(out.activationReminders).toBe(1);
    expect(email.sendActivationReminderEmail).toHaveBeenCalledWith(
      'stuck@example.com',
      'Sam',
      '/connectors/conn123',
      'test-connector',
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          activationReminderAt: expect.any(Date),
        }),
      }),
    );
  });

  it('runs the card-trial offer email pass after the trial and win-back passes', async () => {
    const { service } = makeService({});
    const order: string[] = [];
    const prisma = (service as any).prisma;
    prisma.license.findMany.mockImplementation(async () => {
      order.push('license');
      return [];
    });
    const offer = {
      runEmailPass: jest.fn(async () => {
        order.push('offer');
        return { examined: 2, sent: 1, skipped: 0, postponed: 1, failed: 0 };
      }),
    };
    (service as any).cardTrialOffer = offer;

    const out = await service.run();

    expect(offer.runEmailPass).toHaveBeenCalledTimes(1);
    expect(out.cardTrialOffers).toBe(1);
    // Lifecycle + win-back read the licences first, so their emails hold this one back.
    expect(order).toEqual(['license', 'license', 'offer']);
  });

  it('does not stamp when the email fails to send', async () => {
    const { service, update } = makeService({
      stuckUsers: [
        { id: 'u2', email: 'x@example.com', name: null, connectors: [{ id: 'c2' }], mcpServers: [] },
      ],
      sendOk: false,
    });

    const out = await service.run();

    expect(out.activationReminders).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to /connectors when the user has no connector id resolved', async () => {
    const { service, email } = makeService({
      stuckUsers: [
        { id: 'u3', email: 'y@example.com', name: 'Y', connectors: [], mcpServers: [] },
      ],
    });

    await service.run();

    expect(email.sendActivationReminderEmail).toHaveBeenCalledWith(
      'y@example.com',
      'Y',
      '/connectors',
      'test-connector',
    );
  });

  it('sends users who already have an MCP server to its page, with the connect-client copy', async () => {
    // 183 of the 246 stuck workspaces had attached a connector and never sent
    // a request: the missing step is connecting a client, not testing a tool.
    const { service, email } = makeService({
      stuckUsers: [
        {
          id: 'u4',
          email: 'z@example.com',
          name: 'Zed',
          connectors: [{ id: 'c4' }],
          mcpServers: [{ id: 'srv4' }],
        },
      ],
    });

    await service.run();

    expect(email.sendActivationReminderEmail).toHaveBeenCalledWith(
      'z@example.com',
      'Zed',
      '/mcp-server/srv4',
      'connect-client',
    );
  });
});

describe('OnboardingCronService — trial status transition', () => {
  it('marks active trials past expiresAt as expired, after the lifecycle pass', async () => {
    const calls: string[] = [];
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      license: {
        findMany: jest.fn().mockImplementation(async (args: any) => {
          calls.push(args?.where?.status === 'active' ? 'lifecycle' : 'winback');
          return [];
        }),
        updateMany: jest.fn().mockImplementation(async () => {
          calls.push('mark-expired');
          return { count: 3 };
        }),
      },
    } as any;
    const email = {} as any;
    const { OnboardingCronService } = await import('./onboarding-cron.service');
    const svc = new OnboardingCronService(prisma, email, makeLicense(), makeRelease());

    const out = await svc.run();

    expect(out.trialsMarkedExpired).toBe(3);
    const where = prisma.license.updateMany.mock.calls[0][0].where;
    expect(where.plan).toBe('trial');
    expect(where.status).toBe('active');
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(prisma.license.updateMany.mock.calls[0][0].data).toEqual({ status: 'expired' });
    // The "your trial has ended" email selects on status='active', so the
    // flip must come after it or the email would never be sent.
    expect(calls).toEqual(['lifecycle', 'winback', 'mark-expired']);
  });
});

describe('OnboardingCronService — trial lifecycle emails', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = new Date('2026-10-14T09:17:00Z').getTime();
  const out = () => ({ examined: 0, trialWarn3: 0, trialWarn1: 0, trialExpired: 0, trialEmailsWithheld: 0, skipped: 0 });

  /** Free trials ending `endsInHours` from NOW, one per workspace. */
  function makeService(opts: {
    trials: Array<{ organizationId: string; endsInHours: number; admins?: string[] }>;
    flagged?: Array<[string, string]>;
    paid?: string[];
    unknown?: string[];
  }) {
    const prisma = {
      license: {
        findMany: jest.fn().mockResolvedValue(
          opts.trials.map((t) => ({ organizationId: t.organizationId, expiresAt: new Date(NOW + t.endsInHours * HOUR) })),
        ),
      },
      orgSettings: {
        findUnique: jest.fn(async ({ where }: any) =>
          (opts.flagged ?? []).some(
            ([org, key]) => org === where.organizationId_key.organizationId && key === where.organizationId_key.key,
          )
            ? { id: 'f' }
            : null,
        ),
        upsert: jest.fn().mockResolvedValue({}),
      },
      organizationMember: {
        findMany: jest.fn(async ({ where }: any) =>
          (opts.trials.find((t) => t.organizationId === where.organizationId)?.admins ?? ['admin@example.com']).map(
            (email) => ({ user: { email, name: 'Ada' } }),
          ),
        ),
      },
      connector: { count: jest.fn().mockResolvedValue(2) },
      toolInvocation: { count: jest.fn().mockResolvedValue(40) },
    } as any;
    const email = { sendTrialLifecycleEmail: jest.fn().mockResolvedValue(true) } as any;
    const license = makeLicense();
    license.workspacesWithPaidPlan = jest.fn(async () => ({
      paid: new Set(opts.paid ?? []),
      unknown: new Set(opts.unknown ?? []),
    }));
    const service = new OnboardingCronService(prisma, email, license, makeRelease());
    const run = async () => {
      const o = out();
      await (service as any).runTrialLifecyclePass(NOW, o);
      return o;
    };
    const flagged = () =>
      prisma.orgSettings.upsert.mock.calls.map((c: any) => [
        c[0].where.organizationId_key.organizationId,
        c[0].where.organizationId_key.key,
      ]);
    return { run, email, license, flagged };
  }

  it('sends each free trial its stage and flags it', async () => {
    const { run, email, flagged } = makeService({
      trials: [
        { organizationId: 'org-3d', endsInHours: 60 },
        { organizationId: 'org-1d', endsInHours: 20 },
        { organizationId: 'org-0d', endsInHours: -1 },
      ],
    });
    const o = await run();
    expect(email.sendTrialLifecycleEmail.mock.calls.map((c: any[]) => c[2])).toEqual(['warn3', 'warn1', 'expired']);
    expect(flagged()).toEqual([
      ['org-3d', 'trial_email_warn3'],
      ['org-1d', 'trial_email_warn1'],
      ['org-0d', 'trial_email_expired'],
    ]);
    expect(o).toMatchObject({ trialWarn3: 1, trialWarn1: 1, trialExpired: 1, trialEmailsWithheld: 0 });
  });

  // 14 Oct 2026: three admins with a Cloud Starter card trial bought Cloud
  // Starter again within 15-100 minutes of "your trial ends" / "has ended".
  it('sends nothing to a workspace that already pays or has a card trial, and leaves the stage open', async () => {
    const { run, email, flagged } = makeService({
      trials: [
        { organizationId: 'org-card-trial', endsInHours: 20 },
        { organizationId: 'org-free', endsInHours: 20 },
      ],
      paid: ['org-card-trial'],
    });
    const o = await run();
    expect(email.sendTrialLifecycleEmail).toHaveBeenCalledTimes(1);
    expect(flagged()).toEqual([['org-free', 'trial_email_warn1']]);
    expect(o.trialEmailsWithheld).toBe(1);
  });

  it('asks once, for the workspaces with a stage to send, with every active admin', async () => {
    const { run, license } = makeService({
      trials: [
        { organizationId: 'org-a', endsInHours: 20, admins: ['a1@example.com', 'a2@example.com'] },
        { organizationId: 'org-sent', endsInHours: 20 },
        { organizationId: 'org-b', endsInHours: -2 },
      ],
      flagged: [['org-sent', 'trial_email_warn1']],
    });
    await run();
    expect(license.workspacesWithPaidPlan).toHaveBeenCalledTimes(1);
    expect(license.workspacesWithPaidPlan.mock.calls[0][0]).toEqual([
      { organizationId: 'org-a', adminEmails: ['a1@example.com', 'a2@example.com'] },
      { organizationId: 'org-b', adminEmails: ['admin@example.com'] },
    ]);
  });

  it('asks nothing when no stage is due', async () => {
    const { run, license, email } = makeService({
      trials: [{ organizationId: 'org-sent', endsInHours: 60 }],
      flagged: [['org-sent', 'trial_email_warn3']],
    });
    await run();
    expect(license.workspacesWithPaidPlan).not.toHaveBeenCalled();
    expect(email.sendTrialLifecycleEmail).not.toHaveBeenCalled();
  });

  it('postpones a workspace the licence site could not answer for: no email, no flag', async () => {
    const { run, email, flagged } = makeService({
      trials: [{ organizationId: 'org-x', endsInHours: 20 }],
      unknown: ['org-x'],
    });
    const o = await run();
    expect(email.sendTrialLifecycleEmail).not.toHaveBeenCalled();
    expect(flagged()).toEqual([]);
    expect(o.skipped).toBe(1);
    expect(o.trialEmailsWithheld).toBe(0);
  });
});

describe('OnboardingCronService — trial repair', () => {
  it('repairs workspaces left without a licence, and reports how many', async () => {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      license: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;
    const license = makeLicense(4);
    const release = makeRelease(2);
    const svc = new OnboardingCronService(prisma, {} as any, license, release);

    const out = await svc.run();

    // Without this the drip happily emails people about a trial they never got.
    expect(license.repairMissingTrials).toHaveBeenCalledTimes(1);
    expect(out.trialsRepaired).toBe(4);
    // And paid licences get re-checked against the licence server.
    expect(license.reverifyPaidLicenses).toHaveBeenCalledTimes(1);
    // And deleted workspaces' licences are ended on the licence site.
    expect(release.releaseOrphanedLicenses).toHaveBeenCalledTimes(1);
    expect(out.licensesReleased).toBe(2);
    expect(out.licensesReverified).toBe(3);
    expect(out.licensesDeactivated).toBe(1);
  });
});

describe('OnboardingCronService — onboarding pass', () => {
  const HOUR = 60 * 60 * 1000;
  function makeService(opts: {
    candidates: any[];
    orgConnectors?: Record<string, number>;
    grants?: { userId: string; clientId: string }[];
  }) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(opts.candidates)
          .mockResolvedValueOnce([]),
        update,
      },
      connector: {
        groupBy: jest.fn().mockResolvedValue(
          Object.entries(opts.orgConnectors ?? {}).map(([organizationId, n]) => ({
            organizationId,
            _count: { _all: n },
          })),
        ),
      },
      mcpConnectionGrant: { findMany: jest.fn().mockResolvedValue(opts.grants ?? []) },
      oAuthClient: {
        findMany: jest.fn().mockResolvedValue([{ clientId: 'claude-client', clientName: 'Claude' }]),
      },
      license: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;
    const email = {
      sendOnboardingReminderEmail: jest.fn().mockResolvedValue(true),
      sendActivationReminderEmail: jest.fn().mockResolvedValue(true),
    } as any;
    return { service: new OnboardingCronService(prisma, email, makeLicense(), makeRelease()), email, update, prisma };
  }
  const user = (over: Partial<any>) => ({
    id: 'u1',
    email: 'u1@example.com',
    name: 'Ada',
    organizationId: 'org-1',
    onboardingCompletedAt: null,
    onboardingReminderCount: 0,
    onboardingLastReminderAt: null,
    _count: { connectors: 0 },
    createdAt: new Date(Date.now() - 3 * HOUR),
    ...over,
  });

  it('nudges a user who connected Claude to an empty workspace, naming the client', async () => {
    const { service, email, update } = makeService({
      candidates: [user({})],
      grants: [{ userId: 'u1', clientId: 'claude-client' }],
    });
    await service.run();
    expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 1, {
      aiClient: 'Claude',
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ onboardingReminderCount: 1 }) }),
    );
  });

  it('nudges a user with no AI client an hour after sign-up, without naming one', async () => {
    const { service, email } = makeService({ candidates: [user({})] });
    await service.run();
    expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 1, undefined);
  });

  it('asks the database only for users who signed up at least an hour ago', async () => {
    const { service, prisma } = makeService({ candidates: [] });
    const before = Date.now();
    await service.run();
    const where = prisma.user.findMany.mock.calls[0][0].where;
    const ageMs = before - where.createdAt.lte.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(HOUR - 1000);
    expect(ageMs).toBeLessThan(HOUR + 60_000);
  });

  it('still reminds a user who pressed Skip on /welcome with an empty workspace', async () => {
    const { service, email } = makeService({
      candidates: [
        user({ onboardingCompletedAt: new Date(), createdAt: new Date(Date.now() - 30 * HOUR) }),
      ],
    });
    await service.run();
    expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 1, undefined);
  });

  it('counts a teammate\'s connector: no reminder, completion stamped', async () => {
    const { service, email, update } = makeService({
      candidates: [user({ createdAt: new Date(Date.now() - 30 * HOUR) })],
      orgConnectors: { 'org-1': 1 },
    });
    await service.run();
    expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { onboardingCompletedAt: expect.any(Date) } }),
    );
  });
});

describe('OnboardingCronService — trial win-back', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-11-20T10:00:00Z').getTime();
  const out = () => ({
    examined: 0,
    winbackOffers: 0,
    winbackFirstMonth: 0,
    winbackControl: 0,
    winbackHelp: 0,
    skipped: 0,
  });
  // sha256 of the id: even first byte → test arm, odd → control.
  const TEST_ORG = 'org-1';
  const CONTROL_ORG = 'org-2';

  type Admin = { email: string; name?: string; optedOut?: boolean };

  function makeService(opts: {
    endedDaysAgo: number;
    organizationId?: string;
    calls?: number;
    /** Licences of the workspace besides its free trial. */
    otherLicences?: { plan: string; status: string }[];
    flagged?: string[];
    optedOut?: boolean;
    admins?: Admin[];
    connectors?: { adapterSlug?: string }[];
    /** Addresses the licence site says had a subscription; null = the site failed. */
    hadSubscription?: string[] | null;
    sendOk?: boolean;
  }) {
    const organizationId = opts.organizationId ?? 'org-1';
    const admins: Admin[] = opts.admins ?? [
      { email: 'admin@example.com', name: 'Ada', optedOut: !!opts.optedOut },
    ];
    const licences = [{ plan: 'trial', status: 'expired' }, ...(opts.otherLicences ?? [])];
    const prisma = {
      license: {
        findMany: jest.fn().mockResolvedValue([
          { organizationId, expiresAt: new Date(NOW - opts.endedDaysAgo * DAY) },
        ]),
        count: jest.fn(async ({ where }: any) =>
          licences.filter(
            (l) =>
              (where.plan?.not === undefined || l.plan !== where.plan.not) &&
              (where.status === undefined || l.status === where.status),
          ).length,
        ),
      },
      orgSettings: {
        findUnique: jest.fn(async ({ where }: any) =>
          (opts.flagged ?? []).includes(where.organizationId_key.key) ? { id: 'f' } : null,
        ),
        upsert: jest.fn().mockResolvedValue({}),
      },
      organizationMember: {
        findMany: jest.fn().mockResolvedValue(
          admins.map((a) => ({
            user: { email: a.email, name: a.name ?? null, emailMarketingOptOut: !!a.optedOut },
          })),
        ),
      },
      toolInvocation: { count: jest.fn().mockResolvedValue(opts.calls ?? 0) },
      connector: {
        findMany: jest.fn().mockResolvedValue((opts.connectors ?? []).map((c) => ({ config: c }))),
      },
    } as any;
    const email = { sendTrialWinbackEmail: jest.fn().mockResolvedValue(opts.sendOk ?? true) } as any;
    const license = makeLicense();
    license.subscriptionHistory = jest.fn(async (emails: string[]) =>
      opts.hadSubscription === null
        ? null
        : new Map(
            emails.map((e) => [e.toLowerCase(), (opts.hadSubscription ?? []).includes(e.toLowerCase())]),
          ),
    );
    // The remote half of LicenseService.workspacesWithPaidPlan (its own
    // spec covers the rest): the licences are already settled by `count`.
    license.workspacesWithPaidPlan = paidPlanFromHistory(license);
    const service = new OnboardingCronService(prisma, email, license, makeRelease());
    const run = async () => {
      const o = out();
      await (service as any).runWinbackPass(NOW, o);
      return o;
    };
    const upsertedKeys = () =>
      prisma.orgSettings.upsert.mock.calls.map((c: any) => c[0].where.organizationId_key.key);
    return { run, prisma, email, license, upsertedKeys };
  }

  it('tells the two arms apart by a hash of the workspace id, the same on every run', () => {
    expect(winbackTestArm(TEST_ORG)).toBe('first_month_599');
    expect(winbackTestArm(CONTROL_ORG)).toBe('start30_control');
    expect(winbackTestArm(TEST_ORG)).toBe(winbackTestArm(TEST_ORG));
  });

  it('only looks at trials that ended a day ago or more, and on or after the switch from the licence site', async () => {
    const { run, prisma } = makeService({ endedDaysAgo: 2, calls: 3 });
    await run();
    const where = prisma.license.findMany.mock.calls[0][0].where;
    expect(where.plan).toBe('trial');
    expect(where.expiresAt.gte).toEqual(new Date('2026-10-06T00:00:00Z'));
    expect(where.expiresAt.lte).toEqual(new Date(NOW - DAY));
  });

  it('sends the first win-back from one day to seven days after the trial ended', async () => {
    for (const [days, sent] of [
      [0.5, false],
      [1.2, true],
      [6.9, true],
      [7.1, false],
    ] as const) {
      const { run, email } = makeService({ endedDaysAgo: days, calls: 4, organizationId: CONTROL_ORG });
      await run();
      expect(email.sendTrialWinbackEmail).toHaveBeenCalledTimes(sent ? 1 : 0);
    }
  });

  it('a day after, offers 30% to a workspace that used the product, dated, under the old flag key', async () => {
    const { run, email, upsertedKeys } = makeService({ endedDaysAgo: 1.2, calls: 12 });
    const o = await run();
    expect(email.sendTrialWinbackEmail).toHaveBeenCalledWith('admin@example.com', 'Ada', {
      kind: 'discount',
      percentOff: 30,
      promoCode: 'START30',
      stage: 'first',
      trialEndedAt: new Date(NOW - 1.2 * DAY),
      successfulCalls: 12,
    });
    expect(o.winbackOffers).toBe(1);
    // A company address: outside the test, so no arm is recorded.
    expect(upsertedKeys()).toEqual(['trial_email_winback7']);
    expect(o.winbackFirstMonth + o.winbackControl).toBe(0);
  });

  it('never sends the first win-back twice: the flag of the old one-week timing counts', async () => {
    const { run, email } = makeService({ endedDaysAgo: 2, calls: 5, flagged: ['trial_email_winback7'] });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
  });

  it('a month after, offers 50%, unchanged', async () => {
    const { run, email, upsertedKeys } = makeService({ endedDaysAgo: 31, calls: 2 });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({
      kind: 'discount',
      percentOff: 50,
      promoCode: 'WINBACK50',
      stage: 'final',
    });
    expect(upsertedKeys()).toEqual(['trial_email_winback30']);
  });

  it('a month after, gives a consumer workspace 50% too, outside the test', async () => {
    const { run, email, upsertedKeys } = makeService({
      endedDaysAgo: 31,
      calls: 2,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com', name: 'Ada' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({ kind: 'discount', percentOff: 50 });
    expect(upsertedKeys()).toEqual(['trial_email_winback30']);
  });

  it('a day after, sends the how-to without a discount to a workspace that never made a call', async () => {
    const { run, email, license } = makeService({ endedDaysAgo: 1.5, calls: 0 });
    const o = await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toEqual({
      kind: 'help',
      trialEndedAt: new Date(NOW - 1.5 * DAY),
    });
    expect(o.winbackHelp).toBe(1);
    // No discount, but it links to the pricing page: the site is asked whether
    // the admin already holds a card trial or a plan.
    expect(license.subscriptionHistory).toHaveBeenCalledWith(['admin@example.com']);
  });

  it('sends nothing more a month after to a workspace that never made a call', async () => {
    const { run, email, prisma } = makeService({ endedDaysAgo: 31, calls: 0 });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).toHaveBeenCalledTimes(1);
  });

  it('sends nothing outside a stage window', async () => {
    for (const endedDaysAgo of [0.5, 20, 40]) {
      const { run, email } = makeService({ endedDaysAgo, calls: 5 });
      await run();
      expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    }
  });

  it('skips and closes the stage for a workspace with any licence besides the free trial, in any state', async () => {
    for (const other of [
      { plan: 'starter', status: 'active' }, // paid
      { plan: 'starter', status: 'revoked' }, // unpaid card trial, revoked
      { plan: 'starter', status: 'expired' },
      { plan: 'team', status: 'invalid' },
    ]) {
      for (const [days, calls] of [
        [2, 5], // first discount
        [2, 0], // how-to
        [31, 5], // final discount
      ]) {
        const { run, email, upsertedKeys, license } = makeService({
          endedDaysAgo: days,
          calls,
          otherLicences: [other],
        });
        const o = await run();
        expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
        expect(upsertedKeys()).toEqual([days < 7 ? 'trial_email_winback7' : 'trial_email_winback30']);
        expect(o.skipped).toBe(1);
        expect(license.subscriptionHistory).not.toHaveBeenCalled();
      }
    }
  });

  it('skips a card trial still running (plan starter, Stripe trialing)', async () => {
    const { run, email } = makeService({
      endedDaysAgo: 2,
      calls: 5,
      otherLicences: [{ plan: 'starter', status: 'active' }],
      admins: [{ email: 'ada@gmail.com' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
  });

  it('asks the licence site once per workspace, about every active admin, and mails those who opted in', async () => {
    const { run, email, license } = makeService({
      endedDaysAgo: 2,
      calls: 5,
      admins: [
        { email: 'Ada@Example.com', name: 'Ada' },
        { email: 'bob@example.com', name: 'Bob' },
        { email: 'carl@example.com', name: 'Carl', optedOut: true },
      ],
    });
    const o = await run();
    expect(license.workspacesWithPaidPlan).toHaveBeenCalledTimes(1);
    // An opted-out admin's card trial is the workspace's card trial too.
    expect(license.workspacesWithPaidPlan.mock.calls[0][0]).toEqual([
      { organizationId: 'org-1', adminEmails: ['Ada@Example.com', 'bob@example.com', 'carl@example.com'] },
    ]);
    expect(license.subscriptionHistory).toHaveBeenCalledTimes(1);
    expect(email.sendTrialWinbackEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['Ada@Example.com', 'bob@example.com']);
    expect(o.winbackOffers).toBe(1);
  });

  // 14 Oct 2026: a card trial whose licence never reached the Cloud (not
  // activated in the workspace) left the workspace looking like a free trial.
  it('mails nobody in a workspace one of whose admins had a subscription, and closes the stage', async () => {
    for (const [days, calls] of [
      [2, 5], // first discount
      [2, 0], // how-to: it links to the pricing page too
      [31, 5], // final discount
    ]) {
      const { run, email, upsertedKeys } = makeService({
        endedDaysAgo: days,
        calls,
        admins: [
          { email: 'Ada@Example.com', name: 'Ada' },
          { email: 'bob@example.com', name: 'Bob' },
        ],
        hadSubscription: ['ada@example.com'],
      });
      const o = await run();
      expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
      expect(upsertedKeys()).toEqual([days < 7 ? 'trial_email_winback7' : 'trial_email_winback30']);
      expect(o.skipped).toBe(1);
    }
  });

  it('closes the stage without sending when every recipient had a subscription', async () => {
    for (const days of [2, 31]) {
      const { run, email, upsertedKeys } = makeService({
        endedDaysAgo: days,
        calls: 5,
        hadSubscription: ['admin@example.com'],
      });
      await run();
      expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
      expect(upsertedKeys()).toEqual([days < 7 ? 'trial_email_winback7' : 'trial_email_winback30']);
    }
  });

  it('sends nothing and flags nothing when the licence site cannot answer, so the next run retries', async () => {
    for (const [days, calls] of [
      [2, 5],
      [2, 0],
      [31, 5],
    ]) {
      const { run, email, prisma } = makeService({ endedDaysAgo: days, calls, hadSubscription: null });
      const o = await run();
      expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
      expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
      expect(o.skipped).toBe(1);
    }
  });

  it('offers a consumer workspace without a business app the first month for €5.99 in the test arm, and records it', async () => {
    const { run, email, prisma } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com', name: 'Ada' }],
      connectors: [{ adapterSlug: 'todoist' }, {}],
    });
    const o = await run();
    expect(email.sendTrialWinbackEmail).toHaveBeenCalledWith('ada@gmail.com', 'Ada', {
      kind: 'firstMonth',
      price: '€5.99',
      regularPrice: '€19',
      promoCode: 'STARTER599',
      trialEndedAt: new Date(NOW - 1.2 * DAY),
      successfulCalls: 9,
    });
    expect(o).toMatchObject({ winbackOffers: 1, winbackFirstMonth: 1, winbackControl: 0 });
    const upserts = prisma.orgSettings.upsert.mock.calls.map((c: any) => c[0].create);
    expect(upserts).toEqual([
      expect.objectContaining({ organizationId: TEST_ORG, key: 'trial_email_winback7' }),
      { organizationId: TEST_ORG, key: 'winback_test_arm', value: 'first_month_599' },
    ]);
  });

  it('gives the control arm START30, and records the arm', async () => {
    const { run, email, prisma } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: CONTROL_ORG,
      admins: [{ email: 'ada@web.de', name: 'Ada' }],
    });
    const o = await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({
      kind: 'discount',
      percentOff: 30,
      promoCode: 'START30',
    });
    expect(o).toMatchObject({ winbackOffers: 1, winbackFirstMonth: 0, winbackControl: 1 });
    expect(prisma.orgSettings.upsert.mock.calls[1][0].create).toEqual({
      organizationId: CONTROL_ORG,
      key: 'winback_test_arm',
      value: 'start30_control',
    });
  });

  it('keeps a consumer workspace with a business app (an Etsy shop) out of the test: START30, no arm', async () => {
    const { run, email, upsertedKeys } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'shop@gmail.com' }],
      connectors: [{ adapterSlug: 'etsy' }],
    });
    const o = await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({ kind: 'discount', promoCode: 'START30' });
    expect(upsertedKeys()).toEqual(['trial_email_winback7']);
    expect(o.winbackFirstMonth + o.winbackControl).toBe(0);
  });

  it('counts Vinted as a private seller: still in the test', async () => {
    const { run, email } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }],
      connectors: [{ adapterSlug: 'vinted' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2].kind).toBe('firstMonth');
  });

  it('keeps a workspace with one admin on a company address out of the test', async () => {
    const { run, email, upsertedKeys } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }, { email: 'boss@acme.io' }],
    });
    await run();
    for (const call of email.sendTrialWinbackEmail.mock.calls) {
      expect(call[2]).toMatchObject({ kind: 'discount', promoCode: 'START30' });
    }
    expect(upsertedKeys()).toEqual(['trial_email_winback7']);
  });

  it('records no arm when the test email could not be sent, and retries', async () => {
    const { run, prisma } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }],
      sendOk: false,
    });
    await run();
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
  });

  it('respects the marketing opt-out, and closes the stage', async () => {
    const { run, email, prisma } = makeService({ endedDaysAgo: 2, calls: 5, optedOut: true });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).toHaveBeenCalledTimes(1);
  });

  it('retries on the next run when the email could not be sent', async () => {
    const { run, prisma } = makeService({ endedDaysAgo: 2, calls: 5, sendOk: false });
    await run();
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
  });

  it('takes the codes from the environment when set', async () => {
    process.env.WINBACK_FIRST_PROMO_CODE = 'SPRING30';
    process.env.WINBACK_CONSUMER_PROMO_CODE = 'SPRING599';
    try {
      const control = makeService({ endedDaysAgo: 2, calls: 1 });
      await control.run();
      expect(control.email.sendTrialWinbackEmail.mock.calls[0][2].promoCode).toBe('SPRING30');
      const test = makeService({
        endedDaysAgo: 2,
        calls: 1,
        organizationId: TEST_ORG,
        admins: [{ email: 'ada@gmail.com' }],
      });
      await test.run();
      expect(test.email.sendTrialWinbackEmail.mock.calls[0][2].promoCode).toBe('SPRING599');
    } finally {
      delete process.env.WINBACK_FIRST_PROMO_CODE;
      delete process.env.WINBACK_CONSUMER_PROMO_CODE;
    }
  });
});
