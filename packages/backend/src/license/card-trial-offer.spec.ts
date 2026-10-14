/**
 * The card-trial offer after the first successful tool call (Cloud only):
 * who sees it in the app, and the one email, sent once, held back near other
 * emails, and only while the workspace is still on the no-card trial.
 */
import { CardTrialOfferService } from './card-trial-offer.service';
import { ProductEventService } from '../audit/product-event.service';
import {
  OFFER_ELIGIBLE_KEY,
  OFFER_EMAIL_KEY,
  cardTrialStillAvailable,
  firstSentence,
  pickNextSteps,
  type OfferLicence,
} from './card-trial-offer';

const NOW = new Date('2026-10-13T10:17:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const trial = (overrides: Partial<OfferLicence> = {}): OfferLicence => ({
  plan: 'trial',
  status: 'active',
  expiresAt: new Date(NOW.getTime() + 5 * DAY),
  createdAt: new Date(NOW.getTime() - 2 * DAY),
  ...overrides,
});

interface Admin {
  email: string;
  name: string | null;
  emailVerified?: boolean;
  emailMarketingOptOut?: boolean;
  onboardingLastReminderAt?: Date | null;
  activationReminderAt?: Date | null;
}

const TOOLS = [
  { name: 'shopify_list_orders', description: 'List the store’s recent orders, newest first. Supports filters.' },
  { name: 'shopify_get_product', description: 'Get one product with its variants and stock.' },
  { name: 'shopify_graphql_schema', description: 'Return the GraphQL schema of the Admin API.' },
  { name: 'shopify_create_discount', description: 'Create a discount code for a price rule.' },
  { name: 'shopify_search_customers', description: 'Search customers by name, email or tag.' },
];

function makeService(
  opts: {
    isCloud?: boolean;
    licences?: OfferLicence[];
    /** When the workspace became eligible; null = never. */
    eligibleAt?: Date | null;
    flags?: Array<{ key: string; updatedAt: Date }>;
    admins?: Admin[];
    connector?: { id: string; name: string; tools?: typeof TOOLS } | null;
    sendOk?: boolean;
    /** Addresses the licence site says had a subscription; null = no answer. */
    hadSubscription?: string[] | null;
  } = {},
) {
  const eligibleAt = opts.eligibleAt === undefined ? new Date(NOW.getTime() - 40 * MIN) : opts.eligibleAt;
  const settings: Array<{ organizationId: string; key: string; value: string; updatedAt: Date }> = [
    ...(eligibleAt ? [{ organizationId: 'org-1', key: OFFER_ELIGIBLE_KEY, value: eligibleAt.toISOString(), updatedAt: eligibleAt }] : []),
    ...(opts.flags ?? []).map((f) => ({ organizationId: 'org-1', key: f.key, value: f.updatedAt.toISOString(), updatedAt: f.updatedAt })),
  ];
  const events: any[] = eligibleAt
    ? [
        {
          event: 'card_trial_offer_eligible',
          organizationId: 'org-1',
          createdAt: eligibleAt,
          metadata: { connectorId: 'con-1', adapterSlug: 'shopify', toolName: 'shopify_list_orders' },
        },
      ]
    : [];
  const admins = (opts.admins ?? [{ email: 'ada@example.com', name: 'Ada' }]).map((a) => ({
    user: {
      emailVerified: true,
      emailMarketingOptOut: false,
      onboardingLastReminderAt: null,
      activationReminderAt: null,
      ...a,
    },
  }));
  const connector =
    opts.connector === undefined ? { id: 'con-1', name: 'My Shopify store', tools: TOOLS } : opts.connector;

  const inRange = (at: Date, r: any) => (!r?.gte || at >= r.gte) && (!r?.lte || at <= r.lte);
  const prisma = {
    orgSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { organizationId, key } = where.organizationId_key;
        return settings.find((s) => s.organizationId === organizationId && s.key === key) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        settings.filter((s) => s.organizationId === where.organizationId && where.key.in.includes(s.key)),
      ),
      upsert: jest.fn(async ({ create, update, where }: any) => {
        const { organizationId, key } = where.organizationId_key;
        const row = settings.find((s) => s.organizationId === organizationId && s.key === key);
        if (row) Object.assign(row, update, { updatedAt: NOW });
        else settings.push({ ...create, updatedAt: NOW });
      }),
    },
    license: { findMany: jest.fn(async () => opts.licences ?? [trial()]) },
    productEvent: {
      findMany: jest.fn(async ({ where }: any) =>
        events.filter((e) => e.event === where.event && inRange(e.createdAt, where.createdAt)),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        events.find((e) => e.event === where.event && e.organizationId === where.organizationId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => events.push({ ...data, createdAt: NOW })),
    },
    organizationMember: { findMany: jest.fn(async () => admins) },
    connector: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        if (!connector || where.id !== connector.id || where.organizationId !== 'org-1') return null;
        return select.tools ? connector : { id: connector.id, name: connector.name };
      }),
    },
  };
  const email = { sendCardTrialOfferEmail: jest.fn(async () => opts.sendOk ?? true) };
  const deployment = { isCloud: () => opts.isCloud ?? true };
  const had = (e: string) => (opts.hadSubscription ?? []).includes(e.trim().toLowerCase());
  const eligibility = {
    hadSubscription: jest.fn(async (e: string) => (opts.hadSubscription === null ? null : had(e))),
    hadSubscriptions: jest.fn(async (emails: string[]) =>
      opts.hadSubscription === null ? null : new Map(emails.map((e) => [e.trim().toLowerCase(), had(e)]))),
  };
  const svc = new CardTrialOfferService(
    prisma as any,
    deployment as any,
    email as any,
    new ProductEventService(prisma as any),
    eligibility as any,
  );
  const emailFlag = () => settings.find((s) => s.key === OFFER_EMAIL_KEY)?.value;
  const emailedEvents = () => events.filter((e) => e.event === 'card_trial_offer_emailed');
  return { svc, prisma, email, settings, emailFlag, emailedEvents };
}

describe('next steps for the email', () => {
  it('suggests reads first, skips the tool just used and the meta tools', () => {
    const steps = pickNextSteps(TOOLS, 'shopify_list_orders');
    expect(steps.map((s) => s.name)).toEqual([
      'shopify_get_product',
      'shopify_search_customers',
      'shopify_create_discount',
    ]);
    expect(steps[0].text).toBe('Get one product with its variants and stock.');
  });

  it('caps at three and drops duplicate or empty descriptions', () => {
    const tools = [
      { name: 'a_list_x', description: 'List all the invoices of the account.' },
      { name: 'b_list_x', description: 'List all the invoices of the account.' },
      { name: 'c_get_x', description: '' },
      { name: 'd_get_x', description: null },
    ];
    expect(pickNextSteps(tools).map((s) => s.name)).toEqual(['a_list_x']);
    expect(pickNextSteps([...TOOLS, ...TOOLS])).toHaveLength(3);
    expect(pickNextSteps([])).toEqual([]);
  });

  it('keeps the first sentence, in plain text, without long dashes, and capped', () => {
    expect(firstSentence('Use `search` to find **orders**. Then more.')).toBe('Use search to find orders.');
    expect(firstSentence('list orders — newest first')).toBe('List orders, newest first');
    const long = firstSentence(`Returns ${'very '.repeat(60)}long text.`)!;
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith('…')).toBe(true);
    expect(firstSentence('   ')).toBeNull();
  });

  it('a card trial needs 48 hours of the free trial left', () => {
    expect(cardTrialStillAvailable(new Date(NOW.getTime() + 49 * HOUR), NOW)).toBe(true);
    expect(cardTrialStillAvailable(new Date(NOW.getTime() + 47 * HOUR), NOW)).toBe(false);
    expect(cardTrialStillAvailable(null, NOW)).toBe(false);
  });
});

describe('CardTrialOfferService.currentOffer (in-app)', () => {
  it('shows an admin of an eligible workspace the connector and the trial end', async () => {
    const { svc } = makeService();
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.toEqual({
      connectorName: 'My Shopify store',
      trialEndsAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
  });

  it('shows nothing to members who cannot start a trial', async () => {
    const { svc, prisma } = makeService();
    for (const role of ['EDITOR', 'VIEWER', undefined]) {
      await expect(svc.currentOffer('org-1', role, 'ada@example.com', NOW)).resolves.toBeNull();
    }
    expect(prisma.orgSettings.findUnique).not.toHaveBeenCalled();
  });

  it('shows nothing on a self-hosted instance', async () => {
    const { svc, prisma } = makeService({ isCloud: false });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.toBeNull();
    expect(prisma.orgSettings.findUnique).not.toHaveBeenCalled();
  });

  it('shows nothing to a workspace that never became eligible', async () => {
    const { svc } = makeService({ eligibleAt: null });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.toBeNull();
  });

  it.each([
    ['started a card trial', [trial(), trial({ plan: 'starter', expiresAt: new Date(NOW.getTime() + 5 * DAY) })]],
    ['pays', [trial({ plan: 'team', expiresAt: null })]],
    ['is past its trial', [trial({ expiresAt: new Date(NOW.getTime() - MIN) })]],
    ['has under 48 hours of trial left', [trial({ expiresAt: new Date(NOW.getTime() + 30 * HOUR) })]],
  ])('hides the offer once the workspace %s', async (_label, licences) => {
    const { svc } = makeService({ licences: licences as OfferLicence[] });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.toBeNull();
  });

  it('is never offered to an admin whose address had a subscription: it would pay today', async () => {
    const { svc } = makeService({ hadSubscription: ['ada@example.com'] });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'Ada@Example.com', NOW)).resolves.toBeNull();
    // Another admin of the same workspace still gets it.
    await expect(svc.currentOffer('org-1', 'ADMIN', 'bob@example.com', NOW)).resolves.not.toBeNull();
  });

  it('still offers when the licence site cannot answer: /start-trial checks again', async () => {
    const { svc } = makeService({ hadSubscription: null });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.not.toBeNull();
  });

  it('still offers when the connector was deleted, without its name', async () => {
    const { svc } = makeService({ connector: null });
    await expect(svc.currentOffer('org-1', 'ADMIN', 'ada@example.com', NOW)).resolves.toMatchObject({ connectorName: null });
  });
});

describe('CardTrialOfferService.runEmailPass', () => {
  it('emails the admins about 30 minutes after, with the connector, next steps and the card-trial link', async () => {
    const { svc, email, emailFlag, emailedEvents } = makeService();
    const run = await svc.runEmailPass(NOW);

    expect(run).toEqual({ examined: 1, sent: 1, skipped: 0, postponed: 0, failed: 0 });
    expect(email.sendCardTrialOfferEmail).toHaveBeenCalledWith('ada@example.com', {
      name: 'Ada',
      connectorName: 'My Shopify store',
      nextSteps: [
        { name: 'shopify_get_product', text: 'Get one product with its variants and stock.' },
        { name: 'shopify_search_customers', text: 'Search customers by name, email or tag.' },
        { name: 'shopify_create_discount', text: 'Create a discount code for a price rule.' },
      ],
      trialEndsAt: new Date(NOW.getTime() + 5 * DAY),
      cardTrial: true,
      ctaPath: '/start-trial?source=first_success',
    });
    expect(emailFlag()).toBe(NOW.toISOString());
    expect(emailedEvents()).toEqual([
      expect.objectContaining({ organizationId: 'org-1', metadata: { connectorId: 'con-1', kind: 'trial' } }),
    ]);
  });

  it('never sends twice', async () => {
    const { svc, email } = makeService();
    await svc.runEmailPass(NOW);
    const again = await svc.runEmailPass(new Date(NOW.getTime() + HOUR));
    expect(email.sendCardTrialOfferEmail).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ examined: 0, sent: 0, skipped: 0, postponed: 0, failed: 0 });
  });

  it('waits 30 minutes after the first success, and gives up after 48 hours', async () => {
    const early = makeService({ eligibleAt: new Date(NOW.getTime() - 10 * MIN) });
    await early.svc.runEmailPass(NOW);
    expect(early.email.sendCardTrialOfferEmail).not.toHaveBeenCalled();

    const late = makeService({ eligibleAt: new Date(NOW.getTime() - 49 * HOUR) });
    await late.svc.runEmailPass(NOW);
    expect(late.email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['started a card trial', [trial(), trial({ plan: 'starter', expiresAt: new Date(NOW.getTime() + 5 * DAY) })], 'skipped:customer'],
    ['pays', [trial({ plan: 'team', expiresAt: null })], 'skipped:customer'],
    ['trial ended', [trial({ expiresAt: new Date(NOW.getTime() - MIN) })], 'skipped:trial_ended'],
  ])('sends nothing once the workspace %s, and settles it', async (_label, licences, flag) => {
    const { svc, email, emailFlag } = makeService({ licences: licences as OfferLicence[] });
    const run = await svc.runEmailPass(NOW);
    expect(email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
    expect(run.skipped).toBe(1);
    expect(emailFlag()).toBe(flag);
  });

  it('links to the plans when a card trial can no longer start', async () => {
    const { svc, email, emailedEvents } = makeService({
      licences: [trial({ expiresAt: new Date(NOW.getTime() + 20 * HOUR) })],
    });
    await svc.runEmailPass(NOW);
    expect(email.sendCardTrialOfferEmail).toHaveBeenCalledWith(
      'ada@example.com',
      expect.objectContaining({ cardTrial: false, ctaPath: '/settings/license?source=first_success' }),
    );
    expect(emailedEvents()[0].metadata.kind).toBe('plan');
  });

  it('holds back within 12 hours of a trial or win-back email, then sends', async () => {
    for (const key of ['trial_email_warn3', 'trial_email_warn1', 'trial_email_winback7']) {
      const held = makeService({ flags: [{ key, updatedAt: new Date(NOW.getTime() - 2 * HOUR) }] });
      const run = await held.svc.runEmailPass(NOW);
      expect(run.postponed).toBe(1);
      expect(held.email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
      expect(held.emailFlag()).toBeUndefined();

      // The flag stays where it is; 12 hours later the email goes.
      const later = await held.svc.runEmailPass(new Date(NOW.getTime() + 11 * HOUR));
      expect(later.sent).toBe(1);
    }
  });

  it('holds back within 12 hours of an onboarding or activation nudge to an admin', async () => {
    for (const nudge of ['onboardingLastReminderAt', 'activationReminderAt'] as const) {
      const held = makeService({
        admins: [{ email: 'ada@example.com', name: 'Ada', [nudge]: new Date(NOW.getTime() - HOUR) }],
      });
      expect((await held.svc.runEmailPass(NOW)).postponed).toBe(1);
      expect(held.email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
    }
    const old = makeService({
      admins: [{ email: 'ada@example.com', name: 'Ada', onboardingLastReminderAt: new Date(NOW.getTime() - 13 * HOUR) }],
    });
    expect((await old.svc.runEmailPass(NOW)).sent).toBe(1);
  });

  it('writes only to verified admins who did not unsubscribe', async () => {
    const { svc, email } = makeService({
      admins: [
        { email: 'ada@example.com', name: 'Ada' },
        { email: 'out@example.com', name: 'Out', emailMarketingOptOut: true },
        { email: 'new@example.com', name: null, emailVerified: false },
      ],
    });
    await svc.runEmailPass(NOW);
    expect(email.sendCardTrialOfferEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['ada@example.com']);
  });

  it('writes only to admins who can start a card trial', async () => {
    const { svc, email, emailFlag } = makeService({
      admins: [
        { email: 'ada@example.com', name: 'Ada' },
        { email: 'back@example.com', name: 'Back' },
      ],
      hadSubscription: ['back@example.com'],
    });
    expect((await svc.runEmailPass(NOW)).sent).toBe(1);
    expect(email.sendCardTrialOfferEmail.mock.calls.map((c: any[]) => c[0])).toEqual(['ada@example.com']);
    expect(emailFlag()).toBe(NOW.toISOString());

    const none = makeService({ hadSubscription: ['ada@example.com'] });
    expect((await none.svc.runEmailPass(NOW)).skipped).toBe(1);
    expect(none.email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
    expect(none.emailFlag()).toBe('skipped:no_trial_recipient');
  });

  it('waits for an answer about past subscriptions instead of guessing', async () => {
    const { svc, email, emailFlag } = makeService({ hadSubscription: null });
    expect((await svc.runEmailPass(NOW)).postponed).toBe(1);
    expect(email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
    expect(emailFlag()).toBeUndefined();
  });

  it('settles a workspace with nobody to write to', async () => {
    const { svc, email, emailFlag } = makeService({
      admins: [{ email: 'out@example.com', name: 'Out', emailMarketingOptOut: true }],
    });
    expect((await svc.runEmailPass(NOW)).skipped).toBe(1);
    expect(email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
    expect(emailFlag()).toBe('skipped:no_recipient');
  });

  it('retries a failed send on the next run instead of settling it', async () => {
    const { svc, email, emailFlag, emailedEvents } = makeService({ sendOk: false });
    expect((await svc.runEmailPass(NOW)).failed).toBe(1);
    expect(emailFlag()).toBeUndefined();
    expect(emailedEvents()).toHaveLength(0);
    email.sendCardTrialOfferEmail.mockResolvedValue(true);
    expect((await svc.runEmailPass(new Date(NOW.getTime() + HOUR))).sent).toBe(1);
  });

  it('still sends, without steps, when the connector is gone', async () => {
    const { svc, email } = makeService({ connector: null });
    await svc.runEmailPass(NOW);
    expect(email.sendCardTrialOfferEmail).toHaveBeenCalledWith(
      'ada@example.com',
      expect.objectContaining({ connectorName: null, nextSteps: [] }),
    );
  });

  it('does nothing on a self-hosted instance', async () => {
    const { svc, prisma, email } = makeService({ isCloud: false });
    expect(await svc.runEmailPass(NOW)).toEqual({ examined: 0, sent: 0, skipped: 0, postponed: 0, failed: 0 });
    expect(prisma.productEvent.findMany).not.toHaveBeenCalled();
    expect(email.sendCardTrialOfferEmail).not.toHaveBeenCalled();
  });

  it('never throws: one broken workspace is counted and the run goes on', async () => {
    const { svc, prisma } = makeService();
    prisma.license.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.runEmailPass(NOW)).resolves.toMatchObject({ examined: 1, failed: 1 });
  });
});
