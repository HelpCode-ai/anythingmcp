/**
 * The first successful tool call of a Cloud workspace: stored once, and on
 * the no-card trial it makes the workspace eligible for the card-trial offer,
 * once. Cheap on the call path: one indexed read per workspace and process.
 */
import { FirstSuccessService } from './first-success.service';
import { ProductEventService } from './product-event.service';
import { AuditService } from './audit.service';
import {
  FIRST_SUCCESS_KEY,
  OFFER_ELIGIBLE_KEY,
  offerLicenceState,
  type OfferLicence,
} from '../license/card-trial-offer';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const trial = (overrides: Partial<OfferLicence> = {}): OfferLicence => ({
  plan: 'trial',
  status: 'active',
  expiresAt: new Date(NOW.getTime() + 5 * DAY),
  createdAt: new Date(NOW.getTime() - 2 * DAY),
  ...overrides,
});

function makeService(
  opts: {
    isCloud?: boolean;
    licences?: OfferLicence[];
    firstSuccessAt?: Date | null;
    settings?: Array<{ organizationId: string; key: string; value: string }>;
  } = {},
) {
  const settings = [...(opts.settings ?? [])];
  const events: any[] = [];
  const firstAt = opts.firstSuccessAt === undefined ? new Date(NOW.getTime() - 60_000) : opts.firstSuccessAt;
  const prisma = {
    orgSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { organizationId, key } = where.organizationId_key;
        return settings.find((s) => s.organizationId === organizationId && s.key === key) ?? null;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          if (settings.some((s) => s.organizationId === row.organizationId && s.key === row.key)) continue;
          settings.push(row);
          count++;
        }
        return { count };
      }),
    },
    toolInvocation: {
      findFirst: jest.fn(async () =>
        firstAt ? { createdAt: firstAt, connectorId: 'con-1', toolId: 'tool-1' } : null,
      ),
    },
    license: { findMany: jest.fn(async () => opts.licences ?? [trial()]) },
    connector: { findFirst: jest.fn(async () => ({ config: { adapterSlug: 'shopify' } })) },
    mcpTool: { findUnique: jest.fn(async () => ({ name: 'shopify_list_orders' })) },
    productEvent: { create: jest.fn(async ({ data }: any) => events.push(data)) },
  };
  const deployment = { isCloud: () => opts.isCloud ?? true };
  const svc = new FirstSuccessService(prisma as any, deployment as any, new ProductEventService(prisma as any));
  return { svc, prisma, settings, events };
}

describe('offerLicenceState: who is on the no-card trial', () => {
  it('is eligible on a running free trial', () => {
    expect(offerLicenceState([trial()], NOW)).toBe('eligible');
  });

  it('is not eligible once the workspace is or was a customer, in any state', () => {
    // A card trial is a paid-plan licence while Stripe says trialing.
    for (const status of ['active', 'revoked', 'expired']) {
      expect(offerLicenceState([trial(), trial({ plan: 'starter', status, expiresAt: null })], NOW)).toBe('customer');
    }
    expect(offerLicenceState([trial({ plan: 'team', expiresAt: new Date(NOW.getTime() + 30 * DAY) })], NOW)).toBe(
      'customer',
    );
  });

  it('is not eligible once the trial has ended, whatever its status says', () => {
    expect(offerLicenceState([trial({ expiresAt: new Date(NOW.getTime() - 1) })], NOW)).toBe('trial_ended');
    expect(offerLicenceState([trial({ status: 'expired' })], NOW)).toBe('trial_ended');
    expect(offerLicenceState([trial({ status: 'revoked' })], NOW)).toBe('trial_ended');
    expect(offerLicenceState([trial({ expiresAt: null })], NOW)).toBe('trial_ended');
  });

  it('reads the newest active licence, like the licence guard', () => {
    const old = trial({ createdAt: new Date(NOW.getTime() - 9 * DAY), expiresAt: new Date(NOW.getTime() - 2 * DAY) });
    expect(offerLicenceState([old, trial()], NOW)).toBe('eligible');
  });

  it('has nothing to offer without a licence', () => {
    expect(offerLicenceState([], NOW)).toBe('no_trial');
  });
});

describe('FirstSuccessService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => jest.useRealTimers());

  it('does nothing on a self-hosted instance', () => {
    const { svc, prisma } = makeService({ isCloud: false });
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(prisma.orgSettings.findUnique).not.toHaveBeenCalled();
  });

  it('does nothing without a workspace', () => {
    const { svc, prisma } = makeService();
    expect(svc.onSuccessfulInvocation(null)).toBeUndefined();
    expect(prisma.orgSettings.findUnique).not.toHaveBeenCalled();
  });

  it('stores the first success and marks a no-card trial eligible, with the call that did it', async () => {
    const { svc, settings, events } = makeService();
    await svc.onSuccessfulInvocation('org-1', { connectorId: 'con-1', toolId: 'tool-1' });

    expect(settings.find((s) => s.key === FIRST_SUCCESS_KEY)?.value).toBe(new Date(NOW.getTime() - 60_000).toISOString());
    expect(settings.find((s) => s.key === OFFER_ELIGIBLE_KEY)?.value).toBe(NOW.toISOString());
    expect(events).toEqual([
      {
        event: 'card_trial_offer_eligible',
        userId: null,
        organizationId: 'org-1',
        metadata: { connectorId: 'con-1', adapterSlug: 'shopify', toolName: 'shopify_list_orders' },
      },
    ]);
  });

  it('checks a workspace once per process: later calls cost nothing', async () => {
    const { svc, prisma, events } = makeService();
    await svc.onSuccessfulInvocation('org-1');
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(prisma.orgSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('stops at one indexed read when the first success is already stored (another process, a restart)', async () => {
    const { svc, prisma, events } = makeService({
      settings: [{ organizationId: 'org-1', key: FIRST_SUCCESS_KEY, value: '2026-10-12T09:00:00.000Z' }],
    });
    await svc.onSuccessfulInvocation('org-1');
    expect(prisma.toolInvocation.findFirst).not.toHaveBeenCalled();
    expect(prisma.license.findMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('records the eligible event once even when two processes race', async () => {
    const { svc, prisma, events } = makeService();
    // The other process created the eligibility row between our two writes.
    prisma.orgSettings.createMany
      .mockImplementationOnce(async () => ({ count: 1 }))
      .mockImplementationOnce(async () => ({ count: 0 }));
    await svc.onSuccessfulInvocation('org-1');
    expect(events).toHaveLength(0);
  });

  it.each([
    ['paying', [trial(), trial({ plan: 'starter', expiresAt: null })]],
    ['on a card trial', [trial({ plan: 'team', expiresAt: new Date(NOW.getTime() + 5 * DAY) })]],
    ['a former customer', [trial(), trial({ plan: 'starter', status: 'revoked', expiresAt: null })]],
    ['past the trial', [trial({ expiresAt: new Date(NOW.getTime() - 60_000) })]],
    ['without a licence', []],
  ])('stores the first success but makes a workspace %s not eligible', async (_label, licences) => {
    const { svc, settings, events } = makeService({ licences: licences as OfferLicence[] });
    await svc.onSuccessfulInvocation('org-1');
    expect(settings.map((s) => s.key)).toEqual([FIRST_SUCCESS_KEY]);
    expect(events).toHaveLength(0);
  });

  it('does not make a workspace eligible whose first success is more than a day old', async () => {
    const old = new Date(NOW.getTime() - 3 * DAY);
    const { svc, prisma, settings, events } = makeService({ firstSuccessAt: old });
    await svc.onSuccessfulInvocation('org-1');
    // Its real first success is stored, for the funnel; no offer.
    expect(settings).toEqual([{ organizationId: 'org-1', key: FIRST_SUCCESS_KEY, value: old.toISOString() }]);
    expect(prisma.license.findMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('never rejects, and tries again on the next call after a failure', async () => {
    const { svc, prisma, events } = makeService();
    prisma.orgSettings.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.onSuccessfulInvocation('org-1')).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    await svc.onSuccessfulInvocation('org-1');
    expect(events).toHaveLength(1);
  });
});

describe('AuditService → first success', () => {
  it('hands every stored success to the first-success check, never a failure', async () => {
    const prisma = {
      toolInvocation: { create: jest.fn(async () => ({ id: 'inv-1' })) },
      user: { findUnique: jest.fn(async () => null), updateMany: jest.fn() },
    };
    const firstSuccess = { onSuccessfulInvocation: jest.fn() };
    const audit = new AuditService(prisma as any, undefined, undefined, firstSuccess as any);
    try {
      await audit.logInvocation({
        toolId: 'tool-1',
        organizationId: 'org-1',
        connectorId: 'con-1',
        input: {},
        status: 'SUCCESS',
      });
      await audit.logInvocation({
        toolId: 'tool-1',
        organizationId: 'org-1',
        connectorId: 'con-1',
        input: {},
        status: 'ERROR',
        error: 'boom',
      });
      expect(firstSuccess.onSuccessfulInvocation).toHaveBeenCalledTimes(1);
      expect(firstSuccess.onSuccessfulInvocation).toHaveBeenCalledWith('org-1', {
        connectorId: 'con-1',
        toolId: 'tool-1',
      });
    } finally {
      await audit.onModuleDestroy();
    }
  });
});
