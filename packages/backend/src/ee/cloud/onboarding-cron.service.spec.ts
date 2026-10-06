import { OnboardingCronService } from './onboarding-cron.service';

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
        findMany: jest.fn().mockImplementation(async () => {
          calls.push('lifecycle');
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
    expect(calls).toEqual(['lifecycle', 'mark-expired']);
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

  it('waits the usual 24h for a user with no AI client yet', async () => {
    const { service, email } = makeService({ candidates: [user({})] });
    await service.run();
    expect(email.sendOnboardingReminderEmail).not.toHaveBeenCalled();
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
