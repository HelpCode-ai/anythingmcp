/**
 * A Cloud workspace that signed up through a Google Ads click, with ad
 * consent, and then made its first successful tool call is reported to the
 * licence site once, so the site can upload an activation conversion.
 */
import axios from 'axios';
import { AdsActivationService } from './ads-activation.service';
import { AuditService } from './audit.service';
import { ProductEventService } from './product-event.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const FIRST_SUCCESS = new Date('2026-10-08T09:15:00.000Z');

const attribution = (touch: Record<string, unknown>) => ({
  first_touch: { utm_source: 'google', utm_medium: 'cpc', channel: 'google_ads' },
  last_touch: touch,
  first_channel: 'google_ads',
  last_channel: 'google_ads',
});

function makeService(
  opts: {
    isCloud?: boolean;
    signups?: Array<{ metadata: unknown; userId: string | null }>;
    reported?: boolean;
  } = {},
) {
  const signups = opts.signups ?? [
    { metadata: attribution({ gclid: 'Cj0KCQ-test', ad_consent: 'granted', paid: true }), userId: 'user-1' },
  ];
  const prisma = {
    productEvent: {
      findFirst: jest.fn(async () => (opts.reported ? { id: 'pe-1' } : null)),
      findMany: jest.fn(async () => signups),
      create: jest.fn(async () => ({})),
    },
    toolInvocation: {
      findFirst: jest.fn(async () => ({ createdAt: FIRST_SUCCESS })),
    },
    user: {
      findUnique: jest.fn(async () => ({ email: 'founder@example.com' })),
    },
  };
  const deployment = { isCloud: () => opts.isCloud ?? true, isSelfHosted: () => !(opts.isCloud ?? true) };
  const events = new ProductEventService(prisma as any);
  const svc = new AdsActivationService(prisma as any, deployment as any, events);
  const storedEvents = () => prisma.productEvent.create.mock.calls.map((c: any[]) => c[0].data);
  return { svc, prisma, storedEvents };
}

function httpError(status?: number) {
  return { response: status === undefined ? undefined : { status, data: {} }, message: `HTTP ${status}` };
}

describe('AdsActivationService', () => {
  const originalToken = process.env.LICENSE_SERVICE_TOKEN;
  const originalBase = process.env.ADS_ACTIVATION_RETRY_BASE_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.post.mockReset();
    process.env.LICENSE_SERVICE_TOKEN = 'service-token-for-tests-0123456789';
    process.env.ADS_ACTIVATION_RETRY_BASE_MS = '1';
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LICENSE_SERVICE_TOKEN;
    else process.env.LICENSE_SERVICE_TOKEN = originalToken;
    if (originalBase === undefined) delete process.env.ADS_ACTIVATION_RETRY_BASE_MS;
    else process.env.ADS_ACTIVATION_RETRY_BASE_MS = originalBase;
  });

  it('does nothing on a self-hosted instance', async () => {
    const { svc, prisma } = makeService({ isCloud: false });
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(prisma.productEvent.findFirst).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does nothing without LICENSE_SERVICE_TOKEN', async () => {
    delete process.env.LICENSE_SERVICE_TOKEN;
    const { svc, prisma } = makeService();
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(svc.onSuccessfulInvocation('org-2')).toBeUndefined();
    expect(prisma.productEvent.findFirst).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does nothing for a call without a workspace', async () => {
    const { svc, prisma } = makeService();
    expect(svc.onSuccessfulInvocation(undefined)).toBeUndefined();
    expect(prisma.productEvent.findFirst).not.toHaveBeenCalled();
  });

  it('sends nothing for a sign-up without attribution, and checks the workspace once', async () => {
    const { svc, prisma, storedEvents } = makeService({ signups: [] });
    await svc.onSuccessfulInvocation('org-1');
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
    expect(prisma.productEvent.findMany).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(storedEvents()).toEqual([]);
  });

  it('sends nothing when the click id was not stored with ad consent', async () => {
    const { svc } = makeService({
      signups: [{ metadata: attribution({ gclid: 'Cj0KCQ-test', ad_consent: 'denied', paid: true }), userId: 'user-1' }],
    });
    await svc.onSuccessfulInvocation('org-1');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('reports an eligible workspace once, with its earliest success and the sign-up email', async () => {
    mockedAxios.post.mockResolvedValue({ status: 202, data: { queued: true } });
    const { svc, prisma, storedEvents } = makeService();

    await svc.onSuccessfulInvocation('org-1');
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedAxios.post.mock.calls[0] as any[];
    expect(url).toMatch(/\/api\/ads\/activation$/);
    expect(body).toEqual({
      organizationId: 'org-1',
      activatedAt: FIRST_SUCCESS.toISOString(),
      gclid: 'Cj0KCQ-test',
      adConsent: 'granted',
      email: 'founder@example.com',
    });
    expect(config.headers['x-amcp-service-token']).toBe(process.env.LICENSE_SERVICE_TOKEN);
    // The attribution is the workspace's, the earliest SUCCESS is the workspace's.
    expect((prisma.productEvent.findMany.mock.calls[0] as any[])[0].where).toEqual({
      organizationId: 'org-1',
      event: 'signup_attributed',
    });
    expect((prisma.toolInvocation.findFirst.mock.calls[0] as any[])[0]).toEqual(
      expect.objectContaining({ where: { organizationId: 'org-1', status: 'SUCCESS' }, orderBy: { createdAt: 'asc' } }),
    );
    expect(storedEvents()).toEqual([
      { event: 'ads_activation_reported', organizationId: 'org-1', userId: 'user-1', metadata: { kind: 'gclid', status: 202 } },
    ]);
  });

  it('sends one click id only, the one Google prefers', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: {} });
    const { svc } = makeService({
      signups: [
        { metadata: attribution({ gbraid: 'gb-1', wbraid: 'wb-1', ad_consent: 'granted', paid: true }), userId: 'user-1' },
      ],
    });
    await svc.onSuccessfulInvocation('org-1');
    const body = (mockedAxios.post.mock.calls[0] as any[])[1];
    expect(body.gbraid).toBe('gb-1');
    expect(body).not.toHaveProperty('wbraid');
    expect(body).not.toHaveProperty('gclid');
  });

  it('leaves the email out when the signing-up account is gone', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: {} });
    const { svc, prisma } = makeService({
      signups: [{ metadata: attribution({ gclid: 'Cj0KCQ-test', ad_consent: 'granted' }), userId: null }],
    });
    await svc.onSuccessfulInvocation('org-1');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect((mockedAxios.post.mock.calls[0] as any[])[1]).not.toHaveProperty('email');
  });

  it('does nothing for a workspace already reported (e.g. before a restart)', async () => {
    const { svc, prisma } = makeService({ reported: true });
    await svc.onSuccessfulInvocation('org-1');
    expect(prisma.productEvent.findMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('retries a 503 and a network error, then records the report', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(undefined))
      .mockResolvedValueOnce({ status: 200, data: {} });
    const { svc, storedEvents } = makeService();

    await svc.onSuccessfulInvocation('org-1');

    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    expect(storedEvents()).toHaveLength(1);
  });

  it('records nothing when every attempt fails, so a later run tries again', async () => {
    mockedAxios.post.mockRejectedValue(httpError(401));
    const { svc, storedEvents } = makeService();

    await svc.onSuccessfulInvocation('org-1');

    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    expect(storedEvents()).toEqual([]);
    // Not hammered again by the next call in this process.
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
  });

  it('takes any other 4xx as a refusal for good: no retry, never sent again', async () => {
    mockedAxios.post.mockRejectedValue(httpError(422));
    const { svc, storedEvents } = makeService();

    await svc.onSuccessfulInvocation('org-1');

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(storedEvents()).toEqual([
      expect.objectContaining({ event: 'ads_activation_reported', metadata: { kind: 'gclid', status: 422 } }),
    ]);
    expect(svc.onSuccessfulInvocation('org-1')).toBeUndefined();
  });

  it('never rejects into the caller when the database fails', async () => {
    const { svc, prisma } = makeService();
    prisma.productEvent.findFirst.mockRejectedValueOnce(new Error('DB down'));
    await expect(svc.onSuccessfulInvocation('org-1')).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('AuditService → AdsActivationService', () => {
  function makeAudit() {
    const prisma = {
      toolInvocation: { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }), updateMany: jest.fn().mockResolvedValue({}) },
    };
    const ads = { onSuccessfulInvocation: jest.fn() };
    const audit = new AuditService(prisma as any, ads as any);
    return { audit, ads };
  }

  it('hands a stored success to the activation report, not a failure', async () => {
    const { audit, ads } = makeAudit();
    await audit.logInvocation({ toolId: 't', userId: 'user-1', organizationId: 'org-1', input: {}, status: 'SUCCESS' });
    await audit.logInvocation({ toolId: 't', userId: 'user-1', organizationId: 'org-1', input: {}, status: 'ERROR', error: 'x' });
    expect(ads.onSuccessfulInvocation).toHaveBeenCalledTimes(1);
    expect(ads.onSuccessfulInvocation).toHaveBeenCalledWith('org-1');
    await audit.onModuleDestroy();
  });

  it('keeps logging when the hook throws', async () => {
    const { audit, ads } = makeAudit();
    ads.onSuccessfulInvocation.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      audit.logInvocation({ toolId: 't', organizationId: 'org-1', input: {}, status: 'SUCCESS' }),
    ).resolves.toBeUndefined();
    await audit.onModuleDestroy();
  });
});
