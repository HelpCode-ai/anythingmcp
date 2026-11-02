import { OnboardingCronService } from './onboarding-cron.service';

/** When the stub licence site's win-back codes expire. */
const CODES_EXPIRE_AT = new Date('2026-12-04T10:00:00Z');

/**
 * RetentionLicenceClient over a stub licence site: one code per offer
 * ("KEEP-LOCKED-MONTHLY"…), or no answer at all (`unavailable`).
 */
function makeCodes(unavailable = false) {
  return {
    winbackCode: jest.fn(async (_org: string, _segment: string, offer: string) =>
      unavailable ? null : { code: `KEEP-${offer.toUpperCase()}`, expiresAt: CODES_EXPIRE_AT },
    ),
    extendTrial: jest.fn(),
  } as any;
}
const LOCKED = {
  kind: 'locked',
  monthlyCode: 'KEEP-LOCKED-MONTHLY',
  yearlyCode: 'KEEP-LOCKED-YEARLY',
  codesExpireAt: CODES_EXPIRE_AT,
};
const PERSONAL = { kind: 'personal', code: 'KEEP-PERSONAL-MONTHLY', codesExpireAt: CODES_EXPIRE_AT };

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
    bindUnclaimedPaidLicences: jest
      .fn()
      .mockResolvedValue({ listed: 2, bound: 1, skipped: 1, failed: 0 }),
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
      // No blocked-call events: the blocked-call pass is a no-op here.
      productEvent: { groupBy: jest.fn().mockResolvedValue([]) },
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
      // No blocked-call events: the blocked-call pass is a no-op here.
      productEvent: { groupBy: jest.fn().mockResolvedValue([]) },
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
    optedOut?: string[];
    codesUnavailable?: boolean;
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
            (email) => ({ user: { email, name: 'Ada', emailMarketingOptOut: (opts.optedOut ?? []).includes(email) } }),
          ),
        ),
      },
      connector: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([{ config: {} }]),
        findUnique: jest.fn().mockResolvedValue({ name: 'Odoo ERP' }),
      },
      toolInvocation: {
        count: jest.fn().mockResolvedValue(40),
        groupBy: jest.fn().mockResolvedValue([{ connectorId: 'conn-odoo', _count: { _all: 31 } }]),
      },
    } as any;
    const email = {
      sendTrialLifecycleEmail: jest.fn().mockResolvedValue(true),
      sendTrialEndedBusinessEmail: jest.fn().mockResolvedValue(true),
    } as any;
    const license = makeLicense();
    license.workspacesWithPaidPlan = jest.fn(async () => ({
      paid: new Set(opts.paid ?? []),
      unknown: new Set(opts.unknown ?? []),
    }));
    const codes = makeCodes(opts.codesUnavailable);
    const service = new OnboardingCronService(prisma, email, license, makeRelease(), undefined, codes);
    const run = async () => {
      const o = { ...out(), trialExpiredBusiness: 0 };
      await (service as any).runTrialLifecyclePass(NOW, o);
      return o;
    };
    const flagged = () =>
      prisma.orgSettings.upsert.mock.calls.map((c: any) => [
        c[0].where.organizationId_key.organizationId,
        c[0].where.organizationId_key.key,
      ]);
    const stored = () =>
      Object.fromEntries(
        prisma.orgSettings.upsert.mock.calls.map((c: any) => [c[0].where.organizationId_key.key, c[0].create.value]),
      );
    return { run, email, license, flagged, stored, codes };
  }

  it('sends each free trial its stage and flags it', async () => {
    const { run, email, flagged } = makeService({
      trials: [
        { organizationId: 'org-3d', endsInHours: 60 },
        { organizationId: 'org-1d', endsInHours: 20 },
        { organizationId: 'org-0d', endsInHours: -1, admins: ['ada@gmail.com'] },
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

  describe('the expiry day of a business workspace', () => {
    const ORIGINAL_JWT = process.env.JWT_SECRET;
    beforeAll(() => {
      process.env.JWT_SECRET = 'test-jwt-secret';
    });
    afterAll(() => {
      process.env.JWT_SECRET = ORIGINAL_JWT;
    });
    const ended = (org: string, extra: Partial<{ admins: string[] }> = {}) => ({
      organizationId: org,
      endsInHours: -1,
      ...extra,
    });

    it('is the plain email from Matteo: recap, top connector, extension link and the locked price', async () => {
      const { run, email, stored, flagged } = makeService({ trials: [ended('org-1')] });
      const o = await run();
      expect(email.sendTrialLifecycleEmail).not.toHaveBeenCalled();
      const [to, name, details] = email.sendTrialEndedBusinessEmail.mock.calls[0];
      expect([to, name]).toEqual(['admin@example.com', 'Ada']);
      expect(details.recap).toEqual({ connectors: 2, successfulCalls: 40, topConnector: 'Odoo ERP' });
      expect(details.offer).toEqual(LOCKED);
      const token = decodeURIComponent(new URL(details.extendUrl).searchParams.get('token')!);
      expect(details.extendUrl).toMatch(/^https:\/\/cloud\.anythingmcp\.com\/api\/license\/extend\?token=/);
      const { readTrialExtensionToken } = await import('../../license/trial-extension-token');
      expect(readTrialExtensionToken(token, 'test-jwt-secret', new Date(NOW))).toEqual({ ok: true, organizationId: 'org-1' });
      // It stops working 7 days after the trial ended.
      expect(readTrialExtensionToken(token, 'test-jwt-secret', new Date(NOW - HOUR + 7 * 24 * HOUR + 1000))).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(flagged().map((f: string[]) => f[1])).toEqual(['winback_holdout', 'winback_offer', 'trial_email_expired']);
      expect(stored()).toMatchObject({ winback_holdout: 'business:treatment', winback_offer: 'business:locked:expired' });
      expect(o).toMatchObject({ trialExpired: 1, trialExpiredBusiness: 1 });
    });

    it('keeps today\'s notice for the control group', async () => {
      const { run, email, stored, codes } = makeService({ trials: [ended('org-h2')] });
      await run();
      expect(email.sendTrialEndedBusinessEmail).not.toHaveBeenCalled();
      expect(email.sendTrialLifecycleEmail.mock.calls[0][2]).toBe('expired');
      expect(stored().winback_holdout).toBe('business:control');
      expect(codes.winbackCode).not.toHaveBeenCalled();
    });

    it('falls back to today\'s notice when the codes cannot be minted: this stage gets one run', async () => {
      const { run, email, stored } = makeService({ trials: [ended('org-1')], codesUnavailable: true });
      const o = await run();
      expect(email.sendTrialEndedBusinessEmail).not.toHaveBeenCalled();
      expect(email.sendTrialLifecycleEmail).toHaveBeenCalledTimes(1);
      expect(stored().winback_offer).toBeUndefined();
      expect(o.trialExpired).toBe(1);
    });

    it('sends today\'s notice to an admin who opted out of marketing, the personal one to the others', async () => {
      const { run, email } = makeService({
        trials: [ended('org-1', { admins: ['boss@acme.io', 'it@acme.io'] })],
        optedOut: ['it@acme.io'],
      });
      await run();
      expect(email.sendTrialEndedBusinessEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['boss@acme.io']);
      expect(email.sendTrialLifecycleEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['it@acme.io']);
    });

    it('leaves consumer workspaces and the earlier stages unchanged', async () => {
      const { run, email, codes } = makeService({
        trials: [ended('org-1', { admins: ['ada@gmail.com'] }), { organizationId: 'org-2', endsInHours: 20 }],
      });
      // A consumer workspace: no business connector either.
      await run();
      expect(email.sendTrialLifecycleEmail.mock.calls.map((c: any[]) => c[2]).sort()).toEqual(['expired', 'warn1']);
      expect(email.sendTrialEndedBusinessEmail).not.toHaveBeenCalled();
      expect(codes.winbackCode).not.toHaveBeenCalled();
    });
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
      // No blocked-call events: the blocked-call pass is a no-op here.
      productEvent: { groupBy: jest.fn().mockResolvedValue([]) },
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
    // And paid licences that never reached their workspace get bound to it.
    expect(license.bindUnclaimedPaidLicences).toHaveBeenCalledTimes(1);
    expect(out.licensesBound).toBe(1);
  });
});

describe('OnboardingCronService — onboarding pass', () => {
  const HOUR = 60 * 60 * 1000;
  function makeService(opts: {
    candidates: any[];
    orgConnectors?: Record<string, number>;
    grants?: { userId: string; clientId: string }[];
    /** product_events rows the intent check reads: intent events, then signup_attributed. */
    intentEvents?: Array<{ userId: string | null; organizationId: string | null }>;
    signups?: Array<{ userId: string | null; organizationId: string | null; metadata: unknown }>;
  }) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      productEvent: {
        // No blocked-call events: the blocked-call pass is a no-op here.
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn(async (args: any) =>
          args.where.event === 'signup_attributed' ? (opts.signups ?? []) : (opts.intentEvents ?? []),
        ),
        create: jest.fn().mockResolvedValue({}),
      },
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
  // Arms of these ids (onboarding-reminder.spec.ts): u3 A, u2 B, u1 holdout.
  const user = (over: Partial<any>) => ({
    id: 'u3',
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
      grants: [{ userId: 'u3', clientId: 'claude-client' }],
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

  describe('reminder 1 test arms', () => {
    const events = (prisma: any) => prisma.productEvent.create.mock.calls.map((c: any[]) => c[0].data);

    it('arm A: today\'s email, recorded with its arm', async () => {
      const { service, email, prisma } = makeService({ candidates: [user({ id: 'u3' })] });
      const out = await service.run();
      expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 1, undefined);
      expect(out.firstReminders).toBe(1);
      expect(events(prisma)).toEqual([
        {
          event: 'onboarding_reminder_sent',
          userId: 'u3',
          organizationId: 'org-1',
          metadata: { reminder: 1, arm: 'A', kind: 'generic' },
        },
      ]);
    });

    it('arm B: three one-click Claude chats for setups without app review', async () => {
      const { service, email, prisma } = makeService({ candidates: [user({ id: 'u2' })] });
      await service.run();
      const opts = email.sendOnboardingReminderEmail.mock.calls[0][3];
      expect(opts.quickSetups).toEqual([
        { label: 'Telegram bot', url: 'https://claude.ai/new?q=Connect%20my%20Telegram%20bot%20to%20AnythingMCP' },
        { label: 'Odoo', url: 'https://claude.ai/new?q=Connect%20my%20Odoo%20to%20AnythingMCP' },
        { label: 'Shopify store', url: 'https://claude.ai/new?q=Connect%20my%20Shopify%20store%20to%20AnythingMCP' },
      ]);
      expect(events(prisma)[0].metadata).toEqual({ reminder: 1, arm: 'B', kind: 'generic' });
    });

    it('a user with an AI client gets the AI-client email in arm B too, recorded as such', async () => {
      const { service, email, prisma } = makeService({
        candidates: [user({ id: 'u2' })],
        grants: [{ userId: 'u2', clientId: 'claude-client' }],
      });
      await service.run();
      expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 1, { aiClient: 'Claude' });
      expect(events(prisma)[0].metadata).toEqual({ reminder: 1, arm: 'B', kind: 'ai_client' });
    });

    it('holdout: no email, the step closed without a send date, one holdout event', async () => {
      const { service, email, prisma, update } = makeService({ candidates: [user({ id: 'u1' })] });
      const out = await service.run();
      expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
      expect(out.firstReminderHoldout).toBe(1);
      expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { onboardingReminderCount: 1 } });
      expect(events(prisma)).toEqual([
        {
          event: 'onboarding_reminder_holdout',
          userId: 'u1',
          organizationId: 'org-1',
          metadata: { reminder: 1, arm: 'holdout' },
        },
      ]);
    });

    it('records nothing when the email could not be sent, so the next run retries', async () => {
      const { service, email, prisma, update } = makeService({ candidates: [user({ id: 'u3' })] });
      email.sendOnboardingReminderEmail.mockResolvedValue(false);
      await service.run();
      expect(update).not.toHaveBeenCalled();
      expect(prisma.productEvent.create).not.toHaveBeenCalled();
    });

    it('still sends when the event cannot be written', async () => {
      const { service, prisma } = makeService({ candidates: [user({ id: 'u3' })] });
      prisma.productEvent.create.mockRejectedValue(new Error('db down'));
      const out = await service.run();
      expect(out.firstReminders).toBe(1);
    });
  });

  describe('reminder 2 only with intent', () => {
    const due = (over: Partial<any> = {}) =>
      user({
        onboardingReminderCount: 1,
        onboardingLastReminderAt: new Date(Date.now() - 70 * HOUR),
        createdAt: new Date(Date.now() - 73 * HOUR),
        ...over,
      });

    it('is withheld from a user who showed no intent: count unchanged', async () => {
      const { service, email, update } = makeService({ candidates: [due()] });
      const out = await service.run();
      expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
      expect(out.secondRemindersWithheld).toBe(1);
      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      ['a catalog search of the workspace', { intentEvents: [{ userId: null, organizationId: 'org-1' }] }],
      ['a guided setup the user opened', { intentEvents: [{ userId: 'u3', organizationId: null }] }],
      [
        'a sign-up from Google',
        { signups: [{ userId: 'u3', organizationId: 'org-1', metadata: { first_channel: 'organic_google' } }] },
      ],
    ])('goes to a user with %s, recorded with the arm', async (_label, rows) => {
      const { service, email, prisma, update } = makeService({ candidates: [due()], ...rows });
      const out = await service.run();
      expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 2);
      expect(out.secondReminders).toBe(1);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ onboardingReminderCount: 2 }) }),
      );
      expect(prisma.productEvent.create.mock.calls[0][0].data.metadata).toEqual({
        reminder: 2,
        arm: 'A',
        kind: 'generic',
      });
    });

    it('does not count a direct sign-up, or one without a channel, as intent', async () => {
      const { service, email } = makeService({
        candidates: [due()],
        signups: [
          { userId: 'u3', organizationId: 'org-1', metadata: { first_channel: 'direct' } },
          { userId: 'u3', organizationId: 'org-1', metadata: {} },
        ],
      });
      await service.run();
      expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
    });

    it('does not count another workspace\'s events', async () => {
      const { service, email } = makeService({
        candidates: [due()],
        intentEvents: [{ userId: 'someone-else', organizationId: 'org-2' }],
      });
      await service.run();
      expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
    });

    it('asks for intent events of the user and the workspace, of the last 15 days, only for users due', async () => {
      const { service, prisma } = makeService({ candidates: [due(), user({ id: 'u2' })] });
      const before = Date.now();
      await service.run();
      const calls = prisma.productEvent.findMany.mock.calls.map((c: any[]) => c[0].where);
      const actions = calls.find((w: any) => w.event.in);
      expect(actions.event.in).toEqual(['catalog_search', 'setup_started', 'setup_step_viewed']);
      expect(actions.OR).toEqual([{ userId: { in: ['u3'] } }, { organizationId: { in: ['org-1'] } }]);
      const age = before - actions.createdAt.gte.getTime();
      expect(age).toBeGreaterThanOrEqual(15 * 24 * HOUR - 1000);
      expect(age).toBeLessThan(15 * 24 * HOUR + 60_000);
    });

    it('does not query events when nobody is due for reminder 2', async () => {
      const { service, prisma } = makeService({ candidates: [user({ id: 'u3' })] });
      await service.run();
      expect(prisma.productEvent.findMany).not.toHaveBeenCalled();
    });

    it('a holdout user with intent gets reminder 2 three days after sign-up', async () => {
      const { service, email } = makeService({
        candidates: [due({ id: 'u1', onboardingLastReminderAt: null })],
        intentEvents: [{ userId: 'u1', organizationId: 'org-1' }],
      });
      await service.run();
      expect(email.sendOnboardingReminderEmail).toHaveBeenCalledWith('u1@example.com', 'Ada', 2);
    });
  });
});

describe('OnboardingCronService — trial win-back', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-11-20T10:00:00Z').getTime();
  const out = () => ({
    examined: 0,
    winbackOffers: 0,
    winbackHelp: 0,
    winbackHoldout: 0,
    skipped: 0,
  });
  // Both outside the win-back holdout (first byte of the salted hash: 72 and 96).
  const TEST_ORG = 'org-1';
  const CONTROL_ORG = 'org-4';

  type Admin = { email: string; name?: string; optedOut?: boolean };

  function makeService(opts: {
    endedDaysAgo: number;
    organizationId?: string;
    calls?: number;
    /** Licences of the workspace besides its free trial. */
    otherLicences?: { plan: string; status: string }[];
    flagged?: string[];
    /** OrgSettings already stored, with their value. */
    stored?: Record<string, string>;
    /** A win-back email flagged within the last day. */
    recentWinbackEmail?: boolean;
    optedOut?: boolean;
    admins?: Admin[];
    connectors?: { adapterSlug?: string }[];
    /** Addresses the licence site says had a subscription; null = the site failed. */
    hadSubscription?: string[] | null;
    sendOk?: boolean;
    codesUnavailable?: boolean;
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
        findUnique: jest.fn(async ({ where }: any) => {
          const key = where.organizationId_key.key;
          if (opts.stored && key in opts.stored) return { id: 's', value: opts.stored[key] };
          return (opts.flagged ?? []).includes(key) ? { id: 'f', value: '2026-10-01T00:00:00.000Z' } : null;
        }),
        findFirst: jest.fn().mockResolvedValue(opts.recentWinbackEmail ? { id: 'r' } : null),
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
    const codes = makeCodes(opts.codesUnavailable);
    const service = new OnboardingCronService(prisma, email, license, makeRelease(), undefined, codes);
    const run = async () => {
      const o = out();
      await (service as any).runWinbackPass(NOW, o);
      return o;
    };
    const upsertedKeys = () =>
      prisma.orgSettings.upsert.mock.calls.map((c: any) => c[0].where.organizationId_key.key);
    const stored = (key: string) =>
      prisma.orgSettings.upsert.mock.calls.find((c: any) => c[0].where.organizationId_key.key === key)?.[0].create.value;
    return { run, prisma, email, license, upsertedKeys, stored, codes };
  }

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

  it('a day after, offers a business workspace the locked price with its two codes, dated, under the old flag key', async () => {
    const { run, email, upsertedKeys, stored, codes } = makeService({ endedDaysAgo: 1.2, calls: 12 });
    const o = await run();
    expect(email.sendTrialWinbackEmail).toHaveBeenCalledWith('admin@example.com', 'Ada', {
      kind: 'offer',
      offer: LOCKED,
      stage: 'first',
      trialEndedAt: new Date(NOW - 1.2 * DAY),
      successfulCalls: 12,
    });
    expect(codes.winbackCode.mock.calls).toEqual([
      ['org-1', 'business', 'locked-monthly'],
      ['org-1', 'business', 'locked-yearly'],
    ]);
    expect(o.winbackOffers).toBe(1);
    expect(upsertedKeys()).toEqual(['winback_holdout', 'trial_email_winback7', 'winback_offer']);
    expect(stored('winback_holdout')).toBe('business:treatment');
    expect(stored('winback_offer')).toBe('business:locked:first');
  });

  it('never sends the first win-back twice: the flag of the old one-week timing counts', async () => {
    const { run, email } = makeService({ endedDaysAgo: 2, calls: 5, flagged: ['trial_email_winback7'] });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
  });

  it('a month after, offers the locked price again, with codes asked for afresh', async () => {
    const { run, email, upsertedKeys, stored, codes } = makeService({ endedDaysAgo: 31, calls: 2 });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({ kind: 'offer', offer: LOCKED, stage: 'final' });
    expect(codes.winbackCode).toHaveBeenCalledTimes(2);
    expect(upsertedKeys()).toEqual(['winback_holdout', 'trial_email_winback30', 'winback_offer']);
    expect(stored('winback_offer')).toBe('business:locked:final');
  });

  it('gives a consumer workspace Personal, first and final, never 50%', async () => {
    for (const [days, stage] of [
      [1.2, 'first'],
      [31, 'final'],
    ] as const) {
      const { run, email, stored, codes } = makeService({
        endedDaysAgo: days,
        calls: 2,
        organizationId: TEST_ORG,
        admins: [{ email: 'ada@gmail.com', name: 'Ada' }],
      });
      await run();
      expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toMatchObject({ kind: 'offer', offer: PERSONAL, stage });
      expect(codes.winbackCode.mock.calls).toEqual([[TEST_ORG, 'consumer', 'personal-monthly']]);
      expect(stored('winback_offer')).toBe(`consumer:personal:${stage}`);
    }
  });

  it('gives a Telegram-only workspace Personal too', async () => {
    const { run, email, stored } = makeService({
      endedDaysAgo: 1.2,
      calls: 4,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }],
      connectors: [{ adapterSlug: 'telegram-bot' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2].offer).toEqual(PERSONAL);
    expect(stored('winback_offer')).toBe('telegram:personal:first');
  });

  it('sends nothing and flags nothing but the holdout decision when the codes cannot be minted', async () => {
    const { run, email, upsertedKeys } = makeService({ endedDaysAgo: 2, calls: 5, codesUnavailable: true });
    const o = await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(upsertedKeys()).toEqual(['winback_holdout']);
    expect(o.skipped).toBe(1);
  });

  it('a day after, sends the how-to without a discount to a workspace that never made a call', async () => {
    const { run, email, license, stored } = makeService({ endedDaysAgo: 1.5, calls: 0 });
    const o = await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2]).toEqual({
      kind: 'help',
      trialEndedAt: new Date(NOW - 1.5 * DAY),
    });
    expect(o.winbackHelp).toBe(1);
    // No offer, no code minted.
    expect(stored('winback_offer')).toBe('unused:help:first');
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

  it('counts an Etsy shop as a business, even from a Gmail address: the locked price', async () => {
    const { run, email } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'shop@gmail.com' }],
      connectors: [{ adapterSlug: 'etsy' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2].offer).toEqual(LOCKED);
  });

  it('counts Vinted as a private seller: Personal', async () => {
    const { run, email } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }],
      connectors: [{ adapterSlug: 'vinted' }],
    });
    await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2].offer).toEqual(PERSONAL);
  });

  it('counts a workspace with one admin on a company address as a business', async () => {
    const { run, email } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }, { email: 'boss@acme.io' }],
    });
    await run();
    for (const call of email.sendTrialWinbackEmail.mock.calls) expect(call[2].offer).toEqual(LOCKED);
  });

  it('starts no first-month test arm any more', async () => {
    const { run, upsertedKeys } = makeService({
      endedDaysAgo: 1.2,
      calls: 9,
      organizationId: TEST_ORG,
      admins: [{ email: 'ada@gmail.com' }],
    });
    await run();
    expect(upsertedKeys()).not.toContain('winback_test_arm');
  });

  it('respects the marketing opt-out, and closes the stage', async () => {
    const { run, email, prisma } = makeService({ endedDaysAgo: 2, calls: 5, optedOut: true });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).toHaveBeenCalledTimes(1);
  });

  it('retries on the next run when the email could not be sent', async () => {
    const { run, upsertedKeys } = makeService({ endedDaysAgo: 2, calls: 5, sendOk: false });
    await run();
    expect(upsertedKeys()).toEqual(['winback_holdout']);
  });

});

describe('OnboardingCronService — win-back holdout', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-11-20T10:00:00Z').getTime();
  // First byte of sha256('winback-holdout:' + id): 5 (held in every segment),
  // 33 (held as consumer or Telegram, not as business), 169 (never held).
  const HELD_ALWAYS = 'org-h2';
  const HELD_CONSUMER = 'org-h22';

  function makeService(opts: {
    organizationId: string;
    adminEmail: string;
    calls?: number;
    stored?: Record<string, string>;
    recentWinbackEmail?: boolean;
  }) {
    const prisma = {
      license: {
        findMany: jest.fn().mockResolvedValue([
          { organizationId: opts.organizationId, expiresAt: new Date(NOW - 2 * DAY) },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
      orgSettings: {
        findUnique: jest.fn(async ({ where }: any) => {
          const key = where.organizationId_key.key;
          return opts.stored && key in opts.stored ? { id: 's', value: opts.stored[key] } : null;
        }),
        findFirst: jest.fn().mockResolvedValue(opts.recentWinbackEmail ? { id: 'r' } : null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      organizationMember: {
        findMany: jest.fn().mockResolvedValue([
          { user: { email: opts.adminEmail, name: 'Ada', emailMarketingOptOut: false } },
        ]),
      },
      toolInvocation: { count: jest.fn().mockResolvedValue(opts.calls ?? 5) },
      connector: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const email = { sendTrialWinbackEmail: jest.fn().mockResolvedValue(true) } as any;
    const license = makeLicense();
    license.workspacesWithPaidPlan = jest.fn().mockResolvedValue({ paid: new Set(), unknown: new Set() });
    const service = new OnboardingCronService(prisma, email, license, makeRelease(), undefined, makeCodes());
    const run = async () => {
      const o = { examined: 0, winbackOffers: 0, winbackHelp: 0, winbackHoldout: 0, skipped: 0 };
      await (service as any).runWinbackPass(NOW, o);
      return o;
    };
    const stored = () =>
      Object.fromEntries(prisma.orgSettings.upsert.mock.calls.map((c: any) => [c[0].create.key, c[0].create.value]));
    return { run, email, prisma, stored };
  }

  it('holds out a business workspace in its 10%: no offer, the stage closed, the decision stored', async () => {
    const { run, email, stored } = makeService({ organizationId: HELD_ALWAYS, adminEmail: 'boss@acme.io' });
    const o = await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(o.winbackHoldout).toBe(1);
    expect(stored()).toEqual({ winback_holdout: 'business:control', trial_email_winback7: expect.any(String) });
  });

  it('holds out 20% of consumer workspaces, a wider band than business', async () => {
    const consumer = makeService({ organizationId: HELD_CONSUMER, adminEmail: 'ada@gmail.com' });
    expect((await consumer.run()).winbackHoldout).toBe(1);
    expect(consumer.stored().winback_holdout).toBe('consumer:control');

    const business = makeService({ organizationId: HELD_CONSUMER, adminEmail: 'boss@acme.io' });
    expect((await business.run()).winbackOffers).toBe(1);
    expect(business.stored()).toMatchObject({ winback_holdout: 'business:treatment', winback_offer: 'business:locked:first' });
  });

  it('keeps the stored decision, even if the segment has changed since', async () => {
    const { run, email, stored } = makeService({
      organizationId: HELD_ALWAYS,
      adminEmail: 'boss@acme.io',
      stored: { winback_holdout: 'consumer:treatment' },
    });
    await run();
    expect(email.sendTrialWinbackEmail).toHaveBeenCalledTimes(1);
    expect(stored().winback_holdout).toBeUndefined();
  });

  it('never holds out the how-to of a workspace that made no call', async () => {
    const { run, email, stored } = makeService({ organizationId: HELD_ALWAYS, adminEmail: 'boss@acme.io', calls: 0 });
    const o = await run();
    expect(email.sendTrialWinbackEmail.mock.calls[0][2].kind).toBe('help');
    expect(o.winbackHelp).toBe(1);
    expect(stored().winback_holdout).toBeUndefined();
  });

  it('waits a day after another win-back email (the blocked-call one): nothing sent, nothing stored', async () => {
    const { run, email, prisma } = makeService({ organizationId: 'org-1', adminEmail: 'boss@acme.io', recentWinbackEmail: true });
    await run();
    expect(email.sendTrialWinbackEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
    const where = prisma.orgSettings.findFirst.mock.calls[0][0].where;
    expect(where.key.in).toEqual(['trial_email_winback7', 'trial_email_winback30', 'trial_email_blocked_calls']);
    expect(where.updatedAt.gt).toEqual(new Date(NOW - DAY));
  });
});

describe('OnboardingCronService — blocked-call email', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = new Date('2026-11-20T10:00:00Z').getTime();
  const ORG = 'org-1'; // holdout byte 72: never held out
  const HELD_ALWAYS = 'org-h2';
  const HELD_CONSUMER = 'org-h22';

  type Event = { adapterSlug?: string; client?: string; toolName?: string };

  function makeService(opts: {
    organizationId?: string;
    events?: Event[];
    eventCount?: number;
    trialEndedHoursAgo?: number | null;
    calls?: number;
    otherLicences?: number;
    admins?: Array<{ email: string; name?: string; optedOut?: boolean }>;
    connectors?: { adapterSlug?: string }[];
    paid?: boolean;
    unknown?: boolean;
    flagged?: string[];
    stored?: Record<string, string>;
    recentWinbackEmail?: boolean;
    sendOk?: boolean;
    codesUnavailable?: boolean;
  } = {}) {
    const organizationId = opts.organizationId ?? ORG;
    const events = opts.events ?? [
      { adapterSlug: 'etsy', client: 'Claude', toolName: 'etsy_list' },
      { adapterSlug: 'etsy', client: 'Claude', toolName: 'etsy_get' },
      { adapterSlug: 'etsy', client: 'Claude', toolName: 'etsy_list' },
    ];
    const admins = opts.admins ?? [{ email: 'ada@gmail.com', name: 'Ada' }];
    const prisma = {
      productEvent: {
        groupBy: jest.fn().mockResolvedValue([{ organizationId, _count: { _all: opts.eventCount ?? events.length } }]),
        findMany: jest.fn().mockResolvedValue(events.map((metadata) => ({ metadata }))),
      },
      license: {
        count: jest.fn().mockResolvedValue(opts.otherLicences ?? 0),
        findFirst: jest.fn().mockResolvedValue(
          opts.trialEndedHoursAgo === null
            ? null
            : { expiresAt: new Date(NOW - (opts.trialEndedHoursAgo ?? 72) * HOUR) },
        ),
      },
      orgSettings: {
        findUnique: jest.fn(async ({ where }: any) => {
          const key = where.organizationId_key.key;
          if (opts.stored && key in opts.stored) return { id: 's', value: opts.stored[key] };
          return (opts.flagged ?? []).includes(key) ? { id: 'f', value: '2026-11-01T00:00:00.000Z' } : null;
        }),
        findFirst: jest.fn().mockResolvedValue(opts.recentWinbackEmail ? { id: 'r' } : null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      organizationMember: {
        findMany: jest.fn().mockResolvedValue(
          admins.map((a) => ({ user: { email: a.email, name: a.name ?? null, emailMarketingOptOut: !!a.optedOut } })),
        ),
      },
      toolInvocation: { count: jest.fn().mockResolvedValue(opts.calls ?? 8) },
      connector: {
        findMany: jest.fn().mockResolvedValue((opts.connectors ?? [{ adapterSlug: 'todoist' }]).map((c) => ({ config: c }))),
      },
    } as any;
    const email = { sendTrialBlockedCallsEmail: jest.fn().mockResolvedValue(opts.sendOk ?? true) } as any;
    const license = makeLicense();
    license.workspacesWithPaidPlan = jest.fn().mockResolvedValue({
      paid: new Set(opts.paid ? [organizationId] : []),
      unknown: new Set(opts.unknown ? [organizationId] : []),
    });
    const codes = makeCodes(opts.codesUnavailable);
    const service = new OnboardingCronService(prisma, email, license, makeRelease(), undefined, codes);
    const run = async () => {
      const o = { examined: 0, blockedCallEmails: 0, blockedCallHoldout: 0, skipped: 0 };
      await (service as any).runBlockedCallPass(NOW, o);
      return o;
    };
    const stored = () =>
      Object.fromEntries(prisma.orgSettings.upsert.mock.calls.map((c: any) => [c[0].create.key, c[0].create.value]));
    return { run, prisma, email, license, stored };
  }

  it('counts the blocked-call events of the last 48 hours', async () => {
    const { run, prisma } = makeService();
    await run();
    const where = prisma.productEvent.groupBy.mock.calls[0][0].where;
    expect(where.event).toBe('trial_expired_call_blocked');
    expect(where.createdAt.gte).toEqual(new Date(NOW - 48 * HOUR));
    expect(prisma.productEvent.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(new Date(NOW - 48 * HOUR));
  });

  it('names the client and the app, how often, with the segment offer, and counts as the first win-back', async () => {
    const { run, email, stored } = makeService({ connectors: [{ adapterSlug: 'etsy' }] });
    const o = await run();
    expect(email.sendTrialBlockedCallsEmail).toHaveBeenCalledWith('ada@gmail.com', 'Ada', {
      attempts: 3,
      appName: 'Etsy',
      clientName: 'Claude',
      neverUsed: false,
      offer: LOCKED,
      trialEndedAt: new Date(NOW - 72 * HOUR),
    });
    expect(o.blockedCallEmails).toBe(1);
    // Etsy is a business connector, even from a Gmail address.
    expect(stored()).toEqual({
      winback_holdout: 'business:treatment',
      trial_email_blocked_calls: expect.any(String),
      trial_email_winback7: expect.any(String),
      winback_offer: 'business:locked:blocked_calls',
    });
  });

  it('keeps the first win-back flag it finds, and says "Your AI" without a client', async () => {
    const { run, email, stored } = makeService({
      events: [{ toolName: 'custom_a' }, { toolName: 'custom_b' }],
      flagged: ['trial_email_winback7'],
    });
    await run();
    expect(email.sendTrialBlockedCallsEmail.mock.calls[0][2]).toMatchObject({ attempts: 2, appName: null, clientName: null });
    expect(stored().trial_email_winback7).toBeUndefined();
  });

  it('needs at least two events', async () => {
    const { run, email, prisma } = makeService({ events: [{ adapterSlug: 'etsy' }], eventCount: 1 });
    const o = await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(prisma.license.count).not.toHaveBeenCalled();
    expect(o.examined).toBe(0);
  });

  it('goes once per workspace', async () => {
    const { run, email } = makeService({ flagged: ['trial_email_blocked_calls'] });
    await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
  });

  it('skips a customer for good: any licence besides the free trial, or a subscription on the licence site', async () => {
    for (const opts of [{ otherLicences: 1 }, { paid: true }]) {
      const { run, email, stored, license } = makeService(opts);
      await run();
      expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
      expect(Object.keys(stored())).toEqual(['trial_email_blocked_calls']);
      if (opts.otherLicences) expect(license.workspacesWithPaidPlan).not.toHaveBeenCalled();
    }
  });

  it('postpones when the licence site cannot answer: nothing sent, nothing stored', async () => {
    const { run, email, prisma } = makeService({ unknown: true });
    await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
  });

  it('skips a trial that is not over any more, or a workspace without one', async () => {
    for (const trialEndedHoursAgo of [-24, null]) {
      const { run, email, prisma } = makeService({ trialEndedHoursAgo });
      await run();
      expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
      expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
    }
  });

  it('respects the marketing opt-out, and mails only the admins who did not opt out', async () => {
    const all = makeService({ admins: [{ email: 'ada@gmail.com', optedOut: true }] });
    await all.run();
    expect(all.email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(Object.keys(all.stored())).toEqual(['trial_email_blocked_calls']);

    const some = makeService({ admins: [{ email: 'ada@gmail.com', optedOut: true }, { email: 'bob@gmail.com' }] });
    await some.run();
    expect(some.email.sendTrialBlockedCallsEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['bob@gmail.com']);
  });

  it('also mails a workspace that never made a successful call, in its own words', async () => {
    const { run, email, stored } = makeService({ calls: 0 });
    const o = await run();
    expect(email.sendTrialBlockedCallsEmail.mock.calls[0][2]).toMatchObject({ neverUsed: true, offer: PERSONAL });
    expect(o.blockedCallEmails).toBe(1);
    expect(stored()).toMatchObject({ winback_holdout: 'unused:treatment', winback_offer: 'unused:personal:blocked_calls' });
  });

  it('holds out unused workspaces in the 20% band', async () => {
    const { run, email, stored } = makeService({ calls: 0, organizationId: HELD_CONSUMER });
    const o = await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(o.blockedCallHoldout).toBe(1);
    expect(stored().winback_holdout).toBe('unused:control');
  });

  it('holds out the control group: no email, once, decision stored', async () => {
    const business = makeService({ organizationId: HELD_ALWAYS, admins: [{ email: 'boss@acme.io' }] });
    const o = await business.run();
    expect(business.email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(o.blockedCallHoldout).toBe(1);
    expect(business.stored()).toEqual({ winback_holdout: 'business:control', trial_email_blocked_calls: expect.any(String) });

    // A Telegram-only consumer workspace is in the wider band.
    const telegram = makeService({ organizationId: HELD_CONSUMER, connectors: [{ adapterSlug: 'telegram-bot' }] });
    expect((await telegram.run()).blockedCallHoldout).toBe(1);
    expect(telegram.stored().winback_holdout).toBe('telegram:control');
  });

  it('waits a day after another win-back email', async () => {
    const { run, email, prisma } = makeService({ recentWinbackEmail: true });
    await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.orgSettings.findFirst.mock.calls[0][0].where.updatedAt.gt).toEqual(new Date(NOW - 24 * HOUR));
  });

  it('gives consumer and Telegram workspaces Personal', async () => {
    for (const [connectors, segment] of [
      [[{ adapterSlug: 'todoist' }], 'consumer'],
      [[{ adapterSlug: 'telegram-bot' }], 'telegram'],
    ] as const) {
      const { run, email, stored } = makeService({ connectors: [...connectors] });
      await run();
      expect(email.sendTrialBlockedCallsEmail.mock.calls[0][2].offer).toEqual(PERSONAL);
      expect(stored().winback_offer).toBe(`${segment}:personal:blocked_calls`);
    }
  });

  it('postpones when the codes cannot be minted: nothing sent, only the holdout decision stored', async () => {
    const { run, email, stored } = makeService({ codesUnavailable: true });
    await run();
    expect(email.sendTrialBlockedCallsEmail).not.toHaveBeenCalled();
    expect(Object.keys(stored())).toEqual(['winback_holdout']);
  });

  it('retries on the next run when no email could be sent', async () => {
    const { run, stored } = makeService({ sendOk: false });
    const o = await run();
    expect(o.blockedCallEmails).toBe(0);
    expect(Object.keys(stored())).toEqual(['winback_holdout']);
  });

  it('runs inside run(), after the win-back pass', async () => {
    const order: string[] = [];
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      license: {
        findMany: jest.fn(async () => {
          order.push('license');
          return [];
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      productEvent: {
        groupBy: jest.fn(async () => {
          order.push('blocked');
          return [];
        }),
      },
    } as any;
    const svc = new OnboardingCronService(prisma, {} as any, makeLicense(), makeRelease());
    const out = await svc.run();
    expect(order).toEqual(['license', 'license', 'blocked']);
    expect(out).toMatchObject({ blockedCallEmails: 0, blockedCallHoldout: 0, winbackHoldout: 0 });
  });
});
