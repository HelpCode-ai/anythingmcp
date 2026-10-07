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
  flow?: Record<string, unknown>;
  noFlow?: boolean;
  returnTo?: string;
  exchangeThrows?: Error;
} = {}) {
  const reloadConnectorTools = jest.fn().mockResolvedValue(undefined);
  const updateAuthConfigMerge = jest.fn().mockResolvedValue(undefined);
  const flow = {
    connectorId: 'conn-1',
    userId: 'user-1',
    tokenUrl: 'https://sandbox-api.datev.de/token',
    redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback',
    clientId: 'cid',
    clientSecret: 'sec',
    codeVerifier: 'verifier',
    tokenAuthMethod: 'basic',
    ...overrides.flow,
  };
  const record = overrides.noFlow ? undefined : { flow, returnTo: overrides.returnTo };

  const mcpOAuthService: any = {
    getPendingFlow: jest.fn().mockResolvedValue(record),
    takePendingFlow: jest.fn().mockResolvedValue(record),
    exchangeCodeForTokens: overrides.exchangeThrows
      ? jest.fn().mockRejectedValue(overrides.exchangeThrows)
      : jest.fn().mockResolvedValue({
          accessToken: 'AT',
          refreshToken: 'RT',
          expiresIn: 3600,
        }),
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
  const prisma: any = {
    mcpTool: { create: jest.fn().mockResolvedValue({}) },
    connector: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1', config: { adapterSlug: 'etsy' } }),
    },
  };
  const productEvents: any = { log: jest.fn().mockResolvedValue(undefined) };
  const mcpServer: any = { reloadConnectorTools };
  const configService: any = { get: jest.fn().mockReturnValue('https://cloud.example.com') };

  const controller = new McpOAuthCallbackController(
    mcpOAuthService,
    connectorsService,
    mcpClientEngine,
    prisma,
    mcpServer,
    configService,
    productEvents,
  );
  return {
    controller,
    productEvents,
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

const asUser = (sub: string) => ({ user: { sub } });

describe('McpOAuthCallbackController — provider redirect', () => {
  it('forwards code and state to the dashboard and exchanges nothing itself', async () => {
    const { controller, mcpOAuthService, updateAuthConfigMerge } = makeController();
    const res = makeRes();
    await controller.oauthCallback('the-code', 'the-state', undefined, undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://cloud.example.com/connectors/oauth/complete?state=the-state&code=the-code',
    );
    expect(mcpOAuthService.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(mcpOAuthService.takePendingFlow).not.toHaveBeenCalled();
    expect(updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('does not forward a state it never issued', async () => {
    const { controller } = makeController({ noFlow: true });
    const res = makeRes();
    await controller.oauthCallback('the-code', 'forged', undefined, undefined, res);
    expect(res.redirect.mock.calls[0][0]).toMatch(/complete\?error=/);
    expect(res.redirect.mock.calls[0][0]).not.toContain('code=');
  });

  it('redirects with an error when code/state are missing', async () => {
    const { controller, reloadConnectorTools } = makeController();
    const res = makeRes();
    await controller.oauthCallback('', '', undefined, undefined, res);
    expect(reloadConnectorTools).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error='));
  });

  it('treats repeated parameters as missing, never as arrays', async () => {
    const { controller, mcpOAuthService } = makeController();
    const res = makeRes();
    await controller.oauthCallback(['a', 'b'], ['s1', 's2'], ['access_denied', 'x'], ['d'], res);
    expect(mcpOAuthService.takePendingFlow).not.toHaveBeenCalled();
    expect(mcpOAuthService.getPendingFlow).not.toHaveBeenCalled();
    expect(res.redirect.mock.calls[0][0]).toMatch(/complete\?error=/);
    expect(res.redirect.mock.calls[0][0]).not.toContain('code=');
  });

  it('spends the attempt and explains a refusal at the provider', async () => {
    const { controller, mcpOAuthService } = makeController();
    const res = makeRes();
    await controller.oauthCallback('', 'the-state', 'access_denied', 'User said no', res);
    expect(mcpOAuthService.takePendingFlow).toHaveBeenCalledWith('the-state');
    const url = new URL(res.redirect.mock.calls[0][0]);
    expect(url.searchParams.get('error')).toMatch(/cancelled at the provider/);
    expect(url.searchParams.get('connectorId')).toBe('conn-1');
  });
});

describe('McpOAuthCallbackController — completion by the dashboard', () => {
  it("passes the flow's User-Agent to the code exchange", async () => {
    const { controller, mcpOAuthService } = makeController({
      flow: { userAgent: 'web:anythingmcp:v1 (by /u/anythingmcp)' },
    });
    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });
    expect(mcpOAuthService.exchangeCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'the-code', userAgent: 'web:anythingmcp:v1 (by /u/anythingmcp)' }),
    );
  });

  it('refuses a user other than the one who started the flow, and kills the attempt', async () => {
    const { controller, mcpOAuthService, updateAuthConfigMerge } = makeController();
    await expect(
      controller.complete(asUser('attacker'), { state: 'the-state', code: 'the-code' }),
    ).rejects.toThrow(/started by another account/);
    expect(mcpOAuthService.takePendingFlow).toHaveBeenCalledWith('the-state');
    expect(mcpOAuthService.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('answers 410 for an expired or reused state', async () => {
    const { controller } = makeController({ noFlow: true });
    await expect(
      controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' }),
    ).rejects.toThrow(/expired or was already used/);
  });

  it('returns where the dashboard should land', async () => {
    const { controller } = makeController({ returnTo: '/connectors/setup/etsy?step=done' });
    await expect(
      controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' }),
    ).resolves.toEqual({ connectorId: 'conn-1', toolsImported: 0, returnTo: '/connectors/setup/etsy?step=done' });
  });

  it('reloads connector tools after storing the token even when MCP discovery throws (REST connector)', async () => {
    const { controller, reloadConnectorTools, updateAuthConfigMerge } =
      makeController({ listToolsThrows: true });

    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });

    // Token was persisted via a MERGE (preserves authorizationUrl/scopes)...
    expect(updateAuthConfigMerge).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ accessToken: 'AT', tokenAuthMethod: 'basic' }),
    );
    // ...and the registry was reloaded despite discovery throwing.
    expect(reloadConnectorTools).toHaveBeenCalledWith('conn-1');
  });

  it('does not import MCP tools into a REST connector whose host also speaks MCP', async () => {
    // Google serves MCP on searchconsole.googleapis.com. Authorising the
    // Search Console REST connector added get/query/sites_list, mapped as
    // REST calls to /mcp, next to its own eleven tools.
    const { controller, mcpClientEngine, prisma } = makeController({
      connectorType: 'REST',
      remoteTools: [{ name: 'get' }, { name: 'query' }, { name: 'sites_list' }],
    });

    const out = await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });

    expect(mcpClientEngine.listTools).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    expect(out.toolsImported).toBe(0);
  });

  it('still discovers tools for an MCP connector', async () => {
    const { controller, mcpClientEngine, prisma } = makeController({
      connectorType: 'MCP',
      remoteTools: [{ name: 'search' }, { name: 'fetch' }],
    });

    const out = await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });

    expect(mcpClientEngine.listTools).toHaveBeenCalled();
    expect(prisma.mcpTool.create).toHaveBeenCalledTimes(2);
    expect(out.toolsImported).toBe(2);
  });

  it('writes what the flow took from the catalog next to the tokens, and not the resolved client', async () => {
    // A REST connector whose client id lives in env vars: the flow resolved
    // it to authorize, but the row keeps the placeholder so a later edit of
    // the env var still reaches it.
    const { controller, updateAuthConfigMerge } = makeController({
      flow: {
        clientId: 'keystring',
        clientSecret: 'secret',
        tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
        tokenAuthMethod: undefined,
        persistAuthConfig: {
          authorizationUrl: 'https://www.etsy.com/oauth/connect',
          scopes: 'email_r shops_r listings_r transactions_r',
        },
      },
    });

    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });

    const patch = updateAuthConfigMerge.mock.calls[0][1];
    expect(patch).toMatchObject({
      authorizationUrl: 'https://www.etsy.com/oauth/connect',
      scopes: 'email_r shops_r listings_r transactions_r',
      accessToken: 'AT',
      refreshToken: 'RT',
    });
    expect(patch).not.toHaveProperty('clientId');
    expect(patch).not.toHaveProperty('clientSecret');
    expect(patch).not.toHaveProperty('tokenUrl');
  });

  it('still writes the client settings when the flow does not say otherwise (MCP)', async () => {
    const { controller, updateAuthConfigMerge } = makeController({ connectorType: 'MCP' });
    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });
    expect(updateAuthConfigMerge.mock.calls[0][1]).toMatchObject({
      clientId: 'cid',
      clientSecret: 'sec',
      tokenUrl: 'https://sandbox-api.datev.de/token',
      tokenAuthMethod: 'basic',
      accessToken: 'AT',
      refreshToken: 'RT',
    });
  });
});

describe('McpOAuthCallbackController — failed sign-ins are recorded', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('records a refusal at the provider with its error code', async () => {
    const { controller, productEvents } = makeController();
    await controller.oauthCallback('', 'the-state', 'access_denied', 'User said no', makeRes());
    await flush();
    expect(productEvents.log).toHaveBeenCalledWith({
      event: 'oauth_failed',
      userId: 'user-1',
      organizationId: 'org-1',
      metadata: { connectorId: 'conn-1', kind: 'provider_refused', adapterSlug: 'etsy', error: 'access_denied' },
    });
  });

  it('records a failed code exchange without the secret it was sent with', async () => {
    const { controller, productEvents } = makeController({
      exchangeThrows: new Error('invalid_client: client secret sec-123456 rejected by https://api.etsy.com/token?client_id=abc'),
      flow: { clientSecret: 'sec-123456' },
    });
    await expect(controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' })).rejects.toThrow();
    await flush();
    const { metadata } = productEvents.log.mock.calls[0][0];
    expect(metadata.kind).toBe('token_exchange');
    expect(metadata.error).toBe('invalid_client: client secret *** rejected by https://api.etsy.com/token');
  });
});
