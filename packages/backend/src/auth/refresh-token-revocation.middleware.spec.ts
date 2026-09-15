import { RefreshTokenRevocationMiddleware } from './refresh-token-revocation.middleware';

describe('RefreshTokenRevocationMiddleware', () => {
  const USER_ID = 'cmpzj8mm9007j1ymn5mo2y3eq';
  const TOKEN = 'a.signed.refresh-token';

  let middleware: RefreshTokenRevocationMiddleware;
  let prisma: any;
  let jwt: any;
  let securityEvents: any;
  let res: any;
  let next: jest.Mock;

  /** Seconds since epoch, the unit `iat` uses. */
  const secs = (d: Date) => Math.floor(d.getTime() / 1000);

  const req = (body: any, method = 'POST') => ({ method, body }) as any;

  const refreshBody = (token: string | undefined = TOKEN) => ({
    grant_type: 'refresh_token',
    ...(token === undefined ? {} : { refresh_token: token }),
  });

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    jwt = { verifyAsync: jest.fn() };
    securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    middleware = new RefreshTokenRevocationMiddleware(
      prisma,
      jwt,
      securityEvents,
    );
  });

  const expectPassthrough = () => {
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  };

  const expectDenied = () => {
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_grant',
      error_description: 'This session was revoked. Please sign in again.',
    });
  };

  // ── Pass-through: everything the upstream controller still owns ──────────

  it('ignores non-POST requests', async () => {
    await middleware.use(req(refreshBody(), 'GET'), res, next);
    expectPassthrough();
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('ignores the authorization_code grant', async () => {
    await middleware.use(req({ grant_type: 'authorization_code' }), res, next);
    expectPassthrough();
  });

  it('does not interfere with the client_credentials grant', async () => {
    // Guards the sibling middleware on the same route.
    await middleware.use(req({ grant_type: 'client_credentials' }), res, next);
    expectPassthrough();
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('leaves a missing refresh_token to upstream', async () => {
    await middleware.use(req(refreshBody(undefined)), res, next);
    expectPassthrough();
  });

  it('leaves an unverifiable token to upstream', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await middleware.use(req(refreshBody()), res, next);
    expectPassthrough();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('leaves an access token presented as a refresh token to upstream', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, type: 'access' });
    await middleware.use(req(refreshBody()), res, next);
    expectPassthrough();
  });

  // ── The watermark ────────────────────────────────────────────────────────

  it('allows the refresh when the user was never revoked', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, type: 'refresh', iat: 1000 });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: null,
    });
    await middleware.use(req(refreshBody()), res, next);
    expectPassthrough();
  });

  it('allows a token minted in the same second as the revocation', async () => {
    // Mirrors isTokenRevoked, which compares at second granularity so a token
    // issued moments after a password change is not rejected.
    const cutover = new Date('2026-09-11T12:00:00.500Z');
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: secs(cutover),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: cutover,
    });
    await middleware.use(req(refreshBody()), res, next);
    expectPassthrough();
  });

  it('refuses a token minted before the revocation', async () => {
    // THE BUG: before this middleware the upstream refresh grant answered 200
    // here and minted a token with a fresh iat, permanently above the watermark.
    const cutover = new Date('2026-09-11T12:00:00Z');
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: secs(cutover) - 1,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: cutover,
    });
    await middleware.use(req(refreshBody()), res, next);
    expectDenied();
  });

  it('marks the denial uncacheable', async () => {
    const cutover = new Date('2026-09-11T12:00:00Z');
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: secs(cutover) - 1,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: cutover,
    });
    await middleware.use(req(refreshBody()), res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('refuses a token whose user no longer exists', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, type: 'refresh', iat: 1000 });
    prisma.user.findUnique.mockResolvedValue(null);
    await middleware.use(req(refreshBody()), res, next);
    expectDenied();
  });

  // ── Subject resolution (never by email) ──────────────────────────────────

  it('refuses a legacy email-subject token with no recoverable profile', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'victim@example.com',
      type: 'refresh',
      iat: 1000,
    });
    await middleware.use(req(refreshBody()), res, next);
    expectDenied();
    // An email must never become a lookup key.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('resolves a legacy email-subject token through its profile id', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user@example.com',
      user_profile_id: 'local:' + USER_ID,
      type: 'refresh',
      iat: 1000,
    });
    prisma.oAuthUserProfile.findUnique.mockResolvedValue({
      externalId: USER_ID,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: null,
    });
    await middleware.use(req(refreshBody()), res, next);
    expectPassthrough();
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } }),
    );
  });

  // ── Body handling ────────────────────────────────────────────────────────

  it('reads a form-urlencoded string body', async () => {
    const cutover = new Date('2026-09-11T12:00:00Z');
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: secs(cutover) - 1,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: cutover,
    });
    await middleware.use(
      req(`grant_type=refresh_token&refresh_token=${TOKEN}`),
      res,
      next,
    );
    expectDenied();
  });

  it('never reads the raw request stream', async () => {
    // The upstream token controller has a captureRawBody fallback; consuming
    // the stream here would hang it.
    const on = jest.fn();
    await middleware.use({ method: 'POST', body: refreshBody(), on } as any, res, next);
    expect(on).not.toHaveBeenCalled();
  });

  // ── Audit ────────────────────────────────────────────────────────────────

  it('audits a refusal once per subject within the flood window', async () => {
    const cutover = new Date('2026-09-11T12:00:00Z');
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: secs(cutover) - 1,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: cutover,
    });

    await middleware.use(req(refreshBody()), res, next);
    await middleware.use(req(refreshBody()), res, next);

    expect(securityEvents.log).toHaveBeenCalledTimes(1);
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'TOKEN_REJECTED',
        targetUserId: USER_ID,
        metadata: expect.objectContaining({
          grantType: 'refresh_token',
          reason: 'revoked',
        }),
      }),
    );
  });
});
