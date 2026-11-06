import { EmailVerificationService } from './email-verification.service';

function setup(opts: { cloud?: boolean; record?: unknown; license?: unknown } = {}) {
  const prisma = {
    emailVerificationToken: {
      findFirst: jest.fn().mockResolvedValue(opts.record ?? null),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(2),
    },
    license: { findFirst: jest.fn().mockResolvedValue(opts.license ?? null) },
  };
  const usersService = {
    update: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A', organizationId: 'org-1' }),
  };
  const emailService = { sendVerificationEmail: jest.fn().mockResolvedValue(true) };
  const config = {
    get: jest.fn((key: string) =>
      key === 'DEPLOYMENT_MODE' ? (opts.cloud ? 'cloud' : 'self-hosted') : key === 'FRONTEND_URL' ? 'https://app.test' : undefined,
    ),
  };
  const licenseService = { requestTrialLicense: jest.fn().mockResolvedValue(undefined) };
  const adsSignup = { onEmailVerified: jest.fn() };
  const service = new EmailVerificationService(
    prisma as any,
    usersService as any,
    emailService as any,
    config as any,
    licenseService as any,
    adsSignup as any,
  );
  return { service, prisma, usersService, emailService, licenseService, adsSignup };
}

describe('EmailVerificationService', () => {
  it('voids open codes, stores a new 6-digit code and emails it with the instance link', async () => {
    const { service, prisma, emailService } = setup();
    expect(await service.sendCode('u1', 'a@b.com')).toBe(true);

    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    const data = prisma.emailVerificationToken.create.mock.calls[0][0].data;
    expect(data.code).toMatch(/^\d{6}$/);
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(emailService.sendVerificationEmail).toHaveBeenCalledWith(
      'a@b.com',
      data.code,
      `https://app.test/verify-email?token=${data.token}`,
    );
  });

  it('verifies the address with the right code: spends it, then trial and ads report on Cloud', async () => {
    const { service, prisma, usersService, licenseService, adsSignup } = setup({
      cloud: true,
      record: { id: 't1' },
    });
    expect(await service.verifyCode('u1', '123456')).toBe(true);

    expect(prisma.emailVerificationToken.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', code: '123456', usedAt: null, expiresAt: { gt: expect.any(Date) } },
    });
    expect(prisma.emailVerificationToken.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { usedAt: expect.any(Date) },
    });
    expect(usersService.update).toHaveBeenCalledWith('u1', { emailVerified: true });
    expect(licenseService.requestTrialLicense).toHaveBeenCalledWith('a@b.com', 'A', 'org-1');
    expect(adsSignup.onEmailVerified).toHaveBeenCalledWith('u1');
  });

  it('refuses a wrong or expired code and changes nothing', async () => {
    const { service, prisma, usersService } = setup({ cloud: true });
    expect(await service.verifyCode('u1', '000000')).toBe(false);
    expect(prisma.emailVerificationToken.update).not.toHaveBeenCalled();
    expect(usersService.update).not.toHaveBeenCalled();
  });

  it('starts no second trial for a workspace that has a licence, and none on self-hosted', async () => {
    const withLicence = setup({ cloud: true, record: { id: 't1' }, license: { id: 'l1' } });
    await withLicence.service.verifyCode('u1', '123456');
    expect(withLicence.licenseService.requestTrialLicense).not.toHaveBeenCalled();

    const selfHosted = setup({ cloud: false, record: { id: 't1' } });
    await selfHosted.service.verifyCode('u1', '123456');
    expect(selfHosted.usersService.update).toHaveBeenCalledWith('u1', { emailVerified: true });
    expect(selfHosted.licenseService.requestTrialLicense).not.toHaveBeenCalled();
  });

  it('counts the codes sent in a window', async () => {
    const { service, prisma } = setup();
    expect(await service.codesSentWithin('u1', 60_000)).toBe(2);
    const where = prisma.emailVerificationToken.count.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThanOrEqual(60_000 - 50);
  });
});
