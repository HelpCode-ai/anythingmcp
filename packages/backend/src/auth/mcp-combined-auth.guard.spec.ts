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
    mockPrisma = { user: { findUnique: jest.fn() } };
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

    it('resolves organizationId from the user record for an OAuth token that lacks it', async () => {
      mockConfig.get.mockReturnValue(undefined);
      // OAuth access token shape: sub + user_data, NO organizationId claim.
      mockAuth.verifyToken.mockReturnValue({
        sub: 'u-finance',
        type: 'access',
        user_data: { id: 'u-finance', email: 'finance@helpcode.ai' },
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        organizationId: 'org-B',
        email: 'finance@helpcode.ai',
        role: 'ADMIN',
      });

      const ctx = mockContext({ authorization: 'Bearer oauth-token' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u-finance' },
        select: { organizationId: true, email: true, role: true },
      });
      // Without this resolution the org check downstream would be skipped,
      // allowing cross-tenant access to /mcp/:serverId.
      expect(ctx.switchToHttp().getRequest().user.organizationId).toBe('org-B');
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
});
