import {
  RefreshTokenRevocationMiddleware,
  refreshResourceKind,
} from './refresh-token-revocation.middleware';
import { CrossWorkspaceRefusalStore } from './cross-workspace-refusal.store';

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

/**
 * #1609 follow-up: a token for a server of a workspace the user is not in was
 * refused by the MCP endpoint (401), refreshed here with 200, refused again,
 * and so on forever, because the refresh grant checked no membership. The
 * refresh now answers invalid_grant, which makes the client authorize again
 * and meet the consent page's explanation.
 */
describe('RefreshTokenRevocationMiddleware — server of another workspace', () => {
  const USER_ID = 'cmpzj8mm9007j1ymn5mo2y3eq';
  const CLIENT = 'client-1';
  const SRV_A = 'cmsrva00000000000000000aa'; // in org-A, the user's primary workspace
  const SRV_B = 'cmsrvb00000000000000000bb'; // in org-B
  const SRV_GONE = 'cmsrvz00000000000000000zz';
  const ORG_OF: Record<string, string> = { [SRV_A]: 'org-A', [SRV_B]: 'org-B' };
  const WRONG_WORKSPACE =
    'This sign-in is not a member of the workspace that owns this MCP server. ' +
    'Connect again and sign in with an account of that workspace, or ask its admin to invite you.';
  const url = (path: string) => `https://cloud.anythingmcp.com${path}`;

  let middleware: RefreshTokenRevocationMiddleware;
  let prisma: any;
  let jwt: any;
  let securityEvents: any;
  let store: CrossWorkspaceRefusalStore;
  let res: any;
  let next: jest.Mock;
  /** Organizations the user holds an active membership row in. */
  let memberOf: string[];

  const refresh = (extra: Record<string, unknown> = {}) =>
    ({
      method: 'POST',
      body: { grant_type: 'refresh_token', refresh_token: 'a.signed.refresh-token', ...extra },
    }) as any;

  beforeEach(() => {
    memberOf = [];
    prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: USER_ID, sessionsValidFrom: null, organizationId: 'org-A' }),
      },
      oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      mcpServerConfig: {
        findUnique: jest.fn(async ({ where }: any) =>
          ORG_OF[where.id] ? { organizationId: ORG_OF[where.id] } : null,
        ),
      },
      organizationMember: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.deactivatedAt === null && memberOf.includes(where.organizationId)
            ? { userId: where.userId }
            : null,
        ),
      },
    };
    jwt = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: USER_ID, type: 'refresh', iat: 1000, client_id: CLIENT }),
    };
    securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
    store = new CrossWorkspaceRefusalStore();
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    middleware = new RefreshTokenRevocationMiddleware(prisma, jwt, securityEvents, store);
    jest.spyOn((middleware as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((middleware as any).logger, 'warn').mockImplementation(() => undefined);
  });

  const expectPassthrough = () => {
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  };

  const expectWrongWorkspace = (via: 'resource' | 'marker', serverId = SRV_B) => {
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_grant',
      error_description: WRONG_WORKSPACE,
    });
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'TOKEN_REJECTED',
        targetUserId: USER_ID,
        metadata: expect.objectContaining({ reason: 'wrong_workspace', via, serverId }),
      }),
    );
    // Not written into the other workspace's audit log.
    expect(securityEvents.log.mock.calls[0][0].organizationId).toBeUndefined();
  };

  // ── (a) the resource the client sends ────────────────────────────────────

  it('refuses a refresh that names a server of a workspace the user is not in', async () => {
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expectWrongWorkspace('resource');
    const warn = (middleware as any).logger.warn as jest.Mock;
    expect(warn).toHaveBeenCalledWith(
      `Refused refresh_token for ${USER_ID} (wrong_workspace via resource, server …0000bb)`,
    );
  });

  it('allows a refresh for a server of a non-primary workspace the user is an active member of', async () => {
    memberOf = ['org-B'];
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expectPassthrough();
  });

  it('allows a member who switched the active workspace away from the server', async () => {
    // Switching moves the primary org; the membership row of org-A stays.
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, sessionsValidFrom: null, organizationId: 'org-B' });
    memberOf = ['org-A', 'org-B'];
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_A}`) }), res, next);
    expectPassthrough();
  });

  it('allows a refresh for a server of the primary workspace without a membership lookup', async () => {
    // Also the self-hosted single-workspace case: everyone is in the one org.
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_A}`) }), res, next);
    expectPassthrough();
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
    // The user row loaded for the watermark is reused.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(['/mcp', '/mcp/file-search', '/mcp/chatgpt-app'])(
    'leaves a refresh for %s alone, even with a fresh marker',
    async (path) => {
      await store.mark(USER_ID, CLIENT, SRV_B);
      await middleware.use(refresh({ resource: url(path) }), res, next);
      expectPassthrough();
      expect(prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
    },
  );

  it('leaves a malformed resource alone when there is no marker', async () => {
    await middleware.use(refresh({ resource: 'not a url' }), res, next);
    expectPassthrough();
    expect(prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
  });

  it('falls through for an unknown server id', async () => {
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_GONE}`) }), res, next);
    expectPassthrough();
  });

  it('falls through when Prisma throws', async () => {
    prisma.mcpServerConfig.findUnique.mockRejectedValue(new Error('db down'));
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expectPassthrough();
  });

  it('refuses when the only membership is deactivated', async () => {
    // A deactivated row never matches `deactivatedAt: null`.
    memberOf = [];
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expectWrongWorkspace('resource');
  });

  it('checks the watermark first: a revoked token keeps its own reason and text', async () => {
    const cutover = new Date('2026-09-11T12:00:00Z');
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, sessionsValidFrom: cutover, organizationId: 'org-A' });
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      type: 'refresh',
      iat: Math.floor(cutover.getTime() / 1000) - 1,
      client_id: CLIENT,
    });
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_grant',
      error_description: 'This session was revoked. Please sign in again.',
    });
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'revoked' }) }),
    );
    expect(prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the deleted-user reason and text', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_B}`) }), res, next);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_grant',
      error_description: 'This session was revoked. Please sign in again.',
    });
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'user_deleted' }) }),
    );
  });

  // ── (b) the endpoint's marker, when the refresh names no server ──────────

  it('refuses via the marker when the refresh names no resource and the endpoint just refused this client', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B);
    await middleware.use(refresh(), res, next);
    expectWrongWorkspace('marker');
  });

  it('refuses via the marker when the resource cannot be parsed', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B);
    await middleware.use(refresh({ resource: 'not a url' }), res, next);
    expectWrongWorkspace('marker');
  });

  it('refuses a retry of the same refresh token again (the marker is kept)', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B);
    await middleware.use(refresh(), res, next);
    await middleware.use(refresh(), res, next);
    expect(res.status).toHaveBeenCalledTimes(2);
    expect(next).not.toHaveBeenCalled();
    await expect(store.peek(USER_ID, CLIENT)).resolves.toBe(SRV_B);
  });

  it('ignores a marker of another client of the same user', async () => {
    await store.mark(USER_ID, 'client-2', SRV_B);
    await middleware.use(refresh(), res, next);
    expectPassthrough();
  });

  it('ignores an expired marker', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B, Date.now() - CrossWorkspaceRefusalStore.TTL_SECONDS * 1000 - 1);
    await middleware.use(refresh(), res, next);
    expectPassthrough();
  });

  it('does not refuse via the marker once the user has become a member, and clears it', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B);
    memberOf = ['org-B'];
    await middleware.use(refresh(), res, next);
    expectPassthrough();
    await expect(store.peek(USER_ID, CLIENT)).resolves.toBeNull();
  });

  it('lets a body resource naming another server win over the marker', async () => {
    await store.mark(USER_ID, CLIENT, SRV_B);
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_A}`) }), res, next);
    expectPassthrough();
  });

  it('passes a refresh with no resource when the endpoint refused nothing', async () => {
    await middleware.use(refresh(), res, next);
    expectPassthrough();
    expect(prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
  });

  it('works without the store (only path a)', async () => {
    middleware = new RefreshTokenRevocationMiddleware(prisma, jwt, securityEvents);
    jest.spyOn((middleware as any).logger, 'log').mockImplementation(() => undefined);
    await middleware.use(refresh(), res, next);
    expectPassthrough();
  });

  // ── Temporary instrumentation ────────────────────────────────────────────

  it('logs what the refresh named once per client and kind per hour, without the token', async () => {
    const log = (middleware as any).logger.log as jest.Mock;
    await middleware.use(refresh(), res, next);
    await middleware.use(refresh(), res, next);
    await middleware.use(refresh({ resource: url(`/mcp/${SRV_A}`) }), res, next);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'Refresh grant resource: none (client …ient-1)',
      'Refresh grant resource: server (client …ient-1)',
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('a.signed.refresh-token');
  });
});

describe('refreshResourceKind', () => {
  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['https://h/mcp/cmsrvb00000000000000000bb', 'server'],
    ['https://h/mcp', 'global'],
    ['https://h/mcp/', 'global'],
    ['https://h/mcp/file-search', 'plugin'],
    ['https://h/mcp/chatgpt-app', 'plugin'],
    ['not a url', 'other'],
    ['https://h/other', 'other'],
    [['https://h/mcp'], 'other'],
  ])('%p is %p', (resource, kind) => {
    expect(refreshResourceKind(resource)).toBe(kind);
  });
});
