/**
 * A Cloud user who signed up through a ChatGPT Ads click (an oppref stored
 * with ad consent) and verified their address is reported to the licence site
 * once, so the site can send a verified sign-up to ChatGPT Ads.
 */
import axios from 'axios';
import { AdsSignupService } from './ads-signup.service';
import { ProductEventService } from './product-event.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const VERIFIED_AT = new Date('2026-10-15T09:15:00.000Z');

const attribution = (touch: Record<string, unknown>) => ({
  first_touch: touch,
  first_channel: 'chatgpt_ads',
});

function makeService(
  opts: {
    isCloud?: boolean;
    signups?: Array<{ metadata: unknown; userId: string | null }>;
    reported?: boolean;
  } = {},
) {
  const signups = opts.signups ?? [
    {
      metadata: attribution({ utm_source: 'chatgpt_ads', utm_medium: 'cpc', oppref: 'op-1', ad_consent: 'granted' }),
      userId: 'user-1',
    },
  ];
  const prisma = {
    productEvent: {
      findFirst: jest.fn(async () => (opts.reported ? { id: 'pe-1' } : null)),
      findMany: jest.fn(async () => signups),
      create: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () => ({ email: 'founder@example.com', organizationId: 'org-1' })),
    },
  };
  const deployment = { isCloud: () => opts.isCloud ?? true, isSelfHosted: () => !(opts.isCloud ?? true) };
  const events = new ProductEventService(prisma as any);
  const svc = new AdsSignupService(prisma as any, deployment as any, events);
  const storedEvents = () => prisma.productEvent.create.mock.calls.map((c: any[]) => c[0].data);
  return { svc, prisma, storedEvents };
}

function httpError(status?: number) {
  return { response: status === undefined ? undefined : { status, data: {} }, message: `HTTP ${status}` };
}

describe('AdsSignupService', () => {
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

  it('does nothing on a self-hosted instance', () => {
    const { svc, prisma } = makeService({ isCloud: false });
    expect(svc.onEmailVerified('user-1')).toBeUndefined();
    expect(prisma.productEvent.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing without LICENSE_SERVICE_TOKEN', () => {
    delete process.env.LICENSE_SERVICE_TOKEN;
    const { svc, prisma } = makeService();
    expect(svc.onEmailVerified('user-1')).toBeUndefined();
    expect(prisma.productEvent.findFirst).not.toHaveBeenCalled();
  });

  it('reports a verified ChatGPT Ads sign-up once, with the oppref and the address', async () => {
    mockedAxios.post.mockResolvedValue({ status: 202, data: { status: 'queued' } });
    const { svc, prisma, storedEvents } = makeService();

    await svc.onEmailVerified('user-1', VERIFIED_AT);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedAxios.post.mock.calls[0] as any[];
    expect(url).toMatch(/\/api\/ads\/signup$/);
    expect(body).toEqual({
      userId: 'user-1',
      organizationId: 'org-1',
      verifiedAt: VERIFIED_AT.toISOString(),
      oppref: 'op-1',
      adConsent: 'granted',
      email: 'founder@example.com',
    });
    expect(config.headers['x-amcp-service-token']).toBe(process.env.LICENSE_SERVICE_TOKEN);
    // The user's own sign-up only.
    expect((prisma.productEvent.findMany.mock.calls[0] as any[])[0].where).toEqual({
      userId: 'user-1',
      event: 'signup_attributed',
    });
    expect(storedEvents()).toEqual([
      { event: 'ads_signup_reported', userId: 'user-1', organizationId: 'org-1', metadata: { kind: 'oppref', status: 202 } },
    ]);
  });

  it('sends nothing for a Google Ads sign-up: Google learns it in the browser', async () => {
    const { svc, storedEvents } = makeService({
      signups: [{ metadata: attribution({ gclid: 'Cj0-test', ad_consent: 'granted' }), userId: 'user-1' }],
    });
    await svc.onEmailVerified('user-1');
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(storedEvents()).toEqual([]);
  });

  it('sends nothing for an oppref stored without ad consent', async () => {
    const { svc } = makeService({
      signups: [{ metadata: attribution({ utm_source: 'chatgpt_ads', oppref: 'op-1', ad_consent: 'denied' }), userId: 'user-1' }],
    });
    await svc.onEmailVerified('user-1');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does nothing for a user already reported', async () => {
    const { svc, prisma } = makeService({ reported: true });
    await svc.onEmailVerified('user-1');
    expect(prisma.productEvent.findMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('retries a 503, then records the report', async () => {
    mockedAxios.post.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ status: 202, data: {} });
    const { svc, storedEvents } = makeService();
    await svc.onEmailVerified('user-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(storedEvents()).toHaveLength(1);
  });

  it('records nothing when every attempt fails', async () => {
    mockedAxios.post.mockRejectedValue(httpError(undefined));
    const { svc, storedEvents } = makeService();
    await svc.onEmailVerified('user-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    expect(storedEvents()).toEqual([]);
  });

  it('never rejects into the caller when the database fails', async () => {
    const { svc, prisma } = makeService();
    prisma.productEvent.findFirst.mockRejectedValueOnce(new Error('DB down'));
    await expect(svc.onEmailVerified('user-1')).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
