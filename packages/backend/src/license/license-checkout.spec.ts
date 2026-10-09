/**
 * The card-trial checkout link (Cloud only).
 *
 * A trial user is offered Stripe Checkout with a trial that ends when their
 * free trial would have. The licence site builds the checkout; this server
 * vouches for who is buying. These tests pin what must never drift: the
 * email and workspace come from the session, the trial end is the free
 * trial's own, self-hosted never sees the route, only admins can open it, a
 * paying workspace is not sold a second subscription, and upstream failures
 * reach the browser as one clean 502.
 */
import axios from 'axios';
import {
  BadGatewayException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';
import {
  CHECKOUT_PLANS,
  CheckoutUnavailableError,
  cardTrialEnd,
  checkoutAdMetadata,
  cloudFrontendOrigin,
} from './license-checkout';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const NOW = new Date('2026-10-01T10:00:00.000Z');
const IN_FIVE_DAYS = new Date('2026-10-06T10:00:00.000Z');

function trialLicense(overrides: Record<string, any> = {}) {
  return {
    licenseKey: 'AMCP-TRIA-L000-0000-0001',
    plan: 'trial',
    status: 'active',
    features: null,
    expiresAt: IN_FIVE_DAYS,
    lastVerifiedAt: null,
    instanceId: 'instance-1',
    ...overrides,
  };
}

describe('cardTrialEnd', () => {
  it('ends the card trial exactly when the free trial ends', () => {
    expect(cardTrialEnd(trialLicense(), NOW)?.toISOString()).toBe(IN_FIVE_DAYS.toISOString());
  });

  it('answers null (pay now) once the free trial is over', () => {
    expect(cardTrialEnd(trialLicense({ expiresAt: new Date(NOW.getTime() - 1000) }), NOW)).toBeNull();
    expect(cardTrialEnd(trialLicense({ expiresAt: NOW }), NOW)).toBeNull();
  });

  it('answers null (pay now) with under 48 hours of the free trial left, rather than lengthening it', () => {
    expect(cardTrialEnd(trialLicense({ expiresAt: new Date(NOW.getTime() + 47 * 3_600_000) }), NOW)).toBeNull();
    expect(cardTrialEnd(trialLicense({ expiresAt: new Date(NOW.getTime() + 49 * 3_600_000) }), NOW)).not.toBeNull();
  });

  it('answers null for anything that is not a live trial', () => {
    expect(cardTrialEnd(null, NOW)).toBeNull();
    expect(cardTrialEnd(trialLicense({ plan: 'cloud_team' }) as any, NOW)).toBeNull();
    expect(cardTrialEnd(trialLicense({ status: 'expired' }) as any, NOW)).toBeNull();
    expect(cardTrialEnd(trialLicense({ expiresAt: null }) as any, NOW)).toBeNull();
  });
});

describe('checkoutAdMetadata', () => {
  it('passes a consented click id and nothing else', () => {
    expect(
      checkoutAdMetadata({ gclid: 'abc', ad_consent: 'granted', captured_at: '2026-09-01T00:00:00Z' }),
    ).toEqual({ ad_consent: 'granted', gclid: 'abc' });
  });

  it('sends nothing without consent or without an id', () => {
    expect(checkoutAdMetadata(null)).toBeUndefined();
    expect(checkoutAdMetadata({ gclid: 'abc', ad_consent: 'denied' } as any)).toBeUndefined();
    expect(checkoutAdMetadata({ ad_consent: 'granted' })).toBeUndefined();
  });
});

describe('cloudFrontendOrigin', () => {
  it('uses FRONTEND_URL without a trailing slash', () => {
    expect(cloudFrontendOrigin({ FRONTEND_URL: 'https://cloud.example.com/' } as any)).toBe(
      'https://cloud.example.com',
    );
  });

  it('falls back to the public cloud URL', () => {
    expect(cloudFrontendOrigin({} as any)).toBe('https://cloud.anythingmcp.com');
  });
});

describe('LicenseService.createCheckoutIntent', () => {
  const originalToken = process.env.LICENSE_SERVICE_TOKEN;
  const payload = {
    email: 'admin@example.com',
    plan: 'cloud_team' as const,
    billingPeriod: 'monthly' as const,
    returnUrl: 'https://cloud.example.com/settings/license/activate',
    organizationId: 'org-1',
  };

  function makeService() {
    const siteSettings = { get: jest.fn(async () => null), set: jest.fn() };
    const deployment = { isCloud: () => true, isSelfHosted: () => false };
    return new LicenseService({} as any, siteSettings as any, deployment as any);
  }

  function httpError(status?: number, data?: any) {
    return {
      response: status === undefined ? undefined : { status, data },
      message: `HTTP ${status}`,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRIAL_RETRY_BASE_MS = '1';
    process.env.LICENSE_SERVICE_TOKEN = 'service-token';
  });

  afterAll(() => {
    delete process.env.TRIAL_RETRY_BASE_MS;
    if (originalToken === undefined) delete process.env.LICENSE_SERVICE_TOKEN;
    else process.env.LICENSE_SERVICE_TOKEN = originalToken;
  });

  it('posts the contract with the service token and a timeout, and returns the URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { url: 'https://anythingmcp.com/api/stripe/checkout/start?intent=i1', expiresAt: 'x' },
    } as any);

    await expect(makeService().createCheckoutIntent(payload)).resolves.toEqual({
      url: 'https://anythingmcp.com/api/stripe/checkout/start?intent=i1',
    });
    const [url, body, config] = mockedAxios.post.mock.calls[0] as any[];
    expect(url).toMatch(/\/api\/stripe\/checkout-intent$/);
    expect(body).toEqual(payload);
    expect(config.headers['x-amcp-service-token']).toBe('service-token');
    expect(config.timeout).toBeGreaterThan(0);
  });

  it('retries once on an upstream fault', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ data: { url: 'https://anythingmcp.com/c' } } as any);

    await expect(makeService().createCheckoutIntent(payload)).resolves.toEqual({
      url: 'https://anythingmcp.com/c',
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('does not retry a validation error and reports it as unavailable', async () => {
    mockedAxios.post.mockRejectedValue(httpError(400, { error: 'bad plan' }));

    const err = await makeService()
      .createCheckoutIntent(payload)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutUnavailableError);
    expect(err.upstreamStatus).toBe(400);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer without a URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } } as any);
    await expect(makeService().createCheckoutIntent(payload)).rejects.toBeInstanceOf(
      CheckoutUnavailableError,
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('does not call the licence site at all without a service token', async () => {
    delete process.env.LICENSE_SERVICE_TOKEN;
    await expect(makeService().createCheckoutIntent(payload)).rejects.toBeInstanceOf(
      CheckoutUnavailableError,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('LicenseController.checkoutLink', () => {
  const originalFrontend = process.env.FRONTEND_URL;
  const adminReq = {
    user: { sub: 'u1', email: 'admin@example.com', role: 'ADMIN', organizationId: 'org-1' },
  };

  function makeController(opts: { isCloud?: boolean; license?: any; click?: any; fail?: boolean } = {}) {
    const licenseService = {
      getCurrentLicense: jest.fn(async () => (opts.license === undefined ? trialLicense() : opts.license)),
      createCheckoutIntent: jest.fn(async () => {
        if (opts.fail) throw new CheckoutUnavailableError('Checkout intent failed: HTTP 500', 500);
        return { url: 'https://anythingmcp.com/api/stripe/checkout/start?intent=i1' };
      }),
    };
    const productEvents = { clickIdForUser: jest.fn(async () => opts.click ?? null) };
    const controller = new LicenseController(
      licenseService as any,
      {} as any,
      {} as any,
      {} as any,
      { isCloud: () => opts.isCloud ?? true } as any,
      productEvents as any,
    );
    return { controller, licenseService, productEvents };
  }

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://cloud.example.com';
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (originalFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontend;
  });

  it('builds the checkout from the session, with the free trial end as trialEnd', async () => {
    const { controller, licenseService, productEvents } = makeController({
      click: { gclid: 'g-1', ad_consent: 'granted' },
    });

    const res = await controller.checkoutLink(adminReq, {
      plan: 'team',
      billingPeriod: 'yearly',
      trial: true,
    });

    expect(res).toEqual({ url: 'https://anythingmcp.com/api/stripe/checkout/start?intent=i1' });
    expect(licenseService.getCurrentLicense).toHaveBeenCalledWith('org-1');
    expect(productEvents.clickIdForUser).toHaveBeenCalledWith('u1');
    expect(licenseService.createCheckoutIntent).toHaveBeenCalledWith({
      email: 'admin@example.com',
      plan: 'cloud_team',
      billingPeriod: 'yearly',
      trialEnd: IN_FIVE_DAYS.toISOString(),
      returnUrl: 'https://cloud.example.com/settings/license/activate',
      organizationId: 'org-1',
      adMetadata: { ad_consent: 'granted', gclid: 'g-1' },
    });
  });

  it('ignores an email or workspace smuggled into the body', async () => {
    const { controller, licenseService } = makeController();

    await controller.checkoutLink(adminReq, {
      plan: 'starter',
      billingPeriod: 'monthly',
      trial: false,
      email: 'victim@example.com',
      organizationId: 'org-other',
    } as any);

    const [payload] = licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(payload.email).toBe('admin@example.com');
    expect(payload.organizationId).toBe('org-1');
    expect(licenseService.getCurrentLicense).toHaveBeenCalledWith('org-1');
  });

  it('passes a promotion code through, upper-cased, and omits it when absent', async () => {
    const { controller, licenseService } = makeController();
    await controller.checkoutLink(adminReq, {
      plan: 'team',
      billingPeriod: 'monthly',
      trial: true,
      promo: 'start30',
    });
    const [payload] = licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(payload.promoCode).toBe('START30');

    const plain = makeController();
    await plain.controller.checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: true });
    const [plainPayload] = plain.licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(plainPayload).not.toHaveProperty('promoCode');
  });

  it('no longer sells Business: beyond Team, Enterprise is quoted', () => {
    expect(CHECKOUT_PLANS).toEqual(['starter', 'team']);
  });

  it('asks to pay now when no trial is requested', async () => {
    const { controller, licenseService } = makeController();
    await controller.checkoutLink(adminReq, { plan: 'starter', billingPeriod: 'monthly', trial: false });
    const [payload] = licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(payload).not.toHaveProperty('trialEnd');
    expect(payload).not.toHaveProperty('adMetadata');
  });

  it('asks to pay now when the trial is requested after the free trial ended', async () => {
    const { controller, licenseService } = makeController({
      license: null, // getCurrentLicense returns active licences only; an ended trial is expired
    });
    await controller.checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: true });
    const [payload] = licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(payload).not.toHaveProperty('trialEnd');

    const late = makeController({
      license: trialLicense({ expiresAt: new Date(NOW.getTime() - 60_000) }),
    });
    await late.controller.checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: true });
    const [latePayload] = late.licenseService.createCheckoutIntent.mock.calls[0] as any[];
    expect(latePayload).not.toHaveProperty('trialEnd');
  });

  it('does not exist on a self-hosted install', async () => {
    const { controller, licenseService } = makeController({ isCloud: false });
    await expect(
      controller.checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(licenseService.getCurrentLicense).not.toHaveBeenCalled();
    expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();
  });

  it('refuses a non-admin, in the handler as well as in the guard', async () => {
    const { controller, licenseService } = makeController();
    const memberReq = { user: { ...adminReq.user, role: 'EDITOR' } };
    await expect(
      controller.checkoutLink(memberReq, { plan: 'team', billingPeriod: 'monthly', trial: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();

    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => LicenseController.prototype.checkoutLink,
      getClass: () => LicenseController,
      switchToHttp: () => ({ getRequest: () => memberReq }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('does not sell a second subscription to a paying workspace', async () => {
    const { controller, licenseService } = makeController({
      license: trialLicense({ plan: 'cloud_team', expiresAt: null }),
    });
    await expect(
      controller.checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();
  });

  it('lets a customer whose paid licence ended subscribe again', async () => {
    for (const status of ['revoked', 'expired']) {
      const { controller, licenseService } = makeController({
        license: trialLicense({ plan: 'starter', status, expiresAt: null }),
      });
      await expect(
        controller.checkoutLink(adminReq, { plan: 'starter', billingPeriod: 'monthly', trial: true }),
      ).resolves.toEqual({ url: expect.any(String) });
      // No live trial, so no trial end: a returning customer pays now.
      expect(licenseService.createCheckoutIntent).toHaveBeenCalledWith(
        expect.not.objectContaining({ trialEnd: expect.anything() }),
      );
    }
  });

  it('maps any licence-site failure to a generic 502', async () => {
    const { controller } = makeController({ fail: true });
    const err = await controller
      .checkoutLink(adminReq, { plan: 'team', billingPeriod: 'monthly', trial: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).not.toMatch(/HTTP 500/);
  });
});
