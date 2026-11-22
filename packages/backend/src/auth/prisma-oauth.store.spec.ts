import { PrismaOAuthStore } from './prisma-oauth.store';
import { authorizationAttemptContext, type AuthorizationAttemptContext } from './authorization-attempt';

/**
 * The two events that say whether an authorization was handed back to the AI
 * client: `authorization_code_issued` when the code is stored, and
 * `authorization_code_exchanged` when the client presents it.
 */
describe('PrismaOAuthStore: authorization code events', () => {
  const CODE = {
    code: 'abc',
    user_id: 'u1',
    client_id: 'client-1',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'x',
    code_challenge_method: 'S256',
    expires_at: Date.now() + 60_000,
  };
  const ROW = {
    code: 'abc',
    userId: 'u1',
    clientId: 'client-1',
    redirectUri: CODE.redirect_uri,
    codeChallenge: 'x',
    codeChallengeMethod: 'S256',
    resource: null,
    scope: null,
    expiresAt: BigInt(CODE.expires_at),
    userProfileId: null,
  };

  const build = () => {
    const prisma = {
      oAuthAuthorizationCode: {
        create: jest.fn().mockResolvedValue(ROW),
        findUnique: jest.fn().mockResolvedValue(ROW),
        delete: jest.fn().mockResolvedValue(ROW),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', organizationId: 'org-1' }) },
      oAuthClient: { findUnique: jest.fn().mockResolvedValue({ clientName: 'Claude' }) },
      productEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    return { prisma, store: new PrismaOAuthStore(prisma as any) };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('records the code being issued, with the workspace and the client name', async () => {
    const { prisma, store } = build();
    await store.storeAuthCode(CODE as any);
    await flush();
    expect(prisma.productEvent.create).toHaveBeenCalledWith({
      data: { event: 'authorization_code_issued', userId: 'u1', organizationId: 'org-1', metadata: { client: 'Claude' } },
    });
  });

  // What /callback knows about the attempt reaches the event through the
  // AsyncLocalStorage of AuthorizationAttemptMiddleware, and through the event
  // store's allow-list.
  describe('with the attempt of the callback', () => {
    const inCallback = (context: Partial<AuthorizationAttemptContext>, run: () => Promise<unknown>) =>
      authorizationAttemptContext.run(
        { device: 'desktop', attempt: Promise.resolve('mws7ha5r'), ...context } as AuthorizationAttemptContext,
        run,
      );

    it('says on which device, in which attempt and in which page arm the code was issued', async () => {
      const { prisma, store } = build();
      await inCallback({ device: 'mobile', connectedArm: 'next_step' }, () => store.storeAuthCode(CODE as any));
      await flush();
      expect(prisma.productEvent.create).toHaveBeenCalledWith({
        data: {
          event: 'authorization_code_issued',
          userId: 'u1',
          organizationId: 'org-1',
          metadata: { client: 'Claude', device: 'mobile', attempt: 'mws7ha5r', connectedArm: 'next_step' },
        },
      });
    });

    it('keeps only values the event store allows', async () => {
      const { prisma, store } = build();
      await inCallback(
        { device: 'tablet' as any, attempt: Promise.resolve('NOT A KEY'), connectedArm: 'made-up' as any },
        () => store.storeAuthCode(CODE as any),
      );
      await flush();
      expect(prisma.productEvent.create.mock.calls[0][0].data.metadata).toEqual({ client: 'Claude' });
    });

    it('records the code without an attempt when the pending authorization could not be read', async () => {
      const { prisma, store } = build();
      await inCallback({ attempt: Promise.reject(new Error('db down')) }, () => store.storeAuthCode(CODE as any));
      await flush();
      expect(prisma.productEvent.create.mock.calls[0][0].data.metadata).toEqual({ client: 'Claude', device: 'desktop' });
    });

    it('says nothing of it on the exchange: no browser is present there', async () => {
      const { prisma, store } = build();
      await inCallback({ device: 'mobile', connectedArm: 'next_step' }, () => store.getAuthCode('abc'));
      await flush();
      expect(prisma.productEvent.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ event: 'authorization_code_exchanged', metadata: { client: 'Claude' } }),
      );
    });
  });

  it('records the code being presented by the client, once', async () => {
    const { prisma, store } = build();
    const got = await store.getAuthCode('abc');
    await flush();
    expect(got?.user_id).toBe('u1');
    expect(prisma.productEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.productEvent.create.mock.calls[0][0].data.event).toBe('authorization_code_exchanged');
  });

  it('records nothing for a code that does not exist', async () => {
    const { prisma, store } = build();
    prisma.oAuthAuthorizationCode.findUnique.mockResolvedValue(null);
    expect(await store.getAuthCode('nope')).toBeUndefined();
    await flush();
    expect(prisma.productEvent.create).not.toHaveBeenCalled();
  });

  it('never lets a failed write reach the authorization', async () => {
    const { prisma, store } = build();
    prisma.productEvent.create.mockRejectedValue(new Error('db down'));
    await expect(store.storeAuthCode(CODE as any)).resolves.toBeUndefined();
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(store.getAuthCode('abc')).resolves.toEqual(expect.objectContaining({ code: 'abc' }));
    await flush();
  });

  it('keeps the row without a user when the id is not a user of ours', async () => {
    const { prisma, store } = build();
    prisma.user.findUnique.mockResolvedValue(null);
    await store.storeAuthCode(CODE as any);
    await flush();
    expect(prisma.productEvent.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ userId: null, organizationId: null }),
    );
  });
});
