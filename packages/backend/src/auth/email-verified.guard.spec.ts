import { ForbiddenException } from '@nestjs/common';
import { EmailVerifiedGuard } from './email-verified.guard';
import { McpEmailVerificationRequiredException } from './mcp-email-verification';

/**
 * Global guards run before the route's AuthGuard('jwt'), so req.user is unset
 * here. The guard used to return early on that and checked nothing.
 */
describe('EmailVerifiedGuard', () => {
  function makeGuard(opts: { cloud?: boolean; verified?: boolean }) {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({ emailVerified: opts.verified ?? false, email: 'jane.doe@example.com' })),
      },
    };
    const auth = {
      verifyToken: jest.fn((t: string) => {
        if (t === 'good') return { sub: 'u1' };
        throw new Error('invalid');
      }),
    };
    const guard = new EmailVerifiedGuard(
      { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? (opts.cloud === false ? 'self-hosted' : 'cloud') : undefined) } as any,
      prisma as any,
      auth as any,
    );
    return { guard, prisma };
  }
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

  it('refuses an unverified cloud user identified only by the bearer token', async () => {
    const { guard } = makeGuard({ verified: false });
    await expect(
      guard.canActivate(ctx({ path: '/api/mcp-servers', headers: { authorization: 'Bearer good' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('tells an AI client on /mcp what the person has to do', async () => {
    const { guard } = makeGuard({ verified: false });
    const refusal = guard.canActivate(ctx({ path: '/mcp/srv1', headers: { authorization: 'Bearer good' } }));
    await expect(refusal).rejects.toBeInstanceOf(McpEmailVerificationRequiredException);
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refusal).rejects.toThrow(/not been verified.*ja\*\*\*@example\.com.*Sign in at https:\/\/\S+\/login/);
    await expect(refusal).rejects.not.toThrow(/jane\.doe/);
  });

  it('keeps the plain refusal off /mcp', async () => {
    const { guard } = makeGuard({ verified: false });
    const refusal = guard.canActivate(ctx({ path: '/api/connectors', headers: { authorization: 'Bearer good' } }));
    await expect(refusal).rejects.not.toBeInstanceOf(McpEmailVerificationRequiredException);
    await expect(refusal).rejects.toThrow('Email verification required');
  });

  it('lets a verified user through', async () => {
    const { guard } = makeGuard({ verified: true });
    await expect(
      guard.canActivate(ctx({ path: '/api/mcp-servers', headers: { authorization: 'Bearer good' } })),
    ).resolves.toBe(true);
  });

  it('keeps the verification endpoints open to the unverified user', async () => {
    const { guard } = makeGuard({ verified: false });
    await expect(
      guard.canActivate(ctx({ path: '/api/auth/verify-email', headers: { authorization: 'Bearer good' } })),
    ).resolves.toBe(true);
  });

  it('leaves tokens it cannot read, and anonymous requests, to the route', async () => {
    const { guard, prisma } = makeGuard({ verified: false });
    await expect(guard.canActivate(ctx({ path: '/mcp/x', headers: { authorization: 'Bearer other' } }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ path: '/api/adapters', headers: {} }))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('leaves a token whose user no longer exists to the route (which answers 401), instead of a 403', async () => {
    const { guard, prisma } = makeGuard({ verified: false });
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      guard.canActivate(ctx({ path: '/mcp/srv', headers: { authorization: 'Bearer good' } })),
    ).resolves.toBe(true);
  });

  it('resolves a legacy token whose sub is an email through its OAuth profile', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ emailVerified: false })) },
      oAuthUserProfile: { findUnique: jest.fn(async () => ({ externalId: 'u-legacy' })) },
    };
    const guard = new EmailVerifiedGuard(
      { get: () => 'cloud' } as any,
      prisma as any,
      { verifyToken: () => ({ sub: 'someone@example.com', user_profile_id: 'p1' }) } as any,
    );
    await expect(
      guard.canActivate(ctx({ path: '/mcp/srv', headers: { authorization: 'Bearer legacy' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-legacy' } }));
  });

  it('does nothing on self-hosted', async () => {
    const { guard } = makeGuard({ cloud: false, verified: false });
    await expect(
      guard.canActivate(ctx({ path: '/api/mcp-servers', headers: { authorization: 'Bearer good' } })),
    ).resolves.toBe(true);
  });
});
