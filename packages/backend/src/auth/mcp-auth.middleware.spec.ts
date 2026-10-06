import { McpAuthMiddleware } from './mcp-auth.middleware';

/**
 * The legacy/both-mode middleware in front of /mcp must accept a per-user key
 * the same way McpCombinedAuthGuard does, from X-API-Key or as a bearer token.
 */
describe('McpAuthMiddleware: per-user MCP API keys', () => {
  const run = async (headers: Record<string, string>, env: Record<string, string> = {}) => {
    const config = { get: jest.fn((k: string) => env[k]) };
    const auth = {
      verifyToken: jest.fn(() => {
        throw new Error('not a JWT');
      }),
    };
    const apiKeys = {
      resolveUserByKey: jest.fn(async (key: string) =>
        key === 'mcp_valid'
          ? { id: 'u1', email: 'a@b.com', role: 'EDITOR', mcpRoleId: null, mcpServerId: 's1', apiKeyName: 'k' }
          : null,
      ),
    };
    const mw = new McpAuthMiddleware(config as any, auth as any, apiKeys as any);
    const req: any = { headers };
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await mw.use(req, res, next);
    return { req, res, next, apiKeys };
  };

  it('accepts a valid key as X-API-Key and as Authorization: Bearer', async () => {
    const variants: Record<string, string>[] = [{ 'x-api-key': 'mcp_valid' }, { authorization: 'Bearer mcp_valid' }];
    for (const headers of variants) {
      const { req, next } = await run(headers);
      expect(next).toHaveBeenCalled();
      expect(req.user).toMatchObject({ authMethod: 'mcp_api_key', sub: 'u1' });
    }
  });

  it('refuses an unknown key sent as a bearer token', async () => {
    const { res, next } = await run({ authorization: 'Bearer mcp_unknown' }, { MCP_API_KEY: 'static' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('keeps a static MCP_BEARER_TOKEN with an mcp_ prefix on the static path', async () => {
    const { req, next, apiKeys } = await run(
      { authorization: 'Bearer mcp_static' },
      { MCP_BEARER_TOKEN: 'mcp_static' },
    );
    expect(next).toHaveBeenCalled();
    expect(apiKeys.resolveUserByKey).not.toHaveBeenCalled();
    expect(req.user).toEqual({ authMethod: 'static_bearer' });
  });
});
