// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import { SSO_REQUIRED_MESSAGE } from './sso-enforcement.service';
import { HealthController } from '../health/health.controller';
import type { Request, Response } from 'express';

/**
 * Organization sign-in (SSO, self-hosted) on the MCP authorization pages:
 * which provider buttons the page shows, what a password gets in a workspace
 * that requires SSO, and that a finished SSO sign-in takes the path of every
 * other sign-in on the page.
 */

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };

interface Provider {
  id: string;
  name: string;
  type: string;
  initiateId: string;
  organizationId: string;
  isActive: boolean;
}

const PROVIDERS: Provider[] = [
  { id: 'idp-a', name: 'Directory A', type: 'OIDC', initiateId: 'init-a', organizationId: 'org-a', isActive: true },
  { id: 'idp-b', name: 'Directory B', type: 'ENTRA', initiateId: 'init-b', organizationId: 'org-b', isActive: true },
  { id: 'idp-off', name: 'Switched off', type: 'OIDC', initiateId: 'init-off', organizationId: 'org-a', isActive: false },
];

function makeRes() {
  const res: any = {
    _cookies: {} as Record<string, { value: string; options: any }>,
    _cleared: [] as string[],
    cookie(name: string, value: string, options: any) {
      this._cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string) {
      this._cleared.push(name);
      return this;
    },
    setHeader() {
      return this;
    },
    status() {
      return this;
    },
    send(payload: string) {
      this._sent = payload;
      return this;
    },
    redirect(a: string | number, b?: string) {
      this._redirect = typeof a === 'number' ? (b as string) : a;
      return this;
    },
  };
  return res as Response & Record<string, any>;
}

function build(opts: {
  deployment?: typeof CLOUD;
  providers?: Provider[];
  /** The server the client asked for by URL, and the workspace it belongs to. */
  server?: { id: string; organizationId: string };
  users?: unknown[];
  enforcement?: { isPasswordLoginBlocked: jest.Mock } | null;
  targets?: unknown[];
  member?: boolean;
  primaryOrg?: string;
} = {}) {
  const providers = opts.providers ?? PROVIDERS;
  const prisma = {
    identityProvider: {
      // The real query: active providers, oldest first; here in list order.
      findMany: jest.fn(async (args: any) => {
        expect(args.where).toEqual({ isActive: true });
        return providers.filter((p) => p.isActive);
      }),
    },
    mcpServerConfig: {
      findUnique: jest.fn(async () => (opts.server ? { organizationId: opts.server.organizationId, name: 'Server' } : null)),
    },
    organizationMember: { findFirst: jest.fn(async () => (opts.member === false ? null : { userId: 'u1', role: 'ADMIN' })) },
    // A workspace that already has a connector: no page after approving (Cloud).
    connector: { count: jest.fn(async () => 1) },
    user: {
      findUnique: jest.fn(async () => ({ organizationId: opts.primaryOrg ?? 'org-a', createdAt: new Date(0) })),
      findMany: jest.fn(async () => opts.users ?? []),
    },
  };
  const auth = { comparePassword: jest.fn(async () => true), verifyToken: jest.fn(() => { throw new Error('no session'); }) };
  const grants = {
    grantServers: jest.fn(async (_c: string, _u: string, ids: string[]) => ids),
    grantRequestedServer: jest.fn(async () => true),
    firstOwnServerId: jest.fn(async () => null),
    grantWholeOrganization: jest.fn(async () => true),
    listSelectableTargets: jest.fn(async () => opts.targets ?? []),
    restrictedIn: jest.fn(async () => false),
    keepVisible: jest.fn(async (_u: string, servers: unknown[]) => servers),
    resolve: jest.fn(async () => null),
  };
  const store = {
    getOAuthSession: jest.fn(async (id: string) =>
      id === 's1' ? { clientId: 'client-1', redirectUri: 'https://claude.ai/api/mcp/auth_callback', scope: 's' } : undefined,
    ),
    getClient: jest.fn(async () => ({ client_name: 'Claude' })),
  };
  const productEvents = { log: jest.fn(async () => undefined) };
  const deployment = opts.deployment ?? SELF_HOSTED;
  const controller = new LoginController(
    auth as any,
    prisma as any,
    { get: jest.fn(() => undefined) } as any,
    store as any,
    { startMcp: jest.fn() } as any,
    deployment as any,
    grants as any,
    productEvents as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.enforcement === null ? undefined : ((opts.enforcement ?? { isPasswordLoginBlocked: jest.fn(async () => false) }) as any),
  );
  const req = (extra: Record<string, unknown> = {}) =>
    ({
      headers: { host: 'mcp.example.test' },
      cookies: { oauth_session: 's1' },
      signedCookies: { ...(opts.server ? { mcp_resource: opts.server.id } : {}), ...extra },
      secure: false,
    }) as unknown as Request;
  return { controller, prisma, auth, grants, store, productEvents, deployment, req };
}

/** The values of the organization sign-in buttons on the page, in order. */
const buttons = (html: string) => [...html.matchAll(/name="action" value="sso:([^"]+)"/g)].map((m) => m[1]);

async function page(b: ReturnType<typeof build>) {
  const res = makeRes();
  await b.controller.showLoginPage(undefined as any, undefined as any, b.req(), res);
  return res._sent as string;
}

describe('authorization page: which organization sign-in buttons it shows', () => {
  it('shows them on the shared /mcp endpoint of a self-hosted instance (the client named no server)', async () => {
    const b = build();
    expect(buttons(await page(b))).toEqual(['idp-a', 'idp-b']);
    // The client named no server, so none is looked up.
    expect(b.prisma.mcpServerConfig.findUnique).not.toHaveBeenCalled();
  });

  it('shows exactly the providers the dashboard sign-in page shows an anonymous visitor', async () => {
    const b = build();
    const html = await page(b);
    const health = new HealthController(
      {} as any,
      b.prisma as any,
      {} as any,
      { get: () => undefined } as any,
      { count: async () => 1 } as any,
      b.deployment as any,
    );
    const dashboard = (await health.getServerInfo()).ssoProviders.map((p) => p.name).sort();
    expect(dashboard).toEqual(['Directory A', 'Directory B']);
    const shown = PROVIDERS.filter((p) => html.includes(`>${p.name}<`)).map((p) => p.name).sort();
    expect(shown).toEqual(dashboard);
    // An inactive provider is named on neither page.
    expect(html).not.toContain('Switched off');
  });

  it('puts the providers of the requested server\'s workspace first', async () => {
    const b = build({ server: { id: 'srv-b', organizationId: 'org-b' } });
    expect(buttons(await page(b))).toEqual(['idp-b', 'idp-a']);
  });

  it('keeps the dashboard\'s list for a server id nobody knows', async () => {
    const b = build();
    const res = makeRes();
    await b.controller.showLoginPage(undefined as any, undefined as any, b.req({ mcp_resource: 'srv-gone' }), res);
    expect(buttons(res._sent)).toEqual(['idp-a', 'idp-b']);
  });

  it('shows none on Cloud and does not query for them', async () => {
    for (const server of [undefined, { id: 'srv-a', organizationId: 'org-a' }]) {
      const b = build({ deployment: CLOUD, server });
      const html = await page(b);
      expect(buttons(html)).toEqual([]);
      expect(html).not.toContain('Directory A');
      expect(b.prisma.identityProvider.findMany).not.toHaveBeenCalled();
    }
  });

  it('leaves the page of an instance without identity providers as it was', async () => {
    const b = build({ providers: [] });
    const html = await page(b);
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain('class="sso"');
    expect(html).toContain('name="password"');
  });

  it('still shows the password form when the providers cannot be read', async () => {
    const b = build();
    b.prisma.identityProvider.findMany.mockRejectedValueOnce(new Error('database away'));
    const html = await page(b);
    expect(buttons(html)).toEqual([]);
    expect(html).toContain('name="password"');
  });
});

const ACCOUNT = { id: 'u1', email: 'person@example.com', name: 'Person', passwordHash: '$2b$12$hash', emailVerified: true, passwordLoginDisabled: false };

async function password(b: ReturnType<typeof build>, typed = 'whatever-was-typed') {
  const res = makeRes();
  await b.controller.handleLogin(
    b.req({ login_csrf: 'tok' }),
    { email: ACCOUNT.email, password: typed, csrf: 'tok', action: 'approve' },
    res,
  );
  return res;
}

describe('authorization page: a password in a workspace that requires single sign-on', () => {
  const blocked = () => ({ isPasswordLoginBlocked: jest.fn(async () => true) });

  it('is refused before it is compared, with a message that names the organization sign-in', async () => {
    const enforcement = blocked();
    const b = build({ users: [ACCOUNT], enforcement });
    const res = await password(b);

    expect(enforcement.isPasswordLoginBlocked).toHaveBeenCalledWith('u1');
    expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent(SSO_REQUIRED_MESSAGE)}`);
    expect(SSO_REQUIRED_MESSAGE).toMatch(/organization sign-in/);
    // Not compared: the answer cannot say whether the password was right.
    expect(b.auth.comparePassword).not.toHaveBeenCalled();
    expect(res._cookies['login_user']).toBeUndefined();
    expect(b.grants.grantServers).not.toHaveBeenCalled();
  });

  it('gives a right and a wrong password the same answer', async () => {
    const answers = new Set<string>();
    for (const valid of [true, false]) {
      const b = build({ users: [ACCOUNT], enforcement: blocked() });
      b.auth.comparePassword.mockResolvedValue(valid);
      answers.add((await password(b))._redirect);
    }
    expect(answers.size).toBe(1);
  });

  it('leaves the person a way through: the requiring provider is active, so its button is on the page', async () => {
    // What refuses the password (an ACTIVE provider that requires SSO) is
    // what the page lists (every active provider).
    const b = build({ users: [ACCOUNT], enforcement: blocked() });
    expect(buttons(await page(b))).toContain('idp-a');
  });

  it('keeps the per-account message for an account whose own password sign-in is off', async () => {
    const enforcement = blocked();
    const b = build({ users: [{ ...ACCOUNT, passwordLoginDisabled: true }], enforcement });
    const res = await password(b);
    // The page writes the text from this key, in its own language.
    expect(res._redirect).toBe('/auth/login?error=passwordDisabled');
    expect(enforcement.isPasswordLoginBlocked).not.toHaveBeenCalled();
  });

  it('does not ask about an address without an account', async () => {
    const enforcement = blocked();
    const b = build({ users: [], enforcement });
    b.auth.comparePassword.mockResolvedValue(false);
    const res = await password(b);
    expect(enforcement.isPasswordLoginBlocked).not.toHaveBeenCalled();
    expect(res._redirect).toBe('/auth/login?error=invalidCredentials');
  });

  it('signs in as before where no workspace requires it (and on Cloud, where none can)', async () => {
    for (const deployment of [SELF_HOSTED, CLOUD]) {
      const b = build({ deployment, users: [ACCOUNT], targets: [{ organizationId: 'org-a', organizationName: 'A', servers: [{ id: 'srv-1', name: 'One', connectorCount: 1 }] }] });
      const res = await password(b);
      expect(b.auth.comparePassword).toHaveBeenCalledTimes(1);
      expect(res._cookies['login_user']).toBeDefined();
    }
  });
});

const PERSON = { id: 'u1', email: 'person@example.com', name: 'Person' };
const ONE = [{ organizationId: 'org-a', organizationName: 'A', servers: [{ id: 'srv-1', name: 'One', connectorCount: 1 }] }];
const TWO = [{ organizationId: 'org-a', organizationName: 'A', servers: [{ id: 'srv-1', name: 'One', connectorCount: 1 }, { id: 'srv-2', name: 'Two', connectorCount: 1 }] }];

describe('authorization page: after an organization sign-in', () => {
  it('one server and no server named: grants it, signs in for this authorization and goes to /callback', async () => {
    const b = build({ targets: ONE });
    const res = makeRes();
    await b.controller.completeSsoSignIn(b.req(), res, PERSON);

    expect(b.grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-1']);
    expect(res._redirect).toBe('http://mcp.example.test/callback');
    const profile = JSON.parse(Buffer.from(res._cookies['login_user'].value, 'base64url').toString('utf8'));
    expect(profile).toMatchObject({ id: 'u1', email: 'person@example.com' });
    expect(res._cookies['login_user'].options).toMatchObject({ signed: true, httpOnly: true, maxAge: 60_000 });
    // Bound to the pending authorization it was made for.
    expect(res._cookies['login_bind'].value).toBe('s1');
    // Remembered for the setup links, like every other sign-in on the page.
    expect(res._cookies['amcp_signin']).toBeDefined();
  });

  it('several servers and none named: shows "Choose what to connect" and issues nothing yet', async () => {
    const b = build({ targets: TWO });
    const res = makeRes();
    await b.controller.completeSsoSignIn(b.req(), res, PERSON);

    expect(res._redirect).toBeUndefined();
    expect(res._sent).toContain('action="/auth/select-servers"');
    expect(b.grants.grantServers).not.toHaveBeenCalled();
    expect(b.grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(res._cookies['pending_grant'].value).toBe('u1');
  });

  it('a server named by URL: grants that server, no picker', async () => {
    const b = build({ targets: TWO, server: { id: 'srv-2', organizationId: 'org-a' } });
    const res = makeRes();
    await b.controller.completeSsoSignIn(b.req(), res, PERSON);

    // Added to what this client was already allowed, not put in its place.
    expect(b.grants.grantRequestedServer).toHaveBeenCalledWith('client-1', 'u1', 'srv-2');
    expect(b.grants.grantServers).not.toHaveBeenCalled();
    expect(b.grants.listSelectableTargets).not.toHaveBeenCalled();
    expect(res._redirect).toBe('http://mcp.example.test/callback');
  });

  it('a server of a workspace the person does not belong to: refused, no cookie, no grant', async () => {
    const b = build({ server: { id: 'srv-x', organizationId: 'org-x' }, member: false, primaryOrg: 'org-a' });
    const res = makeRes();
    await b.controller.completeSsoSignIn(b.req(), res, PERSON);

    expect(res._redirect).toBe('/auth/login?switch=1&error=wrongWorkspace');
    expect(res._cookies['login_user']).toBeUndefined();
    expect(b.grants.grantServers).not.toHaveBeenCalled();
    expect(b.grants.grantRequestedServer).not.toHaveBeenCalled();
  });

  it('records the sign-in with method sso', async () => {
    const b = build({ targets: ONE });
    await b.controller.completeSsoSignIn(b.req(), makeRes(), PERSON);
    await new Promise((resolve) => setImmediate(resolve));

    const signedIn = b.productEvents.log.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.event === 'authorization_signed_in');
    expect(signedIn).toMatchObject({ userId: 'u1', metadata: { method: 'sso', client: 'Claude' } });
  });

  it('tells whether an authorization is pending in this browser', async () => {
    const b = build();
    expect(await b.controller.hasPendingAuthorization(b.req())).toBe(true);
    const none = { headers: {}, cookies: {}, signedCookies: {} } as unknown as Request;
    expect(await b.controller.hasPendingAuthorization(none)).toBe(false);
    const gone = { headers: {}, cookies: { oauth_session: 'expired' }, signedCookies: {} } as unknown as Request;
    expect(await b.controller.hasPendingAuthorization(gone)).toBe(false);
  });
});
