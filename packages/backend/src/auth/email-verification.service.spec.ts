import { Reflector } from '@nestjs/core';
import { EmailVerificationService, VERIFICATION_CODE_TTL_MS } from './email-verification.service';
import { MAX_WRONG_CODES, VerificationAttemptsStore } from './verification-attempts.store';
import { AuthController } from './auth.controller';

function setup(opts: { cloud?: boolean; record?: unknown; license?: unknown; redis?: unknown } = {}) {
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
  const licenseService = { requestTrialAtSignup: jest.fn().mockResolvedValue(undefined) };
  const adsSignup = { onEmailVerified: jest.fn() };
  const service = new EmailVerificationService(
    prisma as any,
    usersService as any,
    emailService as any,
    config as any,
    licenseService as any,
    adsSignup as any,
    opts.redis as any,
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
    expect(licenseService.requestTrialAtSignup).toHaveBeenCalledWith('a@b.com', 'A', 'org-1');
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
    expect(withLicence.licenseService.requestTrialAtSignup).not.toHaveBeenCalled();

    const selfHosted = setup({ cloud: false, record: { id: 't1' } });
    await selfHosted.service.verifyCode('u1', '123456');
    expect(selfHosted.usersService.update).toHaveBeenCalledWith('u1', { emailVerified: true });
    expect(selfHosted.licenseService.requestTrialAtSignup).not.toHaveBeenCalled();
  });

  it('counts the codes sent in a window', async () => {
    const { service, prisma } = setup();
    expect(await service.codesSentWithin('u1', 60_000)).toBe(2);
    const where = prisma.emailVerificationToken.count.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThanOrEqual(60_000 - 50);
  });

  describe('wrong codes', () => {
    // Every voiding updateMany call (sendCode also voids, before a new code).
    const voids = (prisma: any) =>
      prisma.emailVerificationToken.updateMany.mock.calls.filter((c: any[]) => c[0]?.where?.usedAt === null);

    it(`voids the open codes on the ${MAX_WRONG_CODES}th wrong code, not before`, async () => {
      const { service, prisma } = setup();
      for (let i = 1; i < MAX_WRONG_CODES; i++) {
        expect(await service.verifyCode('u1', '000000')).toBe(false);
      }
      expect(voids(prisma)).toHaveLength(0);
      expect(await service.verifyCode('u1', '000000')).toBe(false);
      expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('counts per account', async () => {
      const { service, prisma } = setup();
      for (let i = 1; i < MAX_WRONG_CODES; i++) await service.verifyCode('u1', '000000');
      await service.verifyCode('u2', '000000');
      expect(voids(prisma)).toHaveLength(0);
    });

    it('gives a new code the full number of tries', async () => {
      const { service, prisma } = setup();
      for (let i = 1; i < MAX_WRONG_CODES; i++) await service.verifyCode('u1', '000000');
      await service.sendCode('u1', 'a@b.com');
      prisma.emailVerificationToken.updateMany.mockClear();
      for (let i = 1; i < MAX_WRONG_CODES; i++) await service.verifyCode('u1', '000000');
      expect(voids(prisma)).toHaveLength(0);
    });

    it('starts again after the right code', async () => {
      const { service, prisma } = setup();
      for (let i = 1; i < MAX_WRONG_CODES; i++) await service.verifyCode('u1', '000000');
      prisma.emailVerificationToken.findFirst.mockResolvedValueOnce({ id: 't1' });
      expect(await service.verifyCode('u1', '123456')).toBe(true);
      for (let i = 1; i < MAX_WRONG_CODES; i++) await service.verifyCode('u1', '000000');
      expect(voids(prisma)).toHaveLength(0);
    });

    it('keeps the count in Redis when connected, expiring with the code', async () => {
      const store = new Map<string, number>();
      const redis = {
        isConnected: true,
        incr: jest.fn(async (k: string) => {
          store.set(k, (store.get(k) ?? 0) + 1);
          return store.get(k)!;
        }),
        expire: jest.fn(async () => undefined),
        del: jest.fn(async (k: string) => void store.delete(k)),
      };
      // Two processes sharing one Redis count together.
      const a = setup({ redis });
      const b = setup({ redis });
      for (let i = 1; i < MAX_WRONG_CODES; i++) await a.service.verifyCode('u1', '000000');
      expect(redis.expire).toHaveBeenCalledWith('email-verify:wrong:u1', VERIFICATION_CODE_TTL_MS / 1000);
      await b.service.verifyCode('u1', '000000');
      expect(voids(b.prisma)).toHaveLength(1);
      expect(redis.del).toHaveBeenCalledWith('email-verify:wrong:u1');
    });
  });

  describe('VerificationAttemptsStore without Redis', () => {
    it('forgets the count once the code would have expired', async () => {
      const store = new VerificationAttemptsStore(1000);
      expect(await store.recordWrong('u1', 0)).toBe(1);
      expect(await store.recordWrong('u1', 500)).toBe(2);
      expect(await store.recordWrong('u1', 1500)).toBe(1);
    });

    it('stays under its size cap', async () => {
      const store = new VerificationAttemptsStore(60_000);
      const cap = VerificationAttemptsStore.MAX_MEMORY_ENTRIES;
      for (let i = 0; i < cap + 50; i++) await store.recordWrong(`u${i}`, 0);
      expect((store as unknown as { memory: Map<string, unknown> }).memory.size).toBeLessThanOrEqual(cap);
    });
  });
});

describe('POST /api/auth/verify-email throttle', () => {
  it('has the same 10 a minute as the authorization page code form', () => {
    const handler = AuthController.prototype.verifyEmail;
    const reflector = new Reflector();
    expect(reflector.get('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(reflector.get('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
