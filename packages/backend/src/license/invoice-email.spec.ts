import 'reflect-metadata';
import axios from 'axios';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { InvoiceEmailService, InvoiceEmailError, parseInvoiceEmailView } from './invoice-email.service';
import { InvoiceEmailDto, LicenseController } from './license.controller';
import { ROLES_KEY } from '../auth/roles.guard';
import { SecurityEvents } from '../audit/security-event.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const VIEW = {
  available: true,
  enabled: true,
  billingContact: 'billing@acme-gmbh.de',
  recipient: { kind: 'custom', address: 'accounting@acme-gmbh.de' },
  lastSent: { number: 'VCOAA7SE-1402', at: '2026-11-09T10:00:00.000Z', to: 'ac***@acme-gmbh.de' },
};

function makeService(opts: { cloud?: boolean; current?: any; failed?: any } = {}) {
  const licenses = {
    getCurrentLicense: jest.fn(async () => ('current' in opts ? opts.current : { licenseKey: 'AMCP-OWN-KEY', plan: 'starter' })),
    getPaymentFailedLicense: jest.fn(async () => opts.failed ?? null),
  };
  const prisma = {
    organization: { findUnique: jest.fn(async () => ({ name: 'Acme GmbH' })) },
    user: { findUnique: jest.fn(async () => ({ email: 'admin@acme-gmbh.de' })) },
  };
  const service = new InvoiceEmailService(licenses as any, prisma as any, { isCloud: () => opts.cloud ?? true } as any);
  return { service, licenses, prisma };
}

describe('InvoiceEmailService', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    post.mockReset();
    process.env.LICENSE_SERVICE_TOKEN = 'svc-token';
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("asks the site with the caller's own workspace and licence key, never anything from the request", async () => {
    post.mockResolvedValue({ data: VIEW });
    const { service, licenses } = makeService();
    await expect(service.get('org-own')).resolves.toEqual(VIEW);
    expect(licenses.getCurrentLicense).toHaveBeenCalledWith('org-own');
    const [url, body, config] = post.mock.calls[0];
    expect(url).toMatch(/\/api\/license\/invoice-email$/);
    expect(body).toEqual({ action: 'get', licenseKey: 'AMCP-OWN-KEY', organizationId: 'org-own' });
    expect(config.headers).toEqual({ 'x-amcp-service-token': 'svc-token' });
  });

  it('sends the change with the workspace name and the acting admin', async () => {
    post.mockResolvedValue({ data: VIEW });
    const { service } = makeService();
    await service.set('org-own', 'user-1', { enabled: true, to: 'accounting@acme-gmbh.de' });
    expect(post.mock.calls[0][1]).toEqual({
      action: 'set',
      licenseKey: 'AMCP-OWN-KEY',
      organizationId: 'org-own',
      enabled: true,
      to: 'accounting@acme-gmbh.de',
      workspaceName: 'Acme GmbH',
      actorEmail: 'admin@acme-gmbh.de',
    });
    post.mockClear();
    await service.set('org-own', 'user-1', { enabled: false });
    expect(post.mock.calls[0][1]).not.toHaveProperty('to');
    post.mockClear();
    await service.set('org-own', 'user-1', { enabled: true, to: '' });
    expect(post.mock.calls[0][1].to).toBeNull();
  });

  it('uses the subscription stopped on a failed payment when no paid licence is active', async () => {
    post.mockResolvedValue({ data: VIEW });
    const { service } = makeService({ current: { licenseKey: 'AMCP-TRIAL', plan: 'trial' }, failed: { licenseKey: 'AMCP-FAILED', plan: 'starter' } });
    await service.get('org-own');
    expect(post.mock.calls[0][1].licenseKey).toBe('AMCP-FAILED');
  });

  it('answers unavailable without a licence, and refuses a change', async () => {
    const { service } = makeService({ current: null });
    await expect(service.get('org-own')).resolves.toMatchObject({ available: false, enabled: false });
    await expect(service.set('org-own', 'u', { enabled: true })).rejects.toMatchObject({ status: 409 });
    expect(post).not.toHaveBeenCalled();
  });

  it("maps the site's refusals without passing its wording on", async () => {
    const cases: Array<[number, number]> = [
      [400, 400],
      [404, 404],
      [409, 409],
      [429, 429],
      [500, 502],
    ];
    for (const [site, ours] of cases) {
      post.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: site, data: { error: 'internal detail' } } }));
      const { service } = makeService();
      const err = await service.get('org-own').catch((e) => e);
      expect(err).toBeInstanceOf(InvoiceEmailError);
      expect(err.status).toBe(ours);
      expect(err.message).not.toContain('internal detail');
    }
  });

  it('never calls off Cloud or without a service token', async () => {
    await expect(makeService({ cloud: false }).service.get('org-own')).rejects.toMatchObject({ status: 502 });
    delete process.env.LICENSE_SERVICE_TOKEN;
    await expect(makeService().service.get('org-own')).rejects.toMatchObject({ status: 502 });
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps only the expected fields of the reply', () => {
    expect(parseInvoiceEmailView({ ...VIEW, extra: 'x', recipient: { kind: 'custom', address: 'a@b.de', secret: 1 } })).toEqual({
      ...VIEW,
      recipient: { kind: 'custom', address: 'a@b.de' },
    });
    expect(parseInvoiceEmailView({ enabled: true })).toBeNull();
    expect(parseInvoiceEmailView({ ...VIEW, lastSent: { number: 'X', at: 'never', to: 'a' } })?.lastSent).toBeNull();
  });
});

describe('InvoiceEmailDto', () => {
  const errors = (body: unknown) => validateSync(plainToInstance(InvoiceEmailDto, body), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts on/off with an address, null or empty for the billing contact', () => {
    expect(errors({ enabled: true })).toHaveLength(0);
    expect(errors({ enabled: true, to: 'accounting@acme-gmbh.de' })).toHaveLength(0);
    expect(errors({ enabled: true, to: null })).toHaveLength(0);
    expect(errors({ enabled: false, to: '' })).toHaveLength(0);
  });

  it('refuses a malformed address, a missing switch, and any workspace or licence field', () => {
    expect(errors({ enabled: true, to: 'not-an-email' }).length).toBeGreaterThan(0);
    expect(errors({ to: 'a@b.de' }).length).toBeGreaterThan(0);
    expect(errors({ enabled: true, organizationId: 'org-other' }).length).toBeGreaterThan(0);
    expect(errors({ enabled: true, licenseKey: 'AMCP-AAAA-BBBB-CCCC-DDDD' }).length).toBeGreaterThan(0);
  });
});

describe('LicenseController — invoices by email', () => {
  function make(opts: { cloud?: boolean; set?: jest.Mock; get?: jest.Mock } = {}) {
    const invoiceEmail = {
      get: opts.get ?? jest.fn(async () => VIEW),
      set: opts.set ?? jest.fn(async () => VIEW),
    };
    const securityEvents = { log: jest.fn(async () => undefined) };
    const controller = new LicenseController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isCloud: () => opts.cloud ?? true } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      invoiceEmail as any,
      securityEvents as any,
    );
    return { controller, invoiceEmail, securityEvents };
  }
  const req = { user: { sub: 'user-1', organizationId: 'org-own' }, ip: '1.2.3.4', headers: { 'user-agent': 'jest' } };

  it('is for workspace admins only', () => {
    for (const handler of ['getInvoiceEmail', 'setInvoiceEmail'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, LicenseController.prototype[handler])).toEqual(['ADMIN']);
    }
  });

  it('is 404 on self-hosted', async () => {
    const { controller, invoiceEmail } = make({ cloud: false });
    await expect(controller.getInvoiceEmail(req)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.setInvoiceEmail(req, { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(invoiceEmail.get).not.toHaveBeenCalled();
  });

  it("changes the caller's own workspace and records who did it, with the recipient's domain only", async () => {
    const { controller, invoiceEmail, securityEvents } = make();
    await expect(controller.setInvoiceEmail(req, { enabled: true, to: 'accounting@acme-gmbh.de' })).resolves.toEqual(VIEW);
    expect(invoiceEmail.set).toHaveBeenCalledWith('org-own', 'user-1', { enabled: true, to: 'accounting@acme-gmbh.de' });
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: SecurityEvents.INVOICE_EMAIL_CHANGED,
        organizationId: 'org-own',
        actorUserId: 'user-1',
        metadata: { enabled: true, recipientKind: 'custom', recipientDomain: 'acme-gmbh.de' },
      }),
    );
  });

  it('turns refusals into HTTP errors', async () => {
    const conflict = make({ set: jest.fn(async () => Promise.reject(new InvoiceEmailError(409, 'none'))) });
    await expect(conflict.controller.setInvoiceEmail(req, { enabled: true })).rejects.toBeInstanceOf(ConflictException);
    expect(conflict.securityEvents.log).not.toHaveBeenCalled();
    const down = make({ get: jest.fn(async () => Promise.reject(new InvoiceEmailError(502, 'down'))) });
    await expect(down.controller.getInvoiceEmail(req)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
