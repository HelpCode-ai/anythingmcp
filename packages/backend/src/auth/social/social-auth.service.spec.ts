jest.mock('openid-client', () => ({
  randomState: () => 'state-1',
  randomNonce: () => 'nonce-1',
  randomPKCECodeVerifier: () => 'verifier-1',
  calculatePKCECodeChallenge: async () => 'challenge-1',
}));

import { createHash } from 'crypto';
import { SocialAuthError, SocialAuthService, safeReturnTo } from './social-auth.service';
import type { SocialProfile } from './social-providers';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const CALLBACK = 'https://cloud.example/auth/social/google/callback?code=c&state=state-1';

function makeAttempt(over: Record<string, unknown> = {}) {
  return {
    id: 'att1',
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
    provider: 'google',
    surface: 'DASHBOARD',
    browserBindingHash: sha('bind-token'),
    linkUserId: null,
    oauthSessionId: null,
    returnTo: '/',
    attribution: null,
    handoffCodeHash: null,
    resolvedUserId: null,
    isNewUser: false,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...over,
  };
}

function makeUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'ann@example.com',
    name: 'Ann',
    role: 'ADMIN',
    organizationId: 'o1',
    emailVerified: true,
    passwordHash: 'hash',
    passwordLoginDisabled: false,
    mcpRoleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function setup(opts: {
  profile?: Partial<SocialProfile>;
  attempt?: Record<string, unknown> | null;
  claimed?: number;
  identity?: any;
  owners?: any[];
  env?: Record<string, string>;
} = {}) {
  const profile: SocialProfile = {
    subject: 'sub-1',
    email: 'ann@example.com',
    emailVerified: true,
    name: 'Ann',
    ...opts.profile,
  };
  const adapter = {
    id: 'google',
    label: 'Google',
    authorizationUrl: jest.fn(async (_p: any) => new URL('https://accounts.google.com/o/oauth2/auth?x=1')),
    complete: jest.fn(async () => profile),
  };
  const providers = {
    get: jest.fn((id: unknown) => (id === 'google' ? adapter : null)),
    enabled: jest.fn(() => [{ id: 'google', name: 'Google' }]),
  };
  const calls: string[] = [];
  const attempt = opts.attempt === null ? null : makeAttempt(opts.attempt ?? {});
  const tx = {
    user: { update: jest.fn(async (_a: any) => ({})) },
    emailVerificationToken: { updateMany: jest.fn(async () => ({ count: 0 })) },
    passwordResetToken: { updateMany: jest.fn(async () => ({ count: 0 })) },
    socialIdentity: { create: jest.fn(async () => ({})) },
  };
  const prisma: any = {
    socialLoginAttempt: {
      create: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      updateMany: jest.fn(async () => ({ count: opts.claimed ?? 1 })),
      findUnique: jest.fn(async () => attempt),
      update: jest.fn(async () => ({})),
    },
    socialIdentity: {
      findUnique: jest.fn(async (args: any) => (args.where.provider_subject ? opts.identity ?? null : null)),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      delete: jest.fn(async () => ({})),
    },
    user: {
      findMany: jest.fn(async () => opts.owners ?? []),
      findUnique: jest.fn(async () => makeUser()),
    },
    organizationMember: { findFirst: jest.fn(async () => ({ userId: 'u1' })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const env = { ALLOW_OPEN_REGISTRATION: 'true', FRONTEND_URL: 'https://cloud.example', ...opts.env };
  const config = { get: (k: string) => (env as any)[k] };
  const accounts = {
    createPasswordlessAccount: jest.fn(async () => makeUser({ id: 'new1', passwordHash: null })),
    ensureCloudTrial: jest.fn(async () => {
      calls.push('trial');
    }),
    loginResponse: jest.fn(async (u: any) => ({ accessToken: 'jwt', user: { id: u.id } })),
  };
  const securityEvents = { log: jest.fn(async () => undefined) };
  const ssoEnforcement = { isPasswordLoginBlocked: jest.fn(async () => false) };
  const productEvents = {
    log: jest.fn(async () => {
      calls.push('attribution');
    }),
  };
  const adsSignup = {
    onEmailVerified: jest.fn(() => {
      calls.push('ads');
    }),
  };
  const service = new SocialAuthService(
    prisma,
    config as any,
    providers as any,
    accounts as any,
    securityEvents as any,
    ssoEnforcement as any,
    productEvents as any,
    adsSignup as any,
  );
  return { service, prisma, tx, adapter, accounts, securityEvents, productEvents, adsSignup, calls, ssoEnforcement };
}

const events = (log: jest.Mock) => log.mock.calls.map((c) => c[0].event);
const complete = (s: SocialAuthService, browser = { bindingToken: 'bind-token' }, url = CALLBACK) =>
  s.complete('google', new URL(url), browser);

describe('safeReturnTo', () => {
  it.each([
    ['/settings', '/settings'],
    ['https://evil.tld', '/'],
    ['//evil.tld', '/'],
    ['/\\evil.tld', '/'],
    [undefined, '/'],
  ])('%s → %s', (input, expected) => expect(safeReturnTo(input)).toBe(expected));
});

describe('SocialAuthService.start', () => {
  it('stores only a hash of the browser binding and returns the provider URL', async () => {
    const { service, prisma } = setup();
    const out = await service.start({ provider: 'google', surface: 'DASHBOARD', returnTo: '//evil' });
    expect(out.authorizationUrl).toContain('accounts.google.com');
    const data = prisma.socialLoginAttempt.create.mock.calls[0][0].data;
    expect(data.browserBindingHash).toBe(sha(out.bindingToken));
    expect(JSON.stringify(data)).not.toContain(out.bindingToken);
    expect(data.returnTo).toBe('/');
  });

  it('builds the redirect URI from configuration', async () => {
    const { service, adapter } = setup();
    await service.start({ provider: 'google', surface: 'DASHBOARD' });
    expect(adapter.authorizationUrl.mock.calls[0][0].redirectUri).toBe(
      'https://cloud.example/auth/social/google/callback',
    );
  });

  it('refuses a provider that is not enabled', async () => {
    const { service } = setup();
    await expect(service.start({ provider: 'facebook', surface: 'DASHBOARD' })).rejects.toBeInstanceOf(SocialAuthError);
  });

  it('refuses an MCP start without a pending authorization', async () => {
    const { service } = setup();
    await expect(service.start({ provider: 'google', surface: 'MCP' })).rejects.toMatchObject({
      reason: 'mcp_without_oauth_session',
    });
  });
});

describe('SocialAuthService.complete — the round trip', () => {
  it('refuses a replayed or expired state', async () => {
    const { service } = setup({ claimed: 0 });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'state_replayed_or_expired' });
  });

  it('refuses a callback finished in another browser', async () => {
    const { service, adapter } = setup();
    await expect(complete(service, { bindingToken: 'someone-else' })).rejects.toMatchObject({
      reason: 'browser_binding_mismatch',
    });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('refuses a callback on another provider path', async () => {
    const { service } = setup({ attempt: { provider: 'github' } });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'provider_mismatch' });
  });

  it('binds the MCP surface to the pending authorization', async () => {
    const { service } = setup({ attempt: { surface: 'MCP', oauthSessionId: 'sess-a' } });
    await expect(
      service.complete('google', new URL(CALLBACK), { bindingToken: 'bind-token', oauthSessionId: 'sess-b' }),
    ).rejects.toMatchObject({ reason: 'mcp_session_binding_mismatch', surface: 'MCP' });
  });

  it('turns a cancelled consent into a friendly message', async () => {
    const { service } = setup();
    await expect(complete(service, undefined, `${CALLBACK}&error=access_denied`)).rejects.toMatchObject({
      userMessage: 'Sign-in was cancelled.',
    });
  });

  it('ends a dashboard sign-in with a one-time code, never a token', async () => {
    const { service, prisma } = setup({ identity: { id: 'i1', user: makeUser() } });
    const out = await complete(service);
    expect(out.kind).toBe('LOGIN');
    const data = prisma.socialLoginAttempt.update.mock.calls[0][0].data;
    expect(data.handoffCodeHash).toBe(sha((out as any).handoffCode));
    expect(data.resolvedUserId).toBe('u1');
  });

  it('ends an MCP sign-in with the user, for the consent page to finish', async () => {
    const { service } = setup({
      attempt: { surface: 'MCP', oauthSessionId: 'sess' },
      identity: { id: 'i1', user: makeUser() },
    });
    await expect(
      service.complete('google', new URL(CALLBACK), { bindingToken: 'bind-token', oauthSessionId: 'sess' }),
    ).resolves.toEqual({ kind: 'MCP', provider: 'google', user: { id: 'u1', email: 'ann@example.com', name: 'Ann' } });
  });
});

describe('SocialAuthService — account resolution', () => {
  it('signs a known provider account in, whatever its email says now', async () => {
    const { service, accounts } = setup({
      identity: { id: 'i1', user: makeUser() },
      profile: { email: 'changed@else.com', emailVerified: false },
    });
    await expect(complete(service)).resolves.toMatchObject({ kind: 'LOGIN' });
    expect(accounts.createPasswordlessAccount).not.toHaveBeenCalled();
  });

  it('refuses a known account that its organization keeps on SSO', async () => {
    const { service, ssoEnforcement } = setup({ identity: { id: 'i1', user: makeUser() } });
    ssoEnforcement.isPasswordLoginBlocked.mockResolvedValue(true);
    await expect(complete(service)).rejects.toMatchObject({ reason: 'idp_enforced' });
  });

  it('refuses a first sign-in without an email', async () => {
    const { service } = setup({ profile: { email: null, emailVerified: false } });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'provider_no_email' });
  });

  it('refuses a first sign-in whose email the provider does not vouch for', async () => {
    const { service, accounts, prisma } = setup({ profile: { emailVerified: false }, owners: [makeUser()] });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'email_not_verified_by_provider' });
    expect(accounts.createPasswordlessAccount).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a workspace for a new verified address', async () => {
    const { service, accounts, prisma, securityEvents } = setup();
    const out = await complete(service);
    expect(out.kind).toBe('LOGIN');
    expect(accounts.createPasswordlessAccount).toHaveBeenCalledWith({
      email: 'ann@example.com',
      name: 'Ann',
      emailVerified: true,
    });
    expect(prisma.socialIdentity.create.mock.calls[0][0].data).toMatchObject({
      provider: 'google',
      subject: 'sub-1',
      userId: 'new1',
    });
    expect(events(securityEvents.log)).toEqual(['SOCIAL_SIGNUP', 'SOCIAL_LOGIN_SUCCESS']);
    expect(prisma.socialLoginAttempt.update.mock.calls[0][0].data.isNewUser).toBe(true);
  });

  it('records the attribution before reporting the ad sign-up', async () => {
    const { service, calls } = setup({ attempt: { attribution: { first_touch: { utm_source: 'x' } } } });
    await complete(service);
    expect(calls).toEqual(['attribution', 'ads']);
  });

  it('starts the trial itself only on the MCP page', async () => {
    const dash = setup();
    await complete(dash.service);
    expect(dash.accounts.ensureCloudTrial).not.toHaveBeenCalled();

    const mcp = setup({ attempt: { surface: 'MCP', oauthSessionId: 's' } });
    await mcp.service.complete('google', new URL(CALLBACK), { bindingToken: 'bind-token', oauthSessionId: 's' });
    expect(mcp.accounts.ensureCloudTrial).toHaveBeenCalledWith('new1');
  });

  it('refuses a throwaway address', async () => {
    const { service } = setup({ profile: { email: 'x@mailinator.com' } });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'disposable_email' });
  });

  it('refuses a new account when registration is closed', async () => {
    const { service } = setup({ env: { ALLOW_OPEN_REGISTRATION: 'false' } });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'registration_closed' });
  });

  it('attaches to the verified account that owns the address', async () => {
    const { service, tx, accounts, securityEvents } = setup({ owners: [makeUser()] });
    await complete(service);
    expect(tx.socialIdentity.create).toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(accounts.createPasswordlessAccount).not.toHaveBeenCalled();
    expect(events(securityEvents.log)).toContain('SOCIAL_IDENTITY_LINKED');
  });

  it('reclaims an account whose address was never verified', async () => {
    const { service, tx, securityEvents, accounts } = setup({ owners: [makeUser({ emailVerified: false })] });
    await complete(service);
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
      passwordHash: null,
      emailVerified: true,
      sessionsValidFrom: expect.any(Date),
    });
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalled();
    expect(events(securityEvents.log)).toContain('SOCIAL_ACCOUNT_RECLAIMED');
    expect(accounts.ensureCloudTrial).toHaveBeenCalledWith('u1');
  });

  it('refuses an address with several legacy accounts', async () => {
    const { service } = setup({ owners: [makeUser(), makeUser({ id: 'u2' })] });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'ambiguous_email' });
  });
});

describe('SocialAuthService.exchange', () => {
  it('returns the login response once', async () => {
    const { service, prisma } = setup({
      attempt: { handoffCodeHash: sha('code'), resolvedUserId: 'u1', isNewUser: true },
    });
    await expect(service.exchange('code')).resolves.toMatchObject({ accessToken: 'jwt', isNewUser: true });
    prisma.socialLoginAttempt.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.exchange('code')).rejects.toMatchObject({ reason: 'handoff_invalid_or_expired' });
  });

  it('refuses an expired code', async () => {
    const { service } = setup({
      attempt: { resolvedUserId: 'u1', expiresAt: new Date(Date.now() - 1) },
    });
    await expect(service.exchange('code')).rejects.toBeInstanceOf(SocialAuthError);
  });
});

describe('SocialAuthService — connected accounts', () => {
  it('links a provider account to the signed-in user', async () => {
    const { service, prisma } = setup({ attempt: { surface: 'LINK', linkUserId: 'u1', returnTo: '/settings' } });
    await expect(complete(service)).resolves.toEqual({ kind: 'LINK', returnTo: '/settings', provider: 'google' });
    expect(prisma.socialIdentity.create.mock.calls[0][0].data).toMatchObject({ userId: 'u1', subject: 'sub-1' });
  });

  it('refuses a provider account already linked to someone else', async () => {
    const { service } = setup({
      attempt: { surface: 'LINK', linkUserId: 'u1' },
      identity: { id: 'i9', userId: 'other', user: makeUser({ id: 'other' }) },
    });
    await expect(complete(service)).rejects.toMatchObject({ reason: 'identity_linked_to_another_user' });
  });

  it('refuses to unlink the last way into an account', async () => {
    const { service, prisma } = setup();
    prisma.socialIdentity.findUnique.mockResolvedValue({ id: 'i1', provider: 'google' });
    prisma.user.findUnique.mockResolvedValue({ passwordHash: null, organizationId: 'o1' });
    await expect(service.unlink('u1', 'google')).rejects.toMatchObject({ reason: 'would_lock_account_out' });
    expect(prisma.socialIdentity.delete).not.toHaveBeenCalled();
  });

  it('unlinks when a password remains', async () => {
    const { service, prisma } = setup();
    prisma.socialIdentity.findUnique.mockResolvedValue({ id: 'i1', provider: 'google' });
    prisma.user.findUnique.mockResolvedValue({ passwordHash: 'h', organizationId: 'o1' });
    await service.unlink('u1', 'google');
    expect(prisma.socialIdentity.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
  });
});
