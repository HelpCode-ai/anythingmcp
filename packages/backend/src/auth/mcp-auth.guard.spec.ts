import { UnauthorizedException } from '@nestjs/common';
import { McpAuthGuard } from './mcp-auth.guard';

describe('McpAuthGuard', () => {
  let guard: McpAuthGuard;
  let mockConfig: any;
  let mockAuth: any;
  let mockApiKeys: any;

  const mockContext = (headers: Record<string, string> = {}) => {
    const request = { headers, user: undefined as any };
    const response = { setHeader: jest.fn() };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      _request: request,
      _response: response,
    } as any;
  };

  beforeEach(() => {
    mockConfig = { get: jest.fn() };
    mockAuth = { verifyToken: jest.fn() };
    mockApiKeys = { resolveUserByKey: jest.fn() };
    guard = new McpAuthGuard(mockConfig, mockAuth, mockApiKeys);
  });

  describe('per-user MCP API key (mcp_ prefix)', () => {
    it('should authenticate valid mcp_ key and set request.user', async () => {
      const user = { id: 'u1', email: 'a@b.com', role: 'USER', mcpRoleId: 'r1' };
      mockApiKeys.resolveUserByKey.mockResolvedValue(user);

      const ctx = mockContext({ 'x-api-key': 'mcp_abc123' });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      const req = ctx.switchToHttp().getRequest();
      expect(req.user).toEqual({
        sub: 'u1',
        email: 'a@b.com',
        role: 'USER',
        mcpRoleId: 'r1',
      });
    });

    it('should fall through to 401 for invalid mcp_ key', async () => {
      mockApiKeys.resolveUserByKey.mockResolvedValue(null);
      mockConfig.get.mockReturnValue('some-key');

      const ctx = mockContext({ 'x-api-key': 'mcp_invalid' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('dev mode', () => {
    it('should allow when neither MCP_API_KEY nor MCP_BEARER_TOKEN configured', async () => {
      mockConfig.get.mockReturnValue(undefined);

      const ctx = mockContext({});
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  describe('static API key', () => {
    it('should allow when x-api-key matches MCP_API_KEY', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_API_KEY') return 'static-key';
        return undefined;
      });

      const ctx = mockContext({ 'x-api-key': 'static-key' });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('should reject when x-api-key does not match', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_API_KEY') return 'static-key';
        return undefined;
      });

      const ctx = mockContext({ 'x-api-key': 'wrong-key' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('bearer token', () => {
    it('should allow when bearer matches MCP_BEARER_TOKEN', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_BEARER_TOKEN') return 'static-bearer';
        return undefined;
      });

      const ctx = mockContext({ authorization: 'Bearer static-bearer' });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('should allow when bearer is a valid JWT and set request.user', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_API_KEY') return 'some-key';
        return undefined;
      });
      const payload = { sub: 'u1', email: 'a@b.com', role: 'USER' };
      mockAuth.verifyToken.mockReturnValue(payload);

      const ctx = mockContext({ authorization: 'Bearer jwt-token-here' });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().user).toBe(payload);
    });

    it('should reject invalid JWT when no static bearer configured', async () => {
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'MCP_API_KEY') return 'some-key';
        return undefined;
      });
      mockAuth.verifyToken.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const ctx = mockContext({ authorization: 'Bearer bad-token' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('rejection', () => {
    it('should set WWW-Authenticate header on rejection', async () => {
      mockConfig.get.mockReturnValue('some-key');

      const ctx = mockContext({});
      try {
        await guard.canActivate(ctx);
      } catch {
        // expected
      }

      const response = ctx.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Bearer realm="AnythingMCP MCP Server"',
      );
    });
  });
});
