import { McpEndpointController } from './mcp-endpoint.controller';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';
import { withRegistryIndexes } from './registry-test-double';

/**
 * The connection grant on a server's own URL (`/mcp/<serverId>`).
 *
 * An OAuth client connected to ONE server by its URL holds a grant for that
 * server only, and the consent page says it reaches nothing else. The endpoint
 * used to check only that the user is a member of the server's workspace, so
 * the same token also opened every other server of the workspace.
 */
describe('McpEndpointController — connection grant on a server URL', () => {
  const SERVER_A = { id: 'srv-A', name: 'First', version: '1.0.0', isActive: true, organizationId: 'org-1' };
  const before = {
    scope: process.env.MCP_GRANT_SERVER_SCOPE,
    stateful: process.env.MCP_STATEFUL_SESSIONS,
  };

  let mcpServersService: any;
  let sessionManager: any;
  let grants: { resolve: jest.Mock; serverScope: jest.Mock };
  let refusals: { mark: jest.Mock };
  let controller: McpEndpointController;
  let warn: jest.SpyInstance;

  const makeRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn();
    res.headersSent = false;
    return res;
  };

  /** An OAuth access token of `client-1` for a member of org-1. */
  const oauthUser = (extra: Record<string, unknown> = {}) => ({
    sub: 'u-1',
    organizationId: 'org-1',
    authMethod: 'jwt',
    azp: 'client-1',
    ...extra,
  });
  const request = (user: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ({
      user,
      headers: {
        host: 'cloud.anythingmcp.com',
        'x-forwarded-proto': 'https',
        authorization: 'Bearer tok',
        ...headers,
      },
    }) as any;

  /** The request went past the grant check: the server's tool surface was planned. */
  const expectServed = (res: any) => {
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
  };
  const expectRefused = (res: any) => {
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="AnythingMCP MCP Server", error="invalid_token", ' +
        'error_description="This connection was not allowed to use this MCP server", ' +
        'resource_metadata="https://cloud.anythingmcp.com/.well-known/oauth-protected-resource/mcp/srv-A"',
    );
    expect(res.json.mock.calls[0][0].error.message).toMatch(/Connect again/);
    // Nothing of the server was read for the caller.
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  };
  const warnings = () => warn.mock.calls.map((c) => String(c[0]));

  function build(grantService: any = grants) {
    const built = new McpEndpointController(
      mcpServersService,
      withRegistryIndexes({ getAllTools: jest.fn().mockReturnValue([]) }) as any,
      { executeTool: jest.fn() } as any,
      { getAllowedToolIds: jest.fn().mockResolvedValue(null) } as any,
      {
        lookup: jest.fn().mockResolvedValue({}),
        isEnabled: jest.fn().mockResolvedValue(false),
        captureIntentEnabled: jest.fn().mockResolvedValue(false),
      } as any,
      sessionManager,
      grantService,
      { create: jest.fn(), hasVisible: jest.fn().mockResolvedValue(false) } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      refusals as any,
    );
    // Serving itself is not under test: stop before the transport.
    (built as any).serveStateless = jest.fn();
    warn = jest.spyOn((built as any).logger, 'warn').mockImplementation(() => undefined);
    return built;
  }

  beforeEach(() => {
    delete process.env.MCP_GRANT_SERVER_SCOPE;
    delete process.env.MCP_STATEFUL_SESSIONS;
    mcpServersService = {
      findById: jest.fn().mockResolvedValue(SERVER_A),
      getConnectorIds: jest.fn().mockResolvedValue([]),
      getVisibleContent: jest
        .fn()
        .mockResolvedValue({ instructions: undefined, connectors: [], resources: [] }),
      isUserInOrganization: jest.fn().mockResolvedValue(false),
    };
    sessionManager = {
      get: jest.fn(),
      touch: jest.fn(),
      add: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
      notifyToolsChanged: jest.fn().mockResolvedValue(undefined),
    };
    grants = { resolve: jest.fn().mockResolvedValue(null), serverScope: jest.fn().mockResolvedValue('granted') };
    refusals = { mark: jest.fn().mockResolvedValue(undefined) };
    controller = build();
  });

  afterAll(() => {
    for (const [name, value] of [
      ['MCP_GRANT_SERVER_SCOPE', before.scope],
      ['MCP_STATEFUL_SESSIONS', before.stateful],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // ── What the grant says ───────────────────────────────────────────────────

  it('serves a server the grant names, and asks with the server and its workspace', async () => {
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(grants.serverScope).toHaveBeenCalledWith('client-1', 'u-1', { id: 'srv-A', organizationId: 'org-1' });
    expect(refusals.mark).not.toHaveBeenCalled();
  });

  it('refuses a server of the same workspace that the grant does not name', async () => {
    grants.serverScope.mockResolvedValue('outside');
    const order: string[] = [];
    refusals.mark.mockImplementation(async () => {
      order.push('mark');
    });
    const res = makeRes();
    res.status = jest.fn((code: number) => {
      order.push(`status ${code}`);
      return res;
    });

    await controller.handlePost('srv-A', request(oauthUser()), res, {});

    expectRefused(res);
    // The marker first: the client's refresh comes within a second.
    expect(refusals.mark).toHaveBeenCalledWith('u-1', 'client-1', 'srv-A');
    expect(order).toEqual(['mark', 'status 401']);
    expect(warnings()).toEqual([
      'MCP request refused: server srv-A, the connection grant does not include it ' +
        '(client …ient-1, user u-1, org org-1, auth jwt)',
    ]);
  });

  it('serves any server of a whole-workspace grant', async () => {
    // The service answers `granted` for a server of the granted workspace.
    grants.serverScope.mockResolvedValue('granted');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
  });

  it('serves a client without a grant row: tokens from before grants, the SSO sign-in', async () => {
    grants.serverScope.mockResolvedValue('no-grant');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(warnings()).toEqual([]);
  });

  it('refuses a revoked connection', async () => {
    grants.serverScope.mockResolvedValue('revoked');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectRefused(res);
    expect(warnings()[0]).toContain('the connection was revoked');
  });

  it('refuses a server of another workspace the user is a member of, when the grant does not name it', async () => {
    mcpServersService.isUserInOrganization.mockResolvedValue(true);
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser({ organizationId: 'org-2' })), res, {});
    expectRefused(res);
    expect(mcpServersService.isUserInOrganization).toHaveBeenCalledWith('u-1', 'org-1');
  });

  it('keeps a server reachable that member visibility hides from the user, and says so in the log', async () => {
    grants.serverScope.mockResolvedValue('not-grantable');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(refusals.mark).not.toHaveBeenCalled();
    expect(warnings()).toEqual([
      'MCP grant scope: server srv-A is outside the connection grant but hidden from the user by member ' +
        'visibility, so it stays reachable (client …ient-1, user u-1, org org-1, auth jwt)',
    ]);
  });

  it('refuses a subscriptions/listen stream outside the grant too', async () => {
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: {},
    });
    expectRefused(res);
    expect((controller as any).serveStateless).not.toHaveBeenCalled();
  });

  it('still answers 401 when the marker cannot be written', async () => {
    grants.serverScope.mockResolvedValue('outside');
    refusals.mark.mockRejectedValue(new Error('redis down'));
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectRefused(res);
  });

  // ── The earlier checks keep their answers ─────────────────────────────────

  it('answers a non-member as before, without reading the grant', async () => {
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser({ organizationId: 'org-2' })), res, {});
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error.message).toMatch(/different workspace/);
    expect(grants.serverScope).not.toHaveBeenCalled();
  });

  it('answers an unknown and an inactive server as before', async () => {
    grants.serverScope.mockResolvedValue('outside');
    mcpServersService.findById.mockResolvedValueOnce(null);
    const missing = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), missing, {});
    expect(missing.status).toHaveBeenCalledWith(404);

    mcpServersService.findById.mockResolvedValueOnce({ ...SERVER_A, isActive: false });
    const inactive = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), inactive, {});
    expect(inactive.status).toHaveBeenCalledWith(403);
    expect(grants.serverScope).not.toHaveBeenCalled();
  });

  // ── Credentials a grant never applies to ──────────────────────────────────

  it.each([
    ['an API key of the workspace', { sub: 'u-1', organizationId: 'org-1', authMethod: 'mcp_api_key', apiKeyName: 'laptop' }],
    [
      'an API key created for this server',
      { sub: 'u-1', organizationId: 'org-1', authMethod: 'mcp_api_key', apiKeyName: 'ci', mcpServerId: 'srv-A' },
    ],
    ['an app JWT, which names no OAuth client', { sub: 'u-1', organizationId: 'org-1', authMethod: 'jwt' }],
    ['the static API key', { authMethod: 'static_api_key' }],
    ['the static bearer token', { authMethod: 'static_bearer' }],
    ['no authentication (MCP_AUTH_MODE=none)', { authMethod: 'none' }],
  ])('does not read a grant for %s', async (_name, user) => {
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(user), res, {});
    expectServed(res);
    expect(grants.serverScope).not.toHaveBeenCalled();
  });

  it('reads the client from client_id when the token has no azp', async () => {
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser({ azp: undefined, client_id: 'client-9' })), res, {});
    expectRefused(res);
    expect(grants.serverScope).toHaveBeenCalledWith('client-9', 'u-1', expect.anything());
  });

  // ── MCP_GRANT_SERVER_SCOPE ────────────────────────────────────────────────

  it('report: serves the request and logs one line saying what would be refused', async () => {
    process.env.MCP_GRANT_SERVER_SCOPE = 'report';
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(refusals.mark).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
    expect(warnings()).toEqual([
      'MCP grant scope (report only): a request to server srv-A would be refused, ' +
        'the connection grant does not include it (client …ient-1, user u-1, org org-1, auth jwt)',
    ]);
  });

  it('report: logs nothing for a request inside the grant', async () => {
    process.env.MCP_GRANT_SERVER_SCOPE = 'report';
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(warnings()).toEqual([]);
  });

  it('off: serves the request without reading the grant', async () => {
    process.env.MCP_GRANT_SERVER_SCOPE = 'off';
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectServed(res);
    expect(grants.serverScope).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it('enforces for a value it does not know', async () => {
    process.env.MCP_GRANT_SERVER_SCOPE = 'maybe';
    grants.serverScope.mockResolvedValue('outside');
    const res = makeRes();
    await controller.handlePost('srv-A', request(oauthUser()), res, {});
    expectRefused(res);
  });

  it('never logs the token', async () => {
    grants.serverScope.mockResolvedValue('outside');
    await controller.handlePost('srv-A', request(oauthUser()), makeRes(), {});
    expect(warnings().join('\n')).not.toContain('tok');
  });

  // ── A live session (MCP_STATEFUL_SESSIONS=true) ───────────────────────────

  describe('with a live session', () => {
    let transport: { handleRequest: jest.Mock };

    beforeEach(() => {
      process.env.MCP_STATEFUL_SESSIONS = 'true';
      transport = { handleRequest: jest.fn().mockResolvedValue(undefined) };
      sessionManager.get.mockReturnValue({
        sessionId: 'sess-1',
        serverId: 'srv-A',
        organizationId: 'org-1',
        principalKey: 'sub:u-1',
        transport,
      });
    });

    it('routes a request to the session while the grant includes the server', async () => {
      const res = makeRes();
      await controller.handlePost('srv-A', request(oauthUser(), { 'mcp-session-id': 'sess-1' }), res, {});
      expect(transport.handleRequest).toHaveBeenCalled();
      expect(grants.serverScope).toHaveBeenCalledWith('client-1', 'u-1', { id: 'srv-A', organizationId: 'org-1' });
    });

    it('refuses a request on the session once the grant no longer includes the server', async () => {
      grants.serverScope.mockResolvedValue('outside');
      const res = makeRes();
      await controller.handlePost('srv-A', request(oauthUser(), { 'mcp-session-id': 'sess-1' }), res, {});
      expectRefused(res);
      expect(transport.handleRequest).not.toHaveBeenCalled();
      expect(sessionManager.touch).not.toHaveBeenCalled();
    });

    it('refuses the DELETE of the session the same way', async () => {
      grants.serverScope.mockResolvedValue('revoked');
      const res = makeRes();
      await controller.handleDelete('srv-A', request(oauthUser(), { 'mcp-session-id': 'sess-1' }), res);
      expectRefused(res);
      expect(transport.handleRequest).not.toHaveBeenCalled();
    });

    it("keeps the 404 for another principal's session, without reading the grant", async () => {
      const res = makeRes();
      await controller.handlePost(
        'srv-A',
        request(oauthUser({ sub: 'u-other' }), { 'mcp-session-id': 'sess-1' }),
        res,
        {},
      );
      expect(res.status).toHaveBeenCalledWith(404);
      expect(grants.serverScope).not.toHaveBeenCalled();
    });

    it('a GET carries no principal (the guard lets it through): no grant is read', async () => {
      sessionManager.get.mockReturnValue({
        sessionId: 'sess-1',
        serverId: 'srv-A',
        organizationId: 'org-1',
        principalKey: 'static:none',
        transport,
      });
      const res = makeRes();
      await controller.handleGet('srv-A', request({ authMethod: 'none' }, { 'mcp-session-id': 'sess-1' }), res);
      expect(transport.handleRequest).toHaveBeenCalled();
      expect(grants.serverScope).not.toHaveBeenCalled();
    });
  });

  // ── With the real grant service: the cases end to end ─────────────────────

  describe('with the grant service', () => {
    type Row = { organizationId: string | null; serverIds: string[]; revokedAt: Date | null };
    let row: Row | null;
    let findUnique: jest.Mock;

    beforeEach(() => {
      row = null;
      findUnique = jest.fn(async () => row);
      const prisma: any = {
        mcpConnectionGrant: {
          findUnique,
          updateMany: jest.fn(async ({ data }: any) => {
            if (row && data.serverIds?.push) row = { ...row, serverIds: [...row.serverIds, data.serverIds.push] };
            return { count: row ? 1 : 0 };
          }),
          upsert: jest.fn(),
        },
        mcpServerConfig: {
          findMany: jest.fn(async ({ where }: any) =>
            (where.id.in as string[]).map((id) => ({ id, organizationId: 'org-1' })),
          ),
        },
      };
      controller = build(new McpConnectionGrantService(prisma));
    });

    const post = async (serverId: string, user = oauthUser()) => {
      mcpServersService.findById.mockResolvedValue({ ...SERVER_A, id: serverId });
      mcpServersService.getConnectorIds.mockClear();
      const res = makeRes();
      await controller.handlePost(serverId, request(user), res, {});
      return res.status.mock.calls.some((c: unknown[]) => c[0] === 401) ? 401 : 'served';
    };

    it('a grant for one server opens that server and refuses the second one of the workspace', async () => {
      row = { organizationId: null, serverIds: ['srv-A'], revokedAt: null };
      await expect(post('srv-A')).resolves.toBe('served');
      await expect(post('srv-B')).resolves.toBe(401);
    });

    it('a picker grant opens the servers that were picked and no other', async () => {
      row = { organizationId: null, serverIds: ['srv-A', 'srv-C'], revokedAt: null };
      await expect(post('srv-A')).resolves.toBe('served');
      await expect(post('srv-C')).resolves.toBe('served');
      await expect(post('srv-B')).resolves.toBe(401);
    });

    it('a whole-workspace grant opens every server of that workspace', async () => {
      row = { organizationId: 'org-1', serverIds: [], revokedAt: null };
      await expect(post('srv-A')).resolves.toBe('served');
      await expect(post('srv-B')).resolves.toBe('served');
    });

    it('a whole-workspace grant does not open a server of another workspace of the user', async () => {
      row = { organizationId: 'org-9', serverIds: [], revokedAt: null };
      await expect(post('srv-A')).resolves.toBe(401);
    });

    it('no grant row: every server of the workspace, as before', async () => {
      row = null;
      await expect(post('srv-A')).resolves.toBe('served');
      await expect(post('srv-B')).resolves.toBe('served');
    });

    it('a revoked connection opens nothing', async () => {
      row = { organizationId: null, serverIds: ['srv-A'], revokedAt: new Date() };
      await expect(post('srv-A')).resolves.toBe(401);
    });

    it('authorizing the same client for the second server URL makes both work', async () => {
      row = { organizationId: null, serverIds: ['srv-A'], revokedAt: null };
      await expect(post('srv-B')).resolves.toBe(401);
      const service: McpConnectionGrantService = (controller as any).grants;
      await service.grantRequestedServer('client-1', 'u-1', 'srv-B');
      await expect(post('srv-B')).resolves.toBe('served');
      await expect(post('srv-A')).resolves.toBe('served');
    });

    it('reads the grant once for a run of requests it serves', async () => {
      row = { organizationId: null, serverIds: ['srv-A'], revokedAt: null };
      for (let i = 0; i < 10; i++) await post('srv-A');
      expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('another client of the same user has its own grant', async () => {
      row = { organizationId: null, serverIds: ['srv-A'], revokedAt: null };
      await expect(post('srv-B', oauthUser({ azp: 'client-1' }))).resolves.toBe(401);
      row = { organizationId: null, serverIds: ['srv-B'], revokedAt: null };
      await expect(post('srv-B', oauthUser({ azp: 'client-2' }))).resolves.toBe('served');
      expect(findUnique.mock.calls.map((c) => c[0].where.clientId_userId.clientId)).toEqual([
        'client-1',
        'client-2',
      ]);
    });
  });
});
