// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController, WRONG_WORKSPACE_MESSAGE } from './login.controller';

/**
 * #1609: a client that asked for one MCP server by URL gets no token for an
 * account outside that server's workspace. Such a token was refused on every
 * call (one user 510 times in 13 hours), and clients do not sign in again
 * after a 403.
 */
function build(opts: {
  requestedServerId?: string;
  server?: { organizationId: string } | null;
  primaryOrg?: string;
  member?: boolean;
}) {
  const prisma = {
    mcpServerConfig: {
      findUnique: jest.fn().mockResolvedValue(opts.server === undefined ? null : opts.server),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ organizationId: opts.primaryOrg ?? 'org-A' }) },
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue(opts.member ? { userId: 'u1' } : null),
    },
  };
  const grants = {
    grantServers: jest.fn().mockResolvedValue(['srv-B']),
    grantWholeOrganization: jest.fn(),
    listSelectableTargets: jest.fn().mockResolvedValue([]),
  };
  const store = {
    getOAuthSession: jest
      .fn()
      .mockResolvedValue({ clientId: 'client-1', redirectUri: 'https://claude.ai/cb', scope: 's' }),
    getClient: jest.fn().mockResolvedValue({ client_name: 'Claude' }),
  };
  const controller = new LoginController(
    { comparePassword: jest.fn() } as any,
    prisma as any,
    { get: jest.fn() } as any,
    store as any,
    { startMcp: jest.fn() } as any,
    // Self-hosted: no first-connector page after Approve, straight to /callback.
    { isCloud: () => false } as any,
    grants as any,
  );
  const req: any = {
    cookies: { oauth_session: 'sess-1' },
    signedCookies: opts.requestedServerId ? { mcp_resource: opts.requestedServerId } : {},
    headers: { host: 'cloud.anythingmcp.com' },
    protocol: 'https',
    get: () => 'cloud.anythingmcp.com',
  };
  const res: any = {
    cookie: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn(),
    clearCookie: jest.fn(),
  };
  return { controller, prisma, grants, req, res };
}

const USER = { id: 'u1', email: 'person@example.com', name: 'Person' };
const signIn = (c: LoginController, req: any, res: any) =>
  (c as any).completeSignIn(req, res, USER);
const loginUserCookie = (res: any) =>
  res.cookie.mock.calls.find((call: any[]) => call[0] === 'login_user');

describe('authorization for a server of another workspace (#1609)', () => {
  it('issues nothing and sends the person back to sign in with another account', async () => {
    const { controller, grants, req, res } = build({
      requestedServerId: 'srv-B',
      server: { organizationId: 'org-B' },
      primaryOrg: 'org-A',
      member: false,
    });

    await signIn(controller, req, res);

    expect(loginUserCookie(res)).toBeUndefined();
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = res.redirect.mock.calls[0][0] as string;
    expect(target).toMatch(/^\/auth\/login\?switch=1&error=/);
    expect(decodeURIComponent(target.split('error=')[1])).toBe(WRONG_WORKSPACE_MESSAGE);
    expect(target).not.toContain('callback');
  });

  it('goes on for a member of the server workspace whose primary workspace is another one', async () => {
    const { controller, grants, req, res } = build({
      requestedServerId: 'srv-B',
      server: { organizationId: 'org-B' },
      primaryOrg: 'org-A',
      member: true,
    });

    await signIn(controller, req, res);

    expect(loginUserCookie(res)).toBeDefined();
    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-B']);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringMatching(/\/callback$/));
  });

  it('goes on when the server is in the primary workspace, without a membership lookup', async () => {
    const { controller, prisma, req, res } = build({
      requestedServerId: 'srv-A',
      server: { organizationId: 'org-A' },
      primaryOrg: 'org-A',
    });

    await signIn(controller, req, res);

    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
    expect(loginUserCookie(res)).toBeDefined();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringMatching(/\/callback$/));
  });

  it('does not look at servers at all when the client named none', async () => {
    const { controller, prisma, req, res } = build({});

    await signIn(controller, req, res);

    expect(prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
    expect(loginUserCookie(res)).toBeDefined();
  });

  it('leaves an unknown server id to the existing flow', async () => {
    const { controller, req, res } = build({ requestedServerId: 'srv-gone', server: null });

    await signIn(controller, req, res);

    expect(loginUserCookie(res)).toBeDefined();
  });
});
