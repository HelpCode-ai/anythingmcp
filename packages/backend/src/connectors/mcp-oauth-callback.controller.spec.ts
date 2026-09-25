import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';

/**
 * Regression test for the REST OAuth reload gap: after a REST/GraphQL connector
 * completes the OAuth flow, the freshly-stored access token must be loaded into
 * the in-memory MCP registry. MCP auto-discovery only runs for MCP connectors
 * (and may throw), so the reload must happen independently of it.
 */
function makeController(overrides: {
  listToolsThrows?: boolean;
  connectorType?: string;
  remoteTools?: Array<{ name: string }>;
} = {}) {
  const reloadConnectorTools = jest.fn().mockResolvedValue(undefined);
  const updateAuthConfigMerge = jest.fn().mockResolvedValue(undefined);
  const deletePendingFlow = jest.fn();

  const mcpOAuthService: any = {
    getPendingFlow: jest.fn().mockReturnValue({
      connectorId: 'conn-1',
      tokenUrl: 'https://sandbox-api.datev.de/token',
      redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback',
      clientId: 'cid',
      clientSecret: 'sec',
      codeVerifier: 'verifier',
      tokenAuthMethod: 'basic',
    }),
    exchangeCodeForTokens: jest.fn().mockResolvedValue({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresIn: 3600,
    }),
    deletePendingFlow,
  };
  const connectorsService: any = {
    updateAuthConfigMerge,
    findByIdInternal: jest.fn().mockResolvedValue({
      type: overrides.connectorType ?? 'REST',
      baseUrl: 'https://accounting-clients.api.datev.de/platform-sandbox/v2',
      headers: {},
    }),
  };
  const mcpClientEngine: any = {
    listTools: overrides.listToolsThrows
      ? jest.fn().mockRejectedValue(new Error('not an MCP server'))
      : jest.fn().mockResolvedValue(overrides.remoteTools ?? []),
  };
  const prisma: any = { mcpTool: { create: jest.fn().mockResolvedValue({}) } };
  const mcpServer: any = { reloadConnectorTools };
  const configService: any = { get: jest.fn().mockReturnValue('https://cloud.example.com') };

  const controller = new McpOAuthCallbackController(
    mcpOAuthService,
    connectorsService,
    mcpClientEngine,
    prisma,
    mcpServer,
    configService,
  );
  return {
    controller,
    reloadConnectorTools,
    updateAuthConfigMerge,
    mcpOAuthService,
    mcpClientEngine,
    prisma,
  };
}

function makeRes() {
  return { redirect: jest.fn() } as any;
}

describe('McpOAuthCallbackController', () => {
  it('reloads connector tools after storing the token even when MCP discovery throws (REST connector)', async () => {
    const { controller, reloadConnectorTools, updateAuthConfigMerge } =
      makeController({ listToolsThrows: true });
    const res = makeRes();

    await controller.oauthCallback('the-code', 'the-state', res);

    // Token was persisted via a MERGE (preserves authorizationUrl/scopes)...
    expect(updateAuthConfigMerge).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ accessToken: 'AT', tokenAuthMethod: 'basic' }),
    );
    // ...and the registry was reloaded despite discovery throwing.
    expect(reloadConnectorTools).toHaveBeenCalledWith('conn-1');
    // Redirects to success.
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('oauth=success'),
    );
  });

  it('does not import MCP tools into a REST connector whose host also speaks MCP', async () => {
    // Google serves MCP on searchconsole.googleapis.com. Authorising the
    // Search Console REST connector added get/query/sites_list, mapped as
    // REST calls to /mcp, next to its own eleven tools.
    const { controller, mcpClientEngine, prisma } = makeController({
      connectorType: 'REST',
      remoteTools: [{ name: 'get' }, { name: 'query' }, { name: 'sites_list' }],
    });
    const res = makeRes();

    await controller.oauthCallback('the-code', 'the-state', res);

    expect(mcpClientEngine.listTools).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('tools=0'));
  });

  it('still discovers tools for an MCP connector', async () => {
    const { controller, mcpClientEngine, prisma } = makeController({
      connectorType: 'MCP',
      remoteTools: [{ name: 'search' }, { name: 'fetch' }],
    });
    const res = makeRes();

    await controller.oauthCallback('the-code', 'the-state', res);

    expect(mcpClientEngine.listTools).toHaveBeenCalled();
    expect(prisma.mcpTool.create).toHaveBeenCalledTimes(2);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('tools=2'));
  });

  it('redirects with an error when code/state are missing', async () => {
    const { controller, reloadConnectorTools } = makeController();
    const res = makeRes();
    await controller.oauthCallback('', '', res);
    expect(reloadConnectorTools).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error='));
  });
});
