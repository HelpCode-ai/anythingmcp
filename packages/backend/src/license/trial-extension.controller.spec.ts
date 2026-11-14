import { NotFoundException } from '@nestjs/common';
import { TrialExtensionController } from './trial-extension.controller';
import { createTrialExtensionToken } from './trial-extension-token';

describe('TrialExtensionController', () => {
  const ENV = { ...process.env };
  const SECRET = 'jwt-secret';

  function make(opts: { cloud?: boolean; trial?: { licenseKey: string } | null; answer?: any } = {}) {
    const prisma = {
      license: {
        findFirst: jest.fn().mockResolvedValue(opts.trial === undefined ? { licenseKey: 'AMCP-TRIAL-KEY-0001' } : opts.trial),
      },
    };
    const licenseService = { verifyLicense: jest.fn().mockResolvedValue({ valid: true }) };
    const client = {
      extendTrial: jest
        .fn()
        .mockResolvedValue(opts.answer === undefined ? { ok: true, expiresAt: new Date('2026-11-12T10:00:00.000Z') } : opts.answer),
    };
    const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
    const securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TrialExtensionController(
      prisma as any,
      { isCloud: () => opts.cloud ?? true } as any,
      licenseService as any,
      client as any,
      productEvents as any,
      securityEvents as any,
    );
    return { controller, prisma, licenseService, client, productEvents, securityEvents };
  }

  function res() {
    const r: any = { headers: {} as Record<string, string> };
    r.status = jest.fn(() => r);
    r.setHeader = jest.fn((k: string, v: string) => (r.headers[k] = v));
    r.send = jest.fn(() => r);
    r.redirect = jest.fn((status: number, url: string) => {
      r.redirected = { status, url: new URL(url) };
      return r;
    });
    return r;
  }
  const req = { ip: '203.0.113.9', get: () => 'Mail client' } as any;
  const token = (org = 'org-1', ended = new Date(Date.now() - 24 * 60 * 60 * 1000)) =>
    createTrialExtensionToken(org, ended, SECRET)!;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    process.env.FRONTEND_URL = 'https://cloud.anythingmcp.com';
  });
  afterAll(() => {
    process.env = ENV;
  });

  it('shows a button on GET and extends nothing, so mail scanners cannot spend the extension', () => {
    const { controller, client } = make();
    const r = res();
    controller.confirm(token(), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.send.mock.calls[0][0]).toContain('<form method="POST" action="/api/license/extend?token=');
    expect(client.extendTrial).not.toHaveBeenCalled();
  });

  it('extends on POST: the site, then the licence re-verified, the audit log, the event, and the dashboard', async () => {
    const { controller, client, licenseService, securityEvents, productEvents, prisma } = make();
    const r = res();
    await controller.extend(token(), req, r);
    expect(prisma.license.findFirst.mock.calls[0][0].where).toEqual({ organizationId: 'org-1', plan: 'trial' });
    expect(client.extendTrial).toHaveBeenCalledWith('AMCP-TRIAL-KEY-0001');
    expect(licenseService.verifyLicense).toHaveBeenCalledWith('AMCP-TRIAL-KEY-0001', 'org-1');
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'TRIAL_EXTENDED', organizationId: 'org-1', actorType: 'ANONYMOUS' }),
    );
    expect(productEvents.log).toHaveBeenCalledWith({ event: 'trial_extended', organizationId: 'org-1', metadata: { via: 'email' } });
    expect(r.redirected.status).toBe(303);
    expect(r.redirected.url.origin).toBe('https://cloud.anythingmcp.com');
    expect(r.redirected.url.pathname).toBe('/');
    expect(Object.fromEntries(r.redirected.url.searchParams)).toEqual({
      trial_extended: 'ok',
      until: '2026-11-12T10:00:00.000Z',
    });
  });

  it.each(['not_found', 'not_trial', 'already_extended', 'too_late', 'revoked', 'invalid_key'])(
    'redirects with the site refusal %s, and logs no extension',
    async (reason) => {
      const { controller, securityEvents, productEvents, licenseService } = make({ answer: { ok: false, reason } });
      const r = res();
      await controller.extend(token(), req, r);
      expect(r.redirected.url.searchParams.get('trial_extended')).toBe(reason);
      expect(securityEvents.log).not.toHaveBeenCalled();
      expect(productEvents.log).not.toHaveBeenCalled();
      expect(licenseService.verifyLicense).not.toHaveBeenCalled();
    },
  );

  it('says unavailable when the site does not answer', async () => {
    const { controller } = make({ answer: null });
    const r = res();
    await controller.extend(token(), req, r);
    expect(r.redirected.url.searchParams.get('trial_extended')).toBe('unavailable');
  });

  it('says not_found for a workspace without a trial licence, without asking the site', async () => {
    const { controller, client } = make({ trial: null });
    const r = res();
    await controller.extend(token(), req, r);
    expect(r.redirected.url.searchParams.get('trial_extended')).toBe('not_found');
    expect(client.extendTrial).not.toHaveBeenCalled();
  });

  it('refuses a tampered or expired token, on GET and on POST, without asking the site', async () => {
    const expired = token('org-1', new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const [, expiry, signature] = token().split('.');
    for (const [bad, reason] of [
      [expired, 'expired'],
      [`org-2.${expiry}.${signature}`, 'invalid'],
      ['nonsense', 'invalid'],
    ] as const) {
      const { controller, client } = make();
      const get = res();
      controller.confirm(bad, get);
      expect(get.redirected.url.searchParams.get('trial_extended')).toBe(reason);
      const post = res();
      await controller.extend(bad, req, post);
      expect(post.redirected.url.searchParams.get('trial_extended')).toBe(reason);
      expect(client.extendTrial).not.toHaveBeenCalled();
    }
  });

  it('does not exist on self-hosted', async () => {
    const { controller } = make({ cloud: false });
    expect(() => controller.confirm(token(), res())).toThrow(NotFoundException);
    await expect(controller.extend(token(), req, res())).rejects.toBeInstanceOf(NotFoundException);
  });
});
