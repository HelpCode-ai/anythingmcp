import { McpCombinedAuthGuard } from './mcp-combined-auth.guard';

describe('McpCombinedAuthGuard', () => {
  let guard: McpCombinedAuthGuard;
  let mockConfig: any;
  let mockAuth: any;
  let mockApiKeys: any;
  let mockPrisma: any;

  const mockContext = (headers: Record<string, string> = {}) => {
    const request = { headers, user: undefined as any };
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as any;
  };

  beforeEach(() => {
    mockConfig = { get: jest.fn() };
    mockAuth = { verifyToken: jest.fn() };
    mockApiKeys = { resolveUserByKey: jest.fn() };
    mockPrisma = {
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    guard = new McpCombinedAuthGuard(
      mockConfig,
      mockAuth,
      mockApiKeys,
      mockPrisma,
    );
  });

  describe('organization resolution for JWT/OAuth tokens', () => {
    it('keeps organizationId from an app JWT, and still loads the user for revocation', async () => {
      // The old zero-query fast path was given up deliberately: revocation
      // needs `sessionsValidFrom`, and skipping the lookup here would leave a
      // dashboard JWT presented to /mcp unrevocable, since JwtStrategy (which
      // does check) never runs on this route.
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u1',
        email: 'a@b.com',
        role: 'ADMIN',
        organizationId: 'org-A',
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        organizationId: 'org-A',
        email: 'a@b.com',
        role: 'ADMIN',
        sessionsValidFrom: null,
      });

      const ctx = mockContext({ authorization: 'Bearer app-jwt' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      // The claim still wins for the org — the lookup is only for revocation.
      expect(ctx.switchToHttp().getRequest().user.organizationId).toBe('org-A');
    });

    it('rejects a token issued before the user revocation cutover', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u1',
        email: 'a@b.com',
        role: 'ADMIN',
        organizationId: 'org-A',
        iat: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        organizationId: 'org-A',
        email: 'a@b.com',
        role: 'ADMIN',
        // Password changed after the token was minted.
        sessionsValidFrom: new Date('2026-06-01T00:00:00Z'),
      });

      const ctx = mockContext({ authorization: 'Bearer stale-jwt' });
      expect(await guard.canActivate(ctx)).toBe(false);
    });

    it('accepts a token issued after the revocation cutover', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u1',
        email: 'a@b.com',
        role: 'ADMIN',
        organizationId: 'org-A',
        iat: Math.floor(new Date('2026-06-02T00:00:00Z').getTime() / 1000),
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        organizationId: 'org-A',
        email: 'a@b.com',
        role: 'ADMIN',
        sessionsValidFrom: new Date('2026-06-01T00:00:00Z'),
      });

      const ctx = mockContext({ authorization: 'Bearer fresh-jwt' });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('resolves organizationId from the user record for an OAuth token whose sub is a cuid', async () => {
      mockConfig.get.mockReturnValue(undefined);
      // OAuth access token shape: sub + user_data, NO organizationId claim.
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u-finance',
        type: 'access',
        user_data: { id: 'u-finance', email: 'finance@helpcode.ai' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-finance',
        organizationId: 'org-B',
        email: 'finance@helpcode.ai',
        role: 'ADMIN',
      });

      const ctx = mockContext({ authorization: 'Bearer oauth-token' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      // Resolved by primary key only — the user_data.email is NOT a candidate.
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u-finance' },
        select: {
          id: true,
          organizationId: true,
          email: true,
          role: true,
          sessionsValidFrom: true,
        },
      });
      expect(ctx.switchToHttp().getRequest().user.organizationId).toBe('org-B');
    });

    it('resolves a LEGACY token whose sub is an email via its stored profile', async () => {
      // Tokens minted before `sub` became the cuid carry the email there, but
      // they also carry `user_profile_id`, and oauth_user_profiles.external_id
      // has always held the cuid. Resolving through that keeps already-issued
      // sessions working WITHOUT an email-keyed lookup — no forced re-auth.
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'owner@example.com',
        type: 'access',
        user_profile_id: 'local:cmpzj8mm9007j1ymn5mo2y3eq',
        user_data: { email: 'owner@example.com' },
      });
      mockPrisma.oAuthUserProfile.findUnique.mockResolvedValue({
        externalId: 'cmpzj8mm9007j1ymn5mo2y3eq',
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'cmpzj8mm9007j1ymn5mo2y3eq',
        organizationId: 'org-legacy',
        email: 'owner@example.com',
        role: 'ADMIN',
      });

      const ctx = mockContext({ authorization: 'Bearer legacy-token' });
      expect(await guard.canActivate(ctx)).toBe(true);

      expect(mockPrisma.oAuthUserProfile.findUnique).toHaveBeenCalledWith({
        where: { profileId: 'local:cmpzj8mm9007j1ymn5mo2y3eq' },
        select: { externalId: true },
      });
      const u = ctx.switchToHttp().getRequest().user;
      expect(u.organizationId).toBe('org-legacy');
      expect(u.sub).toBe('cmpzj8mm9007j1ymn5mo2y3eq');
    });

    it('does NOT resolve a user from the token email claim', async () => {
      // SECURITY regression guard. `user_data` is the stored OAuth profile
      // copied verbatim into the signed token. If the guard matched its email
      // against users.email, anyone able to influence that profile — an
      // external IdP, once SSO lands — could mint a token bearing a victim's
      // address and inherit the victim's organization. With no recoverable
      // profile, an email-shaped `sub` must fail closed rather than fall back.
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'victim@example.com',
        type: 'access',
        user_data: { email: 'victim@example.com' },
      });
      mockPrisma.oAuthUserProfile.findUnique.mockResolvedValue(null);

      const ctx = mockContext({ authorization: 'Bearer forged-token' });
      await guard.canActivate(ctx);

      // The users table is never queried by email — in fact not at all here.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      // No org inherited → the per-server tenant check downstream fails closed.
      expect(
        ctx.switchToHttp().getRequest().user.organizationId,
      ).toBeUndefined();
    });

    it('never queries users by email', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u-1',
        type: 'access',
        email: 'someone@example.com',
        user_data: { email: 'other@example.com' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        organizationId: 'org-A',
        email: 'u1@example.com',
        role: 'EDITOR',
      });

      await guard.canActivate(mockContext({ authorization: 'Bearer t' }));

      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      for (const call of mockPrisma.user.findUnique.mock.calls) {
        expect(JSON.stringify(call[0].where)).not.toContain('email');
      }
    });

    it('leaves organizationId undefined when the user cannot be resolved (fail closed downstream)', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({ sub: 'ghost', user_data: {} });
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const ctx = mockContext({ authorization: 'Bearer oauth-token' });
      await guard.canActivate(ctx);

      expect(
        ctx.switchToHttp().getRequest().user.organizationId,
      ).toBeUndefined();
    });
  });

  describe('legacy mode with no credentials (fail closed)', () => {
    const legacyNoCreds = (allowAnon?: string) =>
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_AUTH_MODE') return 'legacy';
        if (key === 'MCP_ALLOW_ANONYMOUS') return allowAnon;
        return undefined; // MCP_API_KEY / MCP_BEARER_TOKEN unset
      });

    it('refuses anonymous access by default', async () => {
      legacyNoCreds(undefined);
      const ctx = mockContext({});
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
      expect(ctx.switchToHttp().getResponse().status).toHaveBeenCalledWith(401);
    });

    it('allows anonymous access only when MCP_ALLOW_ANONYMOUS=true', async () => {
      legacyNoCreds('true');
      const ctx = mockContext({});
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().user.authMethod).toBe('none');
    });
  });

  describe('public demo endpoint exemption (/mcp/demo)', () => {
    const ctxWithPath = (path: string) => {
      const request = { headers: {}, path, user: undefined as any };
      const response = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      return {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as any;
    };

    // Strictest fail-closed config: legacy mode, no creds, anon NOT allowed.
    const strict = () =>
      mockConfig.get.mockImplementation((key: string) =>
        key === 'MCP_AUTH_MODE' ? 'legacy' : undefined,
      );

    it('allows anonymous access to the EXACT /mcp/demo path, with no DB lookup', async () => {
      strict();
      const ctx = ctxWithPath('/mcp/demo');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().user.authMethod).toBe('none');
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('ignores trailing slash and query string but stays exact', async () => {
      strict();
      const ok = await guard.canActivate(ctxWithPath('/mcp/demo/'));
      expect(ok).toBe(true);
    });

    it('does NOT exempt a real server id — /mcp/:serverId stays fail-closed', async () => {
      strict();
      const ctx = ctxWithPath('/mcp/cmpzj8mm9007j1ymn5mo2y3eq');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
      expect(ctx.switchToHttp().getResponse().status).toHaveBeenCalledWith(401);
    });

    it('does NOT exempt a look-alike path containing demo', async () => {
      strict();
      const result = await guard.canActivate(ctxWithPath('/mcp/demo-evil'));
      expect(result).toBe(false);
    });
  });
});
