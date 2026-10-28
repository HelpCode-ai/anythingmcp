// `openid-client` v6 is ESM-only and Jest cannot parse it; the controller
// imports SsoService (the connect page's sign-in), whose network half these
// tests do not exercise.
jest.mock('openid-client', () => ({}));
jest.mock('./connector-authorization', () => ({
  ...jest.requireActual('./connector-authorization'),
  startConnectorAuthorization: jest.fn(),
}));

import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';
import { startConnectorAuthorization } from './connector-authorization';

/**
 * The connect page (/auth/connect/:connectorId): a user connects their own
 * account to a connector with per-user credentials without the dashboard.
 * Routes of McpOAuthCallbackController.
 */
const FRONTEND = 'https://aibridge.example.com';
const start = startConnectorAuthorization as jest.Mock;

function setup(opts: {
  credentialScope?: 'SHARED' | 'USER';
  member?: boolean;
  enterprise?: boolean;
  connected?: boolean;
  sessionsValidFrom?: Date | null;
  flow?: Record<string, unknown> | null;
  cloud?: boolean;
} = {}) {
  const connector = {
    id: 'conn-1',
    name: 'MFR Servicetechniker',
    organizationId: 'org-1',
    credentialScope: opts.credentialScope ?? 'USER',
    authType: 'OAUTH2',
    type: 'MCP',
    baseUrl: 'https://mcp.example.com/mcp',
    authConfig: null,
    envVars: null,
    config: null,
    headers: null,
  };
  const flow =
    opts.flow === null
      ? undefined
      : {
          flow: {
            connectorId: 'conn-1',
            userId: 'u1',
            tokenUrl: 'https://mcp.example.com/token',
            redirectUri: 'https://aibridge.example.com/api/mcp-oauth/callback',
            clientId: 'dyn-1',
            codeVerifier: 'v',
            forUser: true,
            completeOn: 'connect-page',
            ...(opts.flow ?? {}),
          },
        };
  const prisma: any = {
    connector: { findUnique: jest.fn().mockResolvedValue(connector) },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'lena@example.com',
        sessionsValidFrom: opts.sessionsValidFrom ?? null,
      }),
    },
    organizationMember: { findFirst: jest.fn().mockResolvedValue(opts.member === false ? null : { id: 'm1' }) },
    identityProvider: { findMany: jest.fn().mockResolvedValue([{ id: 'idp-1', name: 'Microsoft Entra ID' }]) },
    mcpTool: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
  };
  const mcpOAuthService: any = {
    getPendingFlow: jest.fn().mockResolvedValue(flow),
    takePendingFlow: jest.fn().mockResolvedValue(flow),
    exchangeCodeForTokens: jest.fn().mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 }),
  };
  const connectorsService: any = {
    updateAuthConfigMerge: jest.fn(),
    findByIdInternal: jest.fn().mockResolvedValue({ ...connector, type: 'REST' }),
  };
  const config: any = {
    get: (k: string) =>
      ({
        FRONTEND_URL: FRONTEND,
        SERVER_URL: FRONTEND,
        ENCRYPTION_KEY: 'k'.repeat(64),
      })[k],
  };
  const userCredentials: any = {
    store: jest.fn(),
    status: jest.fn().mockResolvedValue(opts.connected ? { connected: true, authorizedAt: '2026-10-28T08:00:00.000Z' } : { connected: false }),
  };
  const sso: any = { startConnect: jest.fn().mockResolvedValue({ authorizationUrl: 'https://login.example.com/authorize' }) };
  const edition: any = { hasEnterprise: jest.fn().mockResolvedValue(opts.enterprise ?? true) };
  const deployment: any = { isCloud: () => !!opts.cloud };
  // No dashboard session in these tests: the token never verifies.
  const authService: any = { verifyToken: jest.fn(() => { throw new Error('no session'); }) };

  const controller = new McpOAuthCallbackController(
    mcpOAuthService,
    connectorsService,
    { listTools: jest.fn().mockResolvedValue([]) } as any,
    prisma,
    { reloadConnectorTools: jest.fn() } as any,
    config,
    undefined,
    userCredentials,
    authService,
    sso,
    edition,
    deployment,
  );
  return { controller, prisma, mcpOAuthService, userCredentials, sso, edition };
}

function makeRes() {
  const res: any = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
  };
  res.status = jest.fn(() => res);
  return res;
}

/** A request; `signedIn` adds the cookie the SSO callback sets after a connect sign-in. */
function makeReq(signedCookies: Record<string, string> = {}, signedIn = false) {
  return {
    headers: { 'x-forwarded-proto': 'https' },
    cookies: {},
    signedCookies: {
      ...(signedIn ? { connect_user: JSON.stringify({ uid: 'u1', iat: Date.now() }) } : {}),
      ...signedCookies,
    },
  } as any;
}

const html = (res: any) => String(res.send.mock.calls[0][0]);

beforeEach(() => start.mockReset());

// The dashboard links are built from the environment, as in production.
const savedFrontend = process.env.FRONTEND_URL;
beforeAll(() => {
  process.env.FRONTEND_URL = FRONTEND;
});
afterAll(() => {
  if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontend;
});

describe('connect page', () => {
  it('asks a stranger to sign in with the workspace provider, without naming the connector', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(html(res)).toContain('Continue with Microsoft Entra ID');
    expect(html(res)).toContain('formaction="/auth/connect/conn-1/sso/idp-1"');
    expect(html(res)).not.toContain('MFR Servicetechniker');
    // A CSRF token for the forms, as a signed cookie.
    expect(res.cookie).toHaveBeenCalledWith('connect_csrf', expect.any(String), expect.objectContaining({ signed: true }));
  });

  it('offers no identity provider on Cloud, only the dashboard', async () => {
    const { controller, prisma } = setup({ cloud: true });
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq(), res);
    expect(prisma.identityProvider.findMany).not.toHaveBeenCalled();
    expect(html(res)).toContain(`${FRONTEND}/connectors/conn-1`);
  });

  it('shows nothing for a connector with a shared sign-in', async () => {
    const { controller } = setup({ credentialScope: 'SHARED' });
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq({}, true), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(html(res)).toContain('does not lead to a connection');
  });

  it('lets a signed-in member connect', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq({}, true), res);
    expect(html(res)).toContain('MFR Servicetechniker');
    expect(html(res)).toContain('lena@example.com');
    expect(html(res)).toContain('Connect my account');
  });

  it('shows nothing to a user who is not a member of the workspace', async () => {
    const { controller } = setup({ member: false });
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq({}, true), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(html(res)).not.toContain('MFR Servicetechniker');
  });

  it('ends the sign-in when the user signed out everywhere afterwards', async () => {
    const { controller } = setup({ sessionsValidFrom: new Date(Date.now() + 60_000) });
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq({}, true), res);
    expect(html(res)).toContain('Continue with Microsoft Entra ID');
  });

  it('says so without an Enterprise licence', async () => {
    const { controller } = setup({ enterprise: false });
    const res = makeRes();
    await controller.connectPage('conn-1', undefined, undefined, makeReq({}, true), res);
    expect(html(res)).toContain('needs AnythingMCP Enterprise');
    expect(html(res)).not.toContain('/auth/connect/conn-1/connect');
  });
});

describe('connect page actions', () => {
  const csrf = { connect_csrf: 'tok-1' };

  it('refuses a form without the CSRF token', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPageConnect('conn-1', { csrf: 'other' }, makeReq(csrf, true), res);
    expect(start).not.toHaveBeenCalled();
    const [status, url] = res.redirect.mock.calls[0];
    expect(status).toBe(303);
    expect(url.startsWith('/auth/connect/conn-1?error=')).toBe(true);
  });

  it("starts the signed-in user's own authorization and binds it to this browser", async () => {
    start.mockResolvedValue({ authorizationUrl: 'https://mcp.example.com/authorize?x', state: 'st-1' });
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPageConnect('conn-1', { csrf: 'tok-1' }, makeReq(csrf, true), res);
    expect(start.mock.calls[0][2]).toEqual({ userId: 'u1', forUser: true, completeOn: 'connect-page' });
    expect(start.mock.calls[0][0].callbackUrl).toBe(`${FRONTEND}/api/mcp-oauth/callback`);
    expect(res.cookie).toHaveBeenCalledWith('connect_flow', 'st-1', expect.objectContaining({ path: '/auth/connect', signed: true }));
    expect(res.redirect).toHaveBeenCalledWith(303, 'https://mcp.example.com/authorize?x');
  });

  it('does not start an authorization for a stranger', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPageConnect('conn-1', { csrf: 'tok-1' }, makeReq(csrf), res);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the identity-provider sign-in with a binding kept in a signed cookie', async () => {
    const { controller, sso } = setup();
    const res = makeRes();
    await controller.connectPageSignIn('conn-1', 'idp-1', { csrf: 'tok-1' }, makeReq(csrf), res);
    const [providerId, orgId, connectorId, binding] = sso.startConnect.mock.calls[0];
    expect([providerId, orgId, connectorId]).toEqual(['idp-1', 'org-1', 'conn-1']);
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe('connect_sso');
    expect(JSON.parse(value)).toEqual({ b: binding, c: 'conn-1' });
    expect(options).toMatchObject({ path: '/auth', httpOnly: true, signed: true });
    expect(res.redirect).toHaveBeenCalledWith(303, 'https://login.example.com/authorize');
  });
});

describe('connect page sign-out', () => {
  it('forgets the connect sign-in only with a valid CSRF token', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.connectPageSwitch('conn-1', { csrf: 'nope' }, makeReq({ connect_csrf: 'tok-1' }, true), res);
    expect(res.clearCookie).not.toHaveBeenCalled();
    await controller.connectPageSwitch('conn-1', { csrf: 'tok-1' }, makeReq({ connect_csrf: 'tok-1' }, true), res);
    expect(res.clearCookie).toHaveBeenCalledWith('connect_user', { path: '/auth/connect' });
  });
});

describe('connect page completion', () => {
  it("stores the tokens on the user's own row when the same user returns in the same browser", async () => {
    const { controller, userCredentials, mcpOAuthService } = setup();
    const res = makeRes();
    await controller.connectPageComplete('st-1', 'the-code', makeReq({ connect_flow: 'st-1' }, true), res);
    expect(mcpOAuthService.exchangeCodeForTokens).toHaveBeenCalledWith(expect.objectContaining({ code: 'the-code' }));
    expect(userCredentials.store).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn-1' }), 'u1', expect.objectContaining({ accessToken: 'AT' }));
    expect(res.redirect).toHaveBeenCalledWith(303, `${FRONTEND}/auth/connect/conn-1?connected=1`);
  });

  it('refuses a return to another browser and spends the authorization', async () => {
    // The attack: someone starts a connection and gets the victim to finish
    // it at the provider; the victim's browser carries no binding cookie.
    const { controller, userCredentials, mcpOAuthService } = setup();
    const res = makeRes();
    await controller.connectPageComplete('st-1', 'the-code', makeReq({}, true), res);
    expect(mcpOAuthService.takePendingFlow).toHaveBeenCalledWith('st-1');
    expect(mcpOAuthService.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(userCredentials.store).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(303, expect.stringContaining('error='));
  });

  it('refuses a flow started by another user', async () => {
    const { controller, mcpOAuthService } = setup({ flow: { userId: 'someone-else' } });
    const res = makeRes();
    await controller.connectPageComplete('st-1', 'the-code', makeReq({ connect_flow: 'st-1' }, true), res);
    expect(mcpOAuthService.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('does not complete a flow the dashboard started', async () => {
    const { controller, mcpOAuthService } = setup({ flow: { completeOn: undefined } });
    const res = makeRes();
    await controller.connectPageComplete('st-1', 'the-code', makeReq({ connect_flow: 'st-1' }, true), res);
    expect(mcpOAuthService.takePendingFlow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(410);
  });
});

describe('provider redirect for a connect-page flow', () => {
  it('sends the browser back to the connect page, which completes it', async () => {
    const { controller, mcpOAuthService } = setup();
    const res = makeRes();
    await controller.oauthCallback('the-code', 'st-1', undefined, undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(`${FRONTEND}/auth/connect/complete?state=st-1&code=the-code`);
    expect(mcpOAuthService.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('shows a refusal at the provider on the connect page', async () => {
    const { controller } = setup();
    const res = makeRes();
    await controller.oauthCallback(undefined, 'st-1', 'access_denied', undefined, res);
    expect(res.redirect.mock.calls[0][0].startsWith(`${FRONTEND}/auth/connect/conn-1?error=`)).toBe(true);
  });
});
