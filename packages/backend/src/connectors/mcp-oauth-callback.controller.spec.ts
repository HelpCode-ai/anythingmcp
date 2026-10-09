import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';
import { TokenExchangeError } from './mcp-oauth.service';

/**
 * Regression test for the REST OAuth reload gap: after a REST/GraphQL connector
 * completes the OAuth flow, the freshly-stored access token must be loaded into
 * the in-memory MCP registry. MCP auto-discovery only runs for MCP connectors
 * (and may throw), so the reload must happen independently of it.
 */
function makeController(overrides: {
  listToolsThrows?: boolean;
  connectorType?: string;
  remoteTools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
  existingTools?: Array<Record<string, unknown>>;
  connectorConfig?: Record<string, unknown>;
  exchangeError?: Error;
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
    exchangeCodeForTokens: overrides.exchangeThrows ?? overrides.exchangeError
      ? jest.fn().mockRejectedValue(overrides.exchangeThrows ?? overrides.exchangeError)
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
      config: overrides.connectorConfig ?? null,
    }),
  };
  const mcpClientEngine: any = {
    listTools: overrides.listToolsThrows
      ? jest.fn().mockRejectedValue(new Error('not an MCP server'))
      : jest.fn().mockResolvedValue(overrides.remoteTools ?? []),
  };
  const prisma: any = {
    mcpTool: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(overrides.existingTools ?? []),
    },
    connector: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Mercado Libre', organizationId: 'org-1', config: { adapterSlug: 'etsy' } }),
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

describe('McpOAuthCallbackController — a refused code exchange is answered, not a 500', () => {
  const complete = (exchangeThrows: Error, flow?: Record<string, unknown>) => {
    const { controller } = makeController({ exchangeThrows, flow });
    return controller
      .complete(asUser('user-1'), { state: 'the-state', code: 'the-code' })
      .catch((e) => e);
  };

  it('tells the user to check the client ID and secret when the provider refuses them', async () => {
    // Mercado Libre, 9 Oct 2026: a mistyped secret came back as "Internal server error".
    const err = await complete(
      new TokenExchangeError(
        'Token exchange failed: HTTP 400: invalid_client: invalid client_id or client_secret',
        400,
        'invalid_client',
      ),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    const body = err.getResponse();
    expect(body.connectorId).toBe('conn-1');
    expect(body.message).toContain('HTTP 400: invalid_client: invalid client_id or client_secret');
    expect(body.message).toMatch(
      /^The client ID or client secret saved in the connector "Mercado Libre" is wrong or expired/,
    );
    expect(body.message).toMatch(/OAuth settings of your app/);
  });

  it('points at the redirect URI when the code itself is refused', async () => {
    const err = await complete(
      new TokenExchangeError('Token exchange failed: HTTP 400: invalid_grant', 400, 'invalid_grant'),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().message).toContain('https://cloud.example.com/api/mcp-oauth/callback');
  });

  it('answers 502 when the provider itself failed', async () => {
    const err = await complete(new TokenExchangeError('Token exchange failed: HTTP 503', 503));
    expect(err).toBeInstanceOf(BadGatewayException);
  });

  it('never repeats the secret in the answer', async () => {
    const err = await complete(
      new TokenExchangeError('Token exchange failed: HTTP 401: bad secret sec-123456', 401),
      { clientSecret: 'sec-123456' },
    );
    expect(err.getResponse().message).not.toContain('sec-123456');
  });

  it('leaves any other failure as it was', async () => {
    const boom = new Error('database is down');
    expect(await complete(boom)).toBe(boom);
  });
});

describe('McpOAuthCallbackController: MCP bridges', () => {
  it('exchanges with the resource indicator and keeps it for the refreshes (G2)', async () => {
    const { controller, mcpOAuthService, updateAuthConfigMerge } = makeController({
      connectorType: 'MCP',
      flow: { tokenAuthMethod: 'none', clientSecret: undefined, resource: 'https://mcp.stripe.com' },
    });
    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });
    expect(mcpOAuthService.exchangeCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'https://mcp.stripe.com', tokenAuthMethod: 'none' }),
    );
    expect(updateAuthConfigMerge.mock.calls[0][1]).toMatchObject({
      resource: 'https://mcp.stripe.com',
      tokenAuthMethod: 'none',
      accessToken: 'AT',
    });
  });

  it('drops a registered client the token endpoint refuses, so the next attempt registers again (G6)', async () => {
    const { controller, updateAuthConfigMerge } = makeController({
      connectorType: 'MCP',
      flow: { dynamicClient: true },
      exchangeError: new Error('Token exchange failed: HTTP 401: invalid_client'),
    });
    await expect(
      controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' }),
    ).rejects.toThrow(/invalid_client/);
    expect(updateAuthConfigMerge).toHaveBeenCalledWith('conn-1', { mcpOAuthClient: undefined });
  });

  it('keeps a pre-registered client when the exchange fails', async () => {
    const { controller, updateAuthConfigMerge } = makeController({
      connectorType: 'MCP',
      exchangeError: new Error('Token exchange failed: HTTP 401: invalid_client'),
    });
    await expect(
      controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' }),
    ).rejects.toThrow();
    expect(updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('drops a registered client the provider refuses at the consent step', async () => {
    const { controller, updateAuthConfigMerge } = makeController({ flow: { dynamicClient: true } });
    await controller.oauthCallback(undefined, 'the-state', 'invalid_client', 'unknown client', makeRes());
    expect(updateAuthConfigMerge).toHaveBeenCalledWith('conn-1', { mcpOAuthClient: undefined });
  });

  it('imports through the catalog policy: switched off, marked as catalog, snapshot rows refreshed (G9)', async () => {
    const { controller, prisma } = makeController({
      connectorType: 'MCP',
      connectorConfig: { adapterSlug: 'splunk' },
      remoteTools: [{ name: 'splunk_get_info' }, { name: 'splunk_create_dashboard' }, { name: 'splunk_new_tool' }],
      existingTools: [
        { id: 't1', name: 'splunk_get_info', origin: 'catalog', endpointMapping: { method: 'splunk_get_info', path: '/mcp' } },
      ],
    });

    const out = await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });

    expect(out.toolsImported).toBe(2);
    const created = prisma.mcpTool.create.mock.calls.map((c: any[]) => c[0].data);
    expect(created.map((d: any) => [d.name, d.isEnabled, d.origin])).toEqual([
      ['splunk_create_dashboard', false, 'catalog'],
      ['splunk_new_tool', true, 'catalog'],
    ]);
    // The catalog annotations fill what the server leaves out.
    expect(created[0].annotations).toMatchObject({ readOnlyHint: false });
    // The snapshot row takes the server's description and schema, nothing else.
    expect(prisma.mcpTool.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({ description: 'MCP tool: splunk_get_info' }),
    });
    expect(prisma.mcpTool.update.mock.calls[0][0].data).not.toHaveProperty('isEnabled');
  });

  it("names the tools with the connector's prefix and calls them by the remote name", async () => {
    const { controller, prisma, mcpClientEngine } = makeController({
      connectorType: 'MCP',
      connectorConfig: { mcpToolPrefix: 'acme_', mcpPath: '/' },
      remoteTools: [{ name: 'search-docs' }],
    });
    await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });
    expect(mcpClientEngine.listTools).toHaveBeenCalledWith(expect.objectContaining({ mcpPath: '/' }));
    const data = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(data.name).toBe('acme_search_docs');
    expect(data.endpointMapping).toEqual({ method: 'search-docs', path: '/' });
    expect(data).not.toHaveProperty('origin');
  });

  it('leaves existing tools of a hand-made connector alone, as before', async () => {
    const { controller, prisma } = makeController({
      connectorType: 'MCP',
      remoteTools: [{ name: 'search' }],
      existingTools: [{ id: 't1', name: 'search', origin: 'user', endpointMapping: { method: 'search', path: '/mcp' } }],
    });
    const out = await controller.complete(asUser('user-1'), { state: 'the-state', code: 'the-code' });
    expect(out.toolsImported).toBe(0);
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });
});
