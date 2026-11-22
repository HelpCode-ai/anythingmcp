import { AuthorizationAttemptMiddleware } from './authorization-attempt.middleware';
import { authorizationAttemptContext, attemptKey, type AuthorizationAttemptContext } from './authorization-attempt';

describe('AuthorizationAttemptMiddleware', () => {
  const EXPIRES = 1795305600000;
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

  const build = (opts: { cloud?: boolean; setting?: string; findUnique?: jest.Mock } = {}) => {
    const findUnique = opts.findUnique ?? jest.fn().mockResolvedValue({ expiresAt: BigInt(EXPIRES) });
    const middleware = new AuthorizationAttemptMiddleware(
      { oAuthSession: { findUnique } } as any,
      { get: (key: string) => (key === 'AUTHORIZE_CONNECTED_PAGE_TEST' ? opts.setting : undefined) } as any,
      { isCloud: () => opts.cloud !== false } as any,
    );
    return { middleware, findUnique };
  };

  /** Runs the middleware and returns what the rest of the request sees. */
  const seenBy = (middleware: AuthorizationAttemptMiddleware, req: object) =>
    new Promise<AuthorizationAttemptContext | undefined>((resolve) =>
      middleware.use(req as any, {} as any, () => resolve(authorizationAttemptContext.getStore())),
    );

  it('carries the device, the attempt and the page arm through the rest of the callback', async () => {
    const { middleware, findUnique } = build({ setting: 'next_step' });
    const context = await seenBy(middleware, { cookies: { oauth_session: 's1' }, headers: { 'user-agent': IPHONE } });

    expect(context?.device).toBe('mobile');
    expect(context?.connectedArm).toBe('next_step');
    await expect(context?.attempt).resolves.toBe(attemptKey(EXPIRES));
    expect(findUnique).toHaveBeenCalledWith({ where: { sessionId: 's1' }, select: { expiresAt: true } });
  });

  it('is still there after the handler has awaited something', async () => {
    const { middleware } = build({ setting: 'control' });
    const device = await new Promise<string | undefined>((resolve) =>
      middleware.use({ cookies: { oauth_session: 's1' }, headers: { 'user-agent': MAC } } as any, {} as any, () => {
        void Promise.resolve()
          .then(() => new Promise((r) => setImmediate(r)))
          .then(() => resolve(authorizationAttemptContext.getStore()?.device));
      }),
    );
    expect(device).toBe('desktop');
  });

  it('names no arm where the test does not run', async () => {
    for (const opts of [{ cloud: false }, { setting: 'off' }]) {
      const { middleware } = build(opts);
      const context = await seenBy(middleware, { cookies: { oauth_session: 's1' }, headers: {} });
      expect(context).toBeDefined();
      expect(context).not.toHaveProperty('connectedArm');
    }
  });

  it('lets the callback run without any context when there is no pending authorization', async () => {
    const { middleware, findUnique } = build();
    for (const req of [{ headers: {} }, { cookies: {}, headers: {} }, { cookies: { oauth_session: 42 }, headers: {} }]) {
      expect(await seenBy(middleware, req)).toBeUndefined();
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('never lets a failed lookup reach the callback', async () => {
    const rejecting = build({ findUnique: jest.fn().mockRejectedValue(new Error('db down')) });
    const context = await seenBy(rejecting.middleware, { cookies: { oauth_session: 's1' }, headers: {} });
    await expect(context?.attempt).resolves.toBeUndefined();

    const gone = build({ findUnique: jest.fn().mockResolvedValue(null) });
    await expect((await seenBy(gone.middleware, { cookies: { oauth_session: 's1' }, headers: {} }))?.attempt).resolves.toBeUndefined();

    const throwing = build({
      findUnique: jest.fn(() => {
        throw new Error('no client');
      }),
    });
    const next = jest.fn();
    expect(() => throwing.middleware.use({ cookies: { oauth_session: 's1' }, headers: {} } as any, {} as any, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('changes nothing on the request or the response', async () => {
    const { middleware } = build();
    const req = { cookies: { oauth_session: 's1' }, headers: { 'user-agent': MAC } };
    const res = {};
    const before = JSON.stringify(req);
    await new Promise<void>((resolve) => middleware.use(req as any, res as any, () => resolve()));
    expect(JSON.stringify(req)).toBe(before);
    expect(Object.keys(res)).toEqual([]);
  });
});
