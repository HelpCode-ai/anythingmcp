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
    mockPrisma = { user: { findUnique: jest.fn(), findFirst: jest.fn() } };
    guard = new McpCombinedAuthGuard(
      mockConfig,
      mockAuth,
      mockApiKeys,
      mockPrisma,
    );
  });

  describe('organization resolution for JWT/OAuth tokens', () => {
    it('keeps organizationId from an app JWT without a DB lookup', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u1',
        email: 'a@b.com',
        role: 'ADMIN',
        organizationId: 'org-A',
      });

      const ctx = mockContext({ authorization: 'Bearer app-jwt' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(ctx.switchToHttp().getRequest().user.organizationId).toBe('org-A');
    });

    it('resolves organizationId from the user record for an OAuth token whose sub is a cuid', async () => {
      mockConfig.get.mockReturnValue(undefined);
      // OAuth access token shape: sub + user_data, NO organizationId claim.
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u-finance',
        type: 'access',
        user_data: { id: 'u-finance', email: 'finance@helpcode.ai' },
      });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'u-finance',
        organizationId: 'org-B',
        email: 'finance@helpcode.ai',
        role: 'ADMIN',
      });

      const ctx = mockContext({ authorization: 'Bearer oauth-token' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      // Resolves by id OR email — the user_data.email is also a candidate.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ id: 'u-finance' }, { email: 'finance@helpcode.ai' }],
        },
        select: { id: true, organizationId: true, email: true, role: true },
      });
      expect(ctx.switchToHttp().getRequest().user.organizationId).toBe('org-B');
    });

    it('resolves organizationId when the OAuth token sub IS the email (rekog/mcp-nest)', async () => {
      // Regression test for the production 403 incident: rekog signs `sub`
      // with the email, not the users.id cuid. The guard must still resolve
      // the org (by email) so legitimate owners are not locked out.
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({
        sub: 'jjstrick9@gmail.com',
        type: 'access',
        user_data: {},
      });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'cmpzj8mm9007j1ymn5mo2y3eq',
        organizationId: 'cmpzj8mds007i1ymntpyjngdp',
        email: 'jjstrick9@gmail.com',
        role: 'ADMIN',
      });

      const ctx = mockContext({ authorization: 'Bearer oauth-token' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      // sub is an email → matched via the email branch, not id.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ email: 'jjstrick9@gmail.com' }] },
        select: { id: true, organizationId: true, email: true, role: true },
      });
      const u = ctx.switchToHttp().getRequest().user;
      expect(u.organizationId).toBe('cmpzj8mds007i1ymntpyjngdp');
      // sub is normalised back to the real cuid for downstream ownership checks.
      expect(u.sub).toBe('cmpzj8mm9007j1ymn5mo2y3eq');
    });

    it('leaves organizationId undefined when the user cannot be resolved (fail closed downstream)', async () => {
      mockConfig.get.mockReturnValue(undefined);
      mockAuth.verifyToken.mockReturnValue({ sub: 'ghost', user_data: {} });
      mockPrisma.user.findFirst.mockResolvedValue(null);

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
