// `openid-client` v6 is ESM-only. Jest transforms this suite to CommonJS and
// cannot parse it, and these tests do not exercise the network half anyway —
// discovery and the token exchange belong to the library and are covered by the
// end-to-end run against a real tenant.
jest.mock('openid-client', () => ({}));

import { SsoService, SsoError } from './sso.service';

/**
 * These tests exercise the validation and identity-resolution logic directly.
 * The network half (discovery, token exchange) belongs to openid-client and is
 * covered by the end-to-end run against a real tenant.
 */
describe('SsoService', () => {
  let service: any;
  let prisma: any;
  let securityEvents: { log: jest.Mock };

  const provider = {
    id: 'p1',
    type: 'ENTRA',
    issuer: 'https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffff11112222/v2.0',
    organizationId: 'org-1',
    jitProvisioning: false,
    jitDefaultRole: 'VIEWER',
    config: { tenantId: 'aaaabbbb-cccc-dddd-eeee-ffff11112222' },
  };

  const goodClaims = {
    iss: provider.issuer,
    tid: 'aaaabbbb-cccc-dddd-eeee-ffff11112222',
    oid: 'a-stable-object-id',
    sub: 'pairwise-subject',
    email: 'user@kochfreiburg.de',
    acct: 0,
  };

  beforeEach(() => {
    prisma = {
      userIdentity: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn(), create: jest.fn() },
      organizationMember: { create: jest.fn() },
      ssoLoginAttempt: { updateMany: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    securityEvents = { log: jest.fn() };
    service = new SsoService(
      prisma,
      { get: () => 'http://localhost:3000' } as any,
      { isSelfHosted: () => true, isCloud: () => false, mode: 'self-hosted' } as any,
      { getClientSecret: jest.fn() } as any,
      { generateToken: jest.fn(() => 'jwt') } as any,
      securityEvents as any,
    );
  });

  const check = (claims: Record<string, any>, p = provider) =>
    service.assertClaimsAcceptable(p, claims);

  describe('claim validation', () => {
    it('accepts a member of the configured tenant', () => {
      expect(() => check(goodClaims)).not.toThrow();
    });

    it('rejects a token from a different tenant', () => {
      // openid-client already checked the signature and issuer. This is the
      // tenant policy, which is ours: a token from another directory must not
      // be able to sign in here even though it is perfectly valid.
      expect(() => check({ ...goodClaims, tid: 'ffffffff-0000-0000-0000-000000000000' }))
        .toThrow(expect.objectContaining({ reason: 'tid_mismatch' }));
    });

    it('rejects the personal-account tenant', () => {
      const msa = '9188040d-6c67-4c5b-b112-36a304b66dad';
      expect(() =>
        check({ ...goodClaims, tid: msa }, { ...provider, config: { tenantId: msa } } as any),
      ).toThrow(expect.objectContaining({ reason: 'msa_tenant' }));
    });

    it.each([
      ['acct === 1', { acct: 1 }, 'guest_account'],
      ['an external idp', { idp: 'https://sts.windows.net/other/' }, 'guest_external_idp'],
      ['an #EXT# UPN', { preferred_username: 'victim_gmail.com#EXT#@koch.onmicrosoft.com' }, 'guest_ext_upn'],
    ])('rejects a B2B guest identified by %s', (_l, extra, reason) => {
      // A tenant admin can invite ANY address as a guest, so a guest token
      // carries an email the inviting tenant does not own. That is exactly the
      // primitive behind nOAuth.
      expect(() => check({ ...goodClaims, ...extra })).toThrow(
        expect.objectContaining({ reason }),
      );
    });

    it('rejects a token with no subject at all', () => {
      const { oid, sub, ...rest } = goodClaims;
      expect(() => check(rest)).toThrow(
        expect.objectContaining({ reason: 'missing_subject' }),
      );
    });
  });

  describe('identity resolution', () => {
    const resolve = (p = provider) =>
      service.resolveUser(p, 'a-stable-object-id', goodClaims.tid, goodClaims, {});

    it('returns the user behind a known identity', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ id: 'i1', userId: 'u1' });
      expect(await resolve()).toBe('u1');
      expect(prisma.userIdentity.update).toHaveBeenCalled();
    });

    it('keys the lookup on (provider, subject) — never the email', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ id: 'i1', userId: 'u1' });
      await resolve();

      expect(prisma.userIdentity.findUnique).toHaveBeenCalledWith({
        where: {
          providerId_externalSubject: {
            providerId: 'p1',
            externalSubject: 'a-stable-object-id',
          },
        },
        select: { id: true, userId: true },
      });
      // The users table is never consulted by email on the known-identity path.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses an unknown identity when JIT is off', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      await expect(resolve()).rejects.toThrow(
        expect.objectContaining({ reason: 'no_identity_and_jit_disabled' }),
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('refuses to claim an existing account that owns the email', async () => {
      // THE takeover this design exists to prevent: anyone who controls any
      // tenant could otherwise assert a victim's address and be handed their
      // account. Linking must be a deliberate, authenticated action.
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ id: 'victim' });

      await expect(resolve({ ...provider, jitProvisioning: true })).rejects.toThrow(
        expect.objectContaining({ reason: 'email_belongs_to_existing_account' }),
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('provisions a passwordless VIEWER when JIT is on', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'new-user' });

      expect(await resolve({ ...provider, jitProvisioning: true })).toBe('new-user');

      const created = prisma.user.create.mock.calls[0][0].data;
      // No password: the account exists only through the provider, so there is
      // no second way in that bypasses its MFA and Conditional Access.
      expect(created.passwordHash).toBeNull();
      expect(created.role).toBe('VIEWER');
      expect(created.organizationId).toBe('org-1');
      expect(prisma.organizationMember.create).toHaveBeenCalled();
      expect(prisma.userIdentity.create).toHaveBeenCalled();
    });
  });

  describe('returnTo', () => {
    it.each([
      ['an absolute URL', 'https://evil.tld'],
      ['a protocol-relative URL', '//evil.tld'],
      ['a backslash variant', '/\\evil.tld'],
      ['a bare word', 'evil'],
    ])('refuses %s', (_l, value) => {
      expect(service.safeReturnTo(value)).toBe('/');
    });

    it('keeps an internal path', () => {
      expect(service.safeReturnTo('/connectors/abc')).toBe('/connectors/abc');
    });
  });

  describe('handoff exchange', () => {
    it('refuses an expired code', async () => {
      prisma.ssoLoginAttempt.findUnique.mockResolvedValue({
        id: 'a1',
        resolvedUserId: 'u1',
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.exchange('code')).rejects.toThrow(
        expect.objectContaining({ reason: 'handoff_invalid_or_expired' }),
      );
    });

    it('refuses a code for an attempt that never completed', async () => {
      prisma.ssoLoginAttempt.findUnique.mockResolvedValue({
        id: 'a1',
        resolvedUserId: null,
        expiresAt: new Date(Date.now() + 10_000),
      });
      await expect(service.exchange('code')).rejects.toThrow(SsoError);
    });
  });

  describe('linking an identity to an existing account', () => {
    const attempt = { id: 'a1', linkUserId: 'u1', returnTo: '/settings' };
    const link = (over: Record<string, any> = {}) =>
      service.completeLink(
        { ...attempt, ...over },
        { id: 'p1', organizationId: 'org-1' },
        'oid-123',
        'tid-1',
        {},
      );

    beforeEach(() => {
      prisma.organizationMember.findFirst = jest.fn().mockResolvedValue({ id: 'm1' });
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.userIdentity.count = jest.fn().mockResolvedValue(0);
      prisma.userIdentity.delete = jest.fn();
    });

    it('links the identity to the user captured when the flow started', async () => {
      await link();
      expect(prisma.userIdentity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'u1', externalSubject: 'oid-123' }),
        }),
      );
    });

    it('refuses a LINK attempt carrying no user instead of signing someone in', async () => {
      // Falling through to the sign-in path here would authenticate whoever
      // completed the round trip, which is the whole attack this flow avoids.
      await expect(link({ linkUserId: null })).rejects.toThrow(
        expect.objectContaining({ reason: 'link_without_user' }),
      );
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('re-checks membership on return, not only at start', async () => {
      // The round trip takes minutes. A member removed in between must not
      // still be able to attach an identity to the workspace.
      prisma.organizationMember.findFirst.mockResolvedValue(null);
      await expect(link()).rejects.toThrow(
        expect.objectContaining({ reason: 'not_a_member' }),
      );
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it("refuses to steal an identity already linked to somebody else", async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: 'someone-else' });
      await expect(link()).rejects.toThrow(
        expect.objectContaining({ reason: 'identity_already_linked_to_another_user' }),
      );
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('is idempotent when the same user re-links the same identity', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: 'u1' });
      await expect(link()).resolves.toBe('/settings');
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('refuses a second directory account at the same provider', async () => {
      // Replacing it silently would change who can sign in as this user
      // without ever telling them.
      prisma.userIdentity.findUnique
        .mockResolvedValueOnce(null) // by (provider, subject)
        .mockResolvedValueOnce({ externalSubject: 'a-different-oid' }); // by (user, provider)
      await expect(link()).rejects.toThrow(
        expect.objectContaining({ reason: 'user_already_linked_at_provider' }),
      );
      expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    });
  });

  describe('unlinking', () => {
    beforeEach(() => {
      prisma.userIdentity.count = jest.fn().mockResolvedValue(0);
      prisma.userIdentity.delete = jest.fn();
      prisma.userIdentity.findUnique.mockResolvedValue({
        id: 'i1',
        externalSubject: 'oid-123',
        provider: { organizationId: 'org-1' },
      });
    });

    it('refuses when it would leave the account with no way to sign in', async () => {
      // A JIT-provisioned user has no password. Unlinking their only identity
      // would report success and lock them out permanently.
      prisma.user.findUnique.mockResolvedValue({
        passwordHash: null,
        passwordLoginDisabled: false,
      });
      await expect(service.unlink('u1', 'p1', {})).rejects.toThrow(
        expect.objectContaining({ reason: 'would_lock_account_out' }),
      );
      expect(prisma.userIdentity.delete).not.toHaveBeenCalled();
    });

    it('refuses when a password exists but password sign-in is disabled', async () => {
      // Having a hash is not the same as being able to use it.
      prisma.user.findUnique.mockResolvedValue({
        passwordHash: 'hash',
        passwordLoginDisabled: true,
      });
      await expect(service.unlink('u1', 'p1', {})).rejects.toThrow(
        expect.objectContaining({ reason: 'would_lock_account_out' }),
      );
    });

    it('allows it when a usable password remains', async () => {
      prisma.user.findUnique.mockResolvedValue({
        passwordHash: 'hash',
        passwordLoginDisabled: false,
      });
      await service.unlink('u1', 'p1', {});
      expect(prisma.userIdentity.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
    });

    it('allows it when another provider is still connected', async () => {
      prisma.user.findUnique.mockResolvedValue({
        passwordHash: null,
        passwordLoginDisabled: false,
      });
      prisma.userIdentity.count.mockResolvedValue(1);
      await service.unlink('u1', 'p1', {});
      expect(prisma.userIdentity.delete).toHaveBeenCalled();
    });
  });

  describe('audit de-duplication', () => {
    it('marks the rejections it has already logged, so the controller does not log them twice', async () => {
      // Observed live: one refused sign-in produced TWO SSO_LOGIN_FAILED rows,
      // the service's (with organization, provider and oid) and the
      // controller's (with only the reason). An auditor counting refusals
      // would have double-counted every one of them.
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      const err = await service
        .resolveUser(provider, 'oid-1', 'tid-1', goodClaims, {})
        .catch((e: any) => e);

      expect(err.reason).toBe('no_identity_and_jit_disabled');
      expect(err.audited).toBe(true);
      expect(securityEvents.log).toHaveBeenCalledTimes(1);
    });

    it('leaves rejections it did NOT log unmarked, so they still reach the trail', async () => {
      // The controller is the only writer for these; marking them by mistake
      // would make the refusal vanish from the audit trail entirely.
      const err = new SsoError('state_replayed_or_expired');
      expect(err.audited).toBe(false);
    });
  });

  describe('the MCP authorization surface', () => {
    const attempt = {
      id: 'a1',
      surface: 'MCP',
      oauthSessionId: 'oauth-session-abc',
      returnTo: null,
      linkUserId: null,
    };

    const bind = (attemptSession: string | null, cookieSession?: string) =>
      service.assertMcpBinding(
        { oauthSessionId: attemptSession },
        { id: 'p1', organizationId: 'org-1' },
        'oid-1',
        { oauthSessionId: cookieSession },
      );

    it('accepts a return from the browser that started the authorization', async () => {
      await expect(bind('sess-1', 'sess-1')).resolves.toBeUndefined();
    });

    it('refuses a return carrying a DIFFERENT OAuth session', async () => {
      // The attack this exists to stop: an attacker opens an authorization on
      // their own machine, gets the victim to finish the identity-provider leg,
      // and ends up holding a token for the victim's workspace.
      await expect(bind('sess-attacker', 'sess-victim')).rejects.toThrow(
        expect.objectContaining({ reason: 'mcp_session_binding_mismatch' }),
      );
    });

    it('refuses a return carrying NO OAuth session', async () => {
      // Dropping the cookie must not be a way to skip the check.
      await expect(bind('sess-1', undefined)).rejects.toThrow(
        expect.objectContaining({ reason: 'mcp_session_binding_mismatch' }),
      );
    });

    it('refuses when the attempt recorded no session either', async () => {
      // Two missing values must not compare equal and wave the request through.
      await expect(bind(null, undefined)).rejects.toThrow(
        expect.objectContaining({ reason: 'mcp_session_binding_mismatch' }),
      );
    });

    it('audits the mismatch once, with the provider and subject attached', async () => {
      await bind('sess-attacker', 'sess-victim').catch(() => {});
      expect(securityEvents.log).toHaveBeenCalledTimes(1);
      expect(securityEvents.log.mock.calls[0][0].metadata).toMatchObject({
        reason: 'mcp_session_binding_mismatch',
        surface: 'MCP',
        providerId: 'p1',
        oid: 'oid-1',
      });
    });

    it('refuses to start without a pending OAuth session', async () => {
      // Without one there is nothing to bind the returning identity to, so the
      // result could be attached to any authorization that happens to be open.
      await expect(service.startMcp('p1', '')).rejects.toThrow(
        expect.objectContaining({ reason: 'mcp_without_oauth_session' }),
      );
    });

    it('refuses a provider that is inactive or unknown', async () => {
      prisma.identityProvider = { findUnique: jest.fn().mockResolvedValue(null) };
      await expect(service.startMcp('p1', 'oauth-session-abc')).rejects.toThrow(
        expect.objectContaining({ reason: 'unknown_or_inactive_provider' }),
      );
    });

    it('records the OAuth session on the attempt so the callback can assert it', async () => {
      prisma.identityProvider = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          type: 'ENTRA',
          issuer: provider.issuer,
          clientId: 'c',
          isActive: true,
          organizationId: 'org-1',
          config: provider.config,
        }),
      };
      prisma.ssoLoginAttempt.create = jest.fn();
      // The network half is mocked away; we only care about what gets stored.
      service.beginAuthorization = jest.fn(async (_p: any, opts: any) => {
        await prisma.ssoLoginAttempt.create({ data: { surface: opts.surface, oauthSessionId: opts.oauthSessionId } });
        return { authorizationUrl: 'https://idp.example/authorize' };
      });

      await service.startMcp('p1', 'oauth-session-abc');

      expect(prisma.ssoLoginAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            surface: 'MCP',
            oauthSessionId: 'oauth-session-abc',
          }),
        }),
      );
    });
  });

  describe('starting a link', () => {
    it('refuses a provider belonging to another workspace', async () => {
      // `identityProvider.id` is a cuid, not the opaque initiateId, so it is
      // guessable — membership is what stops a cross-workspace link.
      prisma.identityProvider = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          type: 'ENTRA',
          issuer: provider.issuer,
          clientId: 'c',
          isActive: true,
          organizationId: 'org-2',
          config: provider.config,
        }),
      };
      prisma.organizationMember.findFirst = jest.fn().mockResolvedValue(null);

      await expect(service.startLink('u1', 'p1')).rejects.toThrow(
        expect.objectContaining({ reason: 'not_a_member' }),
      );
    });
  });
});
