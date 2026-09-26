import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import {
  RESOURCE_PLACEHOLDER_TEXT,
  connectorInstructionsUri,
  serverInstructionsUri,
} from './mcp-resources';

/**
 * Regression tests for cross-tenant isolation on the per-server MCP endpoint.
 * A leak was confirmed where an OAuth token from org B could list/use org A's
 * tools because the org check was skipped when organizationId was absent.
 */
describe('McpEndpointController — tenant isolation', () => {
  let controller: McpEndpointController;
  let mcpServersService: any;
  let toolRegistry: any;
  let toolExecutor: any;
  let rolesService: any;
  let grants: any;

  const SERVER = {
    id: 'srv-A',
    name: 'deutsch bahn',
    version: '1.0.0',
    isActive: true,
    organizationId: 'org-A',
  };

  const makeRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.headersSent = false;
    return res;
  };

  beforeEach(() => {
    mcpServersService = {
      findById: jest.fn().mockResolvedValue(SERVER),
      getConnectorIds: jest.fn().mockResolvedValue([]),
      getVisibleContent: jest
        .fn()
        .mockResolvedValue({ instructions: undefined, connectors: [], resources: [] }),
      isUserInOrganization: jest.fn().mockResolvedValue(false),
    };
    toolRegistry = { getAllTools: jest.fn().mockReturnValue([]) };
    toolExecutor = { executeTool: jest.fn() };
    rolesService = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
    const kgService = {
      lookup: jest.fn().mockResolvedValue({}),
      isEnabled: jest.fn().mockResolvedValue(true),
      captureIntentEnabled: jest.fn().mockResolvedValue(false),
    };
    const sessionManager = {
      get: jest.fn(),
      touch: jest.fn(),
      add: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
      notifyToolsChanged: jest.fn().mockResolvedValue(undefined),
    };
    grants = { resolve: jest.fn().mockResolvedValue(null) };
    controller = new McpEndpointController(
      mcpServersService,
      toolRegistry,
      toolExecutor,
      rolesService,
      kgService as any,
      sessionManager as any,
      grants as any,
      { create: jest.fn() } as any,
    );
  });

  it('denies a non-member whose org differs and has no membership (cross-tenant)', async () => {
    // org-B user, NOT a member of org-A → isUserInOrganization returns false.
    const req: any = {
      user: { sub: 'u-b', organizationId: 'org-B', authMethod: 'jwt' },
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(mcpServersService.isUserInOrganization).toHaveBeenCalledWith(
      'u-b',
      'org-A',
    );
    expect(res.status).toHaveBeenCalledWith(403);
    // Must short-circuit before touching the server's connectors/tools.
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('allows a multi-org user who is a MEMBER of the server org via membership', async () => {
    // Primary org is org-B, but the user is also a member of org-A (the
    // server's org) — must be allowed.
    mcpServersService.isUserInOrganization.mockResolvedValue(true);
    const req: any = {
      user: { sub: 'u-multi', organizationId: 'org-B', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(mcpServersService.isUserInOrganization).toHaveBeenCalledWith(
      'u-multi',
      'org-A',
    );
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('denies when the caller organization cannot be determined (fail closed)', async () => {
    const req: any = { user: { authMethod: 'jwt' } }; // no organizationId
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('does not crash when two connectors expose the same tool name (dedup, no 500)', async () => {
    // Regression: a server with two connectors that both expose
    // "etsy_get_authenticated_user" made the MCP SDK throw
    // "Tool ... is already registered", which 500'd every request.
    const dupTool = (connectorId: string) => ({
      id: `${connectorId}:etsy_get_authenticated_user`,
      connectorId,
      name: 'etsy_get_authenticated_user',
      description: 'whoami',
      parameters: { type: 'object', properties: {} },
      connectorConfig: { envVars: {} },
    });
    mcpServersService.getConnectorIds.mockResolvedValue(['c1', 'c2']);
    toolRegistry.getAllTools.mockReturnValue([dupTool('c1'), dupTool('c2')]);
    const warnSpy = jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const req: any = {
      user: { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    // Must resolve — the duplicate registration used to throw out of the
    // handler (it runs before the transport try/catch).
    await expect(
      controller.handlePost('srv-A', req, res, {}),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate tool name "etsy_get_authenticated_user"'),
    );
  });

  it('demo endpoint serves static tools without touching tenant data', async () => {
    // /mcp/demo must NEVER resolve a server or read connectors — it has no
    // tenant data to leak. Verify the per-server services are never called.
    const req: any = { headers: {}, user: { authMethod: 'none' } };
    const res = makeRes();

    await expect(
      controller.handleDemoPost(req, res, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    ).resolves.toBeUndefined();

    expect(mcpServersService.findById).not.toHaveBeenCalled();
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
    expect(mcpServersService.isUserInOrganization).not.toHaveBeenCalled();
  });

  it('allows a user whose primary org matches the server (zero-query fast path)', async () => {
    const req: any = {
      user: { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    // Primary org matches → no membership query needed.
    expect(mcpServersService.isUserInOrganization).not.toHaveBeenCalled();
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

/**
 * structuredContent is what an MCP client parses when a tool advertises an
 * outputSchema. It used to be rebuilt by re-parsing content[0].text, which
 * silently produced {} for every tool carrying a followUp workflow hint (the
 * appended text is not JSON). The executor now hands back the object directly.
 */
describe('McpEndpointController — structuredContent', () => {
  const TOOL = {
    id: 't1',
    name: 'list_devices',
    description: 'List devices',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { envVars: {} },
    endpointMapping: { method: 'GET', path: '/devices' },
    outputSchema: { type: 'object', properties: { total: {}, devices: {} } },
  };

  function planHandler(executeResult: any) {
    const toolExecutor = { executeTool: jest.fn().mockResolvedValue(executeResult) };
    const controller = new McpEndpointController(
      { findById: jest.fn() } as any,
      { getAllTools: jest.fn().mockReturnValue([]) } as any,
      toolExecutor as any,
      { getAllowedToolIds: jest.fn() } as any,
      { lookup: jest.fn(), isEnabled: jest.fn(), captureIntentEnabled: jest.fn() } as any,
      { get: jest.fn(), add: jest.fn(), remove: jest.fn() } as any,
      { resolve: jest.fn().mockResolvedValue(null) } as any,
      { create: jest.fn() } as any,
    );

    const entries = (controller as any).planToolSet({
      serverTools: [TOOL],
      allowedToolIds: null,
      captureIntent: false,
      invocationContext: { organizationId: 'org-A', mcpServerId: 'srv-A' },
    });

    let handler: any;
    const fakeMcpServer = {
      registerTool: (_n: string, _c: unknown, h: any) => {
        handler = h;
        return {};
      },
    };
    entries.find((e: any) => e.name === 'list_devices').register(fakeMcpServer);
    return handler;
  }

  it('uses the executor object, so a followUp hint no longer empties it', async () => {
    const mapped = { total: 812, devices: [{ hostname: 'PC-01' }] };
    const handler = planHandler({
      content: [
        {
          type: 'text',
          text: `${JSON.stringify(mapped, null, 2)}\n\n---\nWORKFLOW HINT: call get_device next`,
        },
      ],
      structured: mapped,
    });

    const result = await handler({});
    expect(result.structuredContent).toEqual(mapped);
    // Our transport field must not leak into the MCP result.
    expect(result).not.toHaveProperty('structured');
  });

  it('still parses content[0].text when the executor provides no object', async () => {
    const handler = planHandler({
      content: [{ type: 'text', text: '{"total": 812}' }],
    });
    const result = await handler({});
    expect(result.structuredContent).toEqual({ total: 812 });
  });

  it('falls back to {} for a non-object result', async () => {
    const handler = planHandler({
      content: [{ type: 'text', text: '[1,2,3]' }],
      structured: [1, 2, 3],
    });
    const result = await handler({});
    expect(result.structuredContent).toEqual({});
  });

  it('skips structuredContent on an error result', async () => {
    const handler = planHandler({
      content: [{ type: 'text', text: '{"error":"boom"}' }],
      structured: { error: 'boom' },
      isError: true,
    });
    const result = await handler({});
    expect(result.structuredContent).toBeUndefined();
    expect(result).not.toHaveProperty('structured');
    expect(result.isError).toBe(true);
  });
});

/**
 * The knowledge graph reaches the model two ways on a per-server endpoint: the
 * kg_how_to_obtain tool and the knowledge-graph resource. Both must stay inside
 * the connectors the caller's role lets them use, not just the ones assigned to
 * the server.
 */
describe('McpEndpointController — knowledge graph scope', () => {
  const tool = (id: string, connectorId: string) => ({
    id,
    connectorId,
    name: id,
    description: `${id} tool`,
    parameters: { type: 'object', properties: {} },
    connectorConfig: { envVars: {} },
  });
  const serverTools = [tool('crm_get_customer', 'c-crm'), tool('fibu_get_ledger', 'c-fibu')];

  function make() {
    const kgService = {
      lookup: jest.fn().mockResolvedValue({ entities: [] }),
      describeForResource: jest.fn().mockResolvedValue('# Knowledge graph'),
    };
    const controller = new McpEndpointController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      kgService as any,
      {} as any,
      {} as any,
      { create: jest.fn() } as any,
    );
    return { controller: controller as any, kgService };
  }

  const params = (allowedToolIds: string[] | null, kgEnabled = true) => ({
    serverTools,
    allowedToolIds,
    captureIntent: false,
    kgEnabled,
    invocationContext: {
      organizationId: 'org-A',
      authMethod: 'jwt',
      mcpServerId: 'srv-1',
      mcpServerName: 'Sales',
      connectorIds: ['c-crm', 'c-fibu'],
    },
  });

  function fakeServer() {
    const resources: any[] = [];
    const tools = new Map<string, any>();
    return {
      resources,
      tools,
      registerResource: jest.fn((name, uri, meta, read) => {
        resources.push({ name, uri, meta, read });
        return { remove: jest.fn() };
      }),
      registerTool: jest.fn((name, _meta, handler) => {
        tools.set(name, handler);
        return { remove: jest.fn() };
      }),
    };
  }

  async function lookupScope(controller: any, kgService: any, allowed: string[] | null) {
    const entries = controller.planToolSet(params(allowed));
    const server = fakeServer();
    entries.find((e: any) => e.name === 'kg_how_to_obtain').register(server);
    await server.tools.get('kg_how_to_obtain')({ query: 'customer' });
    return kgService.lookup.mock.calls.at(-1)[2].connectorIds;
  }

  it('kg_how_to_obtain only sees the connectors a restricted role can use', async () => {
    const { controller, kgService } = make();
    expect(await lookupScope(controller, kgService, ['crm_get_customer'])).toEqual(['c-crm']);
  });

  it('kg_how_to_obtain still sees every assigned connector for an unrestricted caller', async () => {
    const { controller, kgService } = make();
    expect(await lookupScope(controller, kgService, null)).toEqual(['c-crm', 'c-fibu']);
  });

  it('publishes the knowledge-graph resource, scoped to the role, built on read', async () => {
    const { controller, kgService } = make();
    const server = fakeServer();
    controller.registerKgResource(server, params(['crm_get_customer']));

    expect(server.resources).toHaveLength(1);
    expect(server.resources[0].uri).toBe('anythingmcp://server/srv-1/knowledge-graph');
    expect(server.resources[0].meta.mimeType).toBe('text/markdown');
    expect(kgService.describeForResource).not.toHaveBeenCalled();

    const result = await server.resources[0].read();
    expect(kgService.describeForResource).toHaveBeenCalledWith('org-A', {
      connectorIds: ['c-crm'],
      mcpServerId: 'srv-1',
      serverName: 'Sales',
    });
    expect(result.contents[0]).toEqual({
      uri: 'anythingmcp://server/srv-1/knowledge-graph',
      mimeType: 'text/markdown',
      text: '# Knowledge graph',
    });
  });

  it('publishes no knowledge-graph resource when the graph is off for the workspace', () => {
    const { controller } = make();
    const server = fakeServer();
    controller.registerKgResource(server, params(null, false));
    expect(server.registerResource).not.toHaveBeenCalled();
  });
});

describe('McpEndpointController — skills_save_to_workspace', () => {
  const tool = (name: string) => ({
    id: `t-${name}`,
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { envVars: {} },
    endpointMapping: { method: 'GET', path: '/x' },
  });

  function plan(serverTools: any[], create = jest.fn().mockResolvedValue({ id: 'sk-1', status: 'pending' })) {
    const controller = new McpEndpointController(
      { findById: jest.fn() } as any,
      { getAllTools: jest.fn().mockReturnValue([]) } as any,
      { executeTool: jest.fn() } as any,
      { getAllowedToolIds: jest.fn() } as any,
      { lookup: jest.fn(), isEnabled: jest.fn(), captureIntentEnabled: jest.fn() } as any,
      { get: jest.fn(), add: jest.fn(), remove: jest.fn() } as any,
      { resolve: jest.fn().mockResolvedValue(null) } as any,
      { create } as any,
    );
    const entries = (controller as any).planToolSet({
      serverTools,
      allowedToolIds: null,
      captureIntent: false,
      invocationContext: { organizationId: 'org-A', mcpServerId: 'srv-A', connectorIds: [] },
    });
    return { entries, create };
  }

  it('is offered only on a server that has the Agent Skills Finder', () => {
    expect(plan([tool('list_devices')]).entries.map((e: any) => e.name)).not.toContain(
      'skills_save_to_workspace',
    );
    expect(plan([tool('skills_search'), tool('skills_get')]).entries.map((e: any) => e.name)).toContain(
      'skills_save_to_workspace',
    );
  });

  it('files the skill as a pending suggestion on this server, with its source', async () => {
    const { entries, create } = plan([tool('skills_get')]);
    let handler: any;
    let config: any;
    entries
      .find((e: any) => e.name === 'skills_save_to_workspace')
      .register({
        registerTool: (_n: string, c: unknown, h: any) => {
          config = c;
          handler = h;
          return {};
        },
      });

    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    const result = await handler({
      title: 'README generation',
      whenToUse: 'When asked to write a README',
      instruction: 'Start with a one-line summary, then install, usage, config.',
      sourceUrl: 'https://github.com/bytedance/deer-flow/tree/8bb14fa/skills/public/code-documentation',
      license: 'MIT',
    });

    expect(create).toHaveBeenCalledWith('org-A', {
      title: 'README generation',
      whenToUse: 'When asked to write a README',
      instruction:
        'Start with a one-line summary, then install, usage, config.\n\n' +
        'Source: https://github.com/bytedance/deer-flow/tree/8bb14fa/skills/public/code-documentation (licence: MIT)',
      mcpServerId: 'srv-A',
      status: 'pending',
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ saved: true, id: 'sk-1', status: 'pending' });
  });

  it('yields to a connector tool of the same name', () => {
    const { entries } = plan([tool('skills_get'), tool('skills_save_to_workspace')]);
    expect(entries.filter((e: any) => e.name === 'skills_save_to_workspace')).toHaveLength(1);
    expect(entries.find((e: any) => e.name === 'skills_save_to_workspace').sig).not.toContain(':v1');
  });
});

/**
 * The global /mcp endpoint answers tools/list itself. On the event-stream path
 * the body echoes the request id, so HTML-significant characters are escaped
 * (CodeQL js/reflected-xss); the JSON a client parses must be unchanged.
 */
describe('McpEndpointController — tools/list event stream', () => {
  const OLD = process.env.MCP_STREAMABLE_JSON_RESPONSE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.MCP_STREAMABLE_JSON_RESPONSE;
    else process.env.MCP_STREAMABLE_JSON_RESPONSE = OLD;
  });

  it('escapes < > & in the stream and parses back to the same JSON', () => {
    delete process.env.MCP_STREAMABLE_JSON_RESPONSE;
    const controller = new McpEndpointController(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    ) as any;
    const id = '</script><img src=x onerror=alert(1)>&';
    const req: any = {
      body: { jsonrpc: '2.0', id, method: 'tools/list' },
      visibleTools: [
        {
          id: 't1',
          name: 'crm_get_customer',
          description: 'Get a <customer> & more',
          parameters: { type: 'object', properties: {} },
          connectorConfig: { envVars: {} },
        },
      ],
    };
    let written = '';
    const res: any = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      end: jest.fn((chunk: string) => {
        written = chunk;
      }),
    };

    expect(controller.answerToolsList(req, res, new Set(['t1']))).toBe(true);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(written).not.toMatch(/[<>&]/);
    const parsed = JSON.parse(written.replace(/^event: message\ndata: /, '').trim());
    expect(parsed.id).toBe(id);
    expect(parsed.result.tools[0].description).toBe('Get a <customer> & more');
  });
});

/**
 * Resources and initialize instructions must follow the tool path exactly: a
 * connector contributes text only when at least one of its tools survives both
 * the server assignment and the caller's role. Driven end to end through the
 * real McpServersService (over a fake Prisma that honours the where clauses),
 * the real SDK server and an in-memory MCP client.
 */
describe('McpEndpointController — resources and instructions follow the tool path', () => {
  const ORG_A = 'org-A';
  const ORG_B = 'org-B';

  const CONNECTORS: Record<string, any> = {
    'c-crm': { id: 'c-crm', organizationId: ORG_A, name: 'CRM', instructions: 'CRM-GUIDANCE' },
    'c-fibu': { id: 'c-fibu', organizationId: ORG_A, name: 'Fibu', instructions: 'FIBU-GUIDANCE' },
    // Another tenant's connector, wrongly assigned to srv-1 (corrupt row).
    'c-foreign': {
      id: 'c-foreign',
      organizationId: ORG_B,
      name: 'Foreign',
      instructions: 'FOREIGN-GUIDANCE',
    },
    // Same tenant, but assigned to another server.
    'c-srv2': { id: 'c-srv2', organizationId: ORG_A, name: 'Other', instructions: 'SRV2-GUIDANCE' },
  };
  const SERVERS: Record<string, any> = {
    'srv-1': {
      id: 'srv-1',
      name: 'Sales',
      version: '1.0.0',
      isActive: true,
      organizationId: ORG_A,
      instructions: 'SERVER-GUIDANCE',
    },
    'srv-2': {
      id: 'srv-2',
      name: 'Ops',
      version: '1.0.0',
      isActive: true,
      organizationId: ORG_A,
      instructions: null,
    },
  };
  const ASSIGNMENTS = [
    { mcpServerId: 'srv-1', connectorId: 'c-crm' },
    { mcpServerId: 'srv-1', connectorId: 'c-fibu' },
    { mcpServerId: 'srv-1', connectorId: 'c-foreign' },
    { mcpServerId: 'srv-2', connectorId: 'c-srv2' },
  ];
  const tool = (id: string, connectorId: string) => ({
    id,
    connectorId,
    organizationId: CONNECTORS[connectorId].organizationId,
    name: id,
    description: `${id} tool`,
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://x', authType: 'NONE', envVars: {} },
    endpointMapping: { method: 'GET', path: '/x' },
  });
  const TOOLS = [
    tool('crm_get', 'c-crm'),
    tool('fibu_get', 'c-fibu'),
    tool('foreign_get', 'c-foreign'),
    tool('srv2_get', 'c-srv2'),
  ];

  let resources: any[];
  let rolesService: any;
  let kgService: any;
  let controller: McpEndpointController;
  let built: McpServer | undefined;
  const OLD_STATEFUL = process.env.MCP_STATEFUL_SESSIONS;

  function fakePrisma() {
    const assigned = (serverId: string, connectorId: string) =>
      ASSIGNMENTS.some((a) => a.mcpServerId === serverId && a.connectorId === connectorId);
    return {
      mcpServerConfig: {
        findUnique: jest.fn(async ({ where }: any) => SERVERS[where.id] ?? null),
      },
      mcpServerConnector: {
        findMany: jest.fn(async ({ where }: any) =>
          ASSIGNMENTS.filter((a) => a.mcpServerId === where.mcpServerId)
            .filter((a) => !where.connectorId || where.connectorId.in.includes(a.connectorId))
            .filter(
              (a) =>
                !where.connector ||
                CONNECTORS[a.connectorId].organizationId === where.connector.organizationId,
            )
            .map((a) => ({ connectorId: a.connectorId, connector: CONNECTORS[a.connectorId] })),
        ),
      },
      mcpResource: {
        findMany: jest.fn(async ({ where }: any) =>
          resources
            .filter((r) => where.connectorId.in.includes(r.connectorId))
            .filter(
              (r) => CONNECTORS[r.connectorId].organizationId === where.connector.organizationId,
            )
            .filter((r) => assigned(where.connector.mcpServers.some.mcpServerId, r.connectorId)),
        ),
      },
    };
  }

  const row = (connectorId: string, uri: string, fetchConfig: unknown) => ({
    connectorId,
    uri,
    name: uri,
    description: null,
    mimeType: 'text/markdown',
    fetchConfig,
  });

  beforeEach(() => {
    delete process.env.MCP_STATEFUL_SESSIONS;
    resources = [
      row('c-crm', 'crm://schema', { text: 'CRM-SCHEMA' }),
      row('c-fibu', 'fibu://ledger', { text: 'FIBU-LEDGER' }),
      row('c-foreign', 'foreign://doc', { text: 'FOREIGN-DOC' }),
    ];
    const kgSkills = {
      // A connector-scoped skill on the Fibu connector.
      activeSkillsText: jest.fn(async (_srv: string, ids: string[]) =>
        ids.includes('c-fibu') ? '## Workspace skills\n- FIBU-SKILL' : null,
      ),
    };
    const sessionManager = { get: jest.fn(), add: jest.fn(), remove: jest.fn() };
    const service = new McpServersService(
      fakePrisma() as any,
      kgSkills as any,
      sessionManager as any,
    );
    rolesService = { getAllowedToolIds: jest.fn() };
    kgService = {
      isEnabled: jest.fn().mockResolvedValue(true),
      captureIntentEnabled: jest.fn().mockResolvedValue(false),
      lookup: jest.fn(),
      describeForResource: jest.fn().mockResolvedValue('# Knowledge graph'),
    };
    controller = new McpEndpointController(
      service,
      { getAllTools: () => TOOLS } as any,
      { executeTool: jest.fn() } as any,
      rolesService,
      kgService,
      sessionManager as any,
      { resolve: jest.fn() } as any,
      { create: jest.fn() } as any,
    );
    built = undefined;
    // Keep the server the request built instead of serving it over HTTP.
    jest
      .spyOn(controller as any, 'serveStateless')
      .mockImplementation(async (...args: any[]) => {
        built = args[3]();
      });
    jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (OLD_STATEFUL === undefined) delete process.env.MCP_STATEFUL_SESSIONS;
    else process.env.MCP_STATEFUL_SESSIONS = OLD_STATEFUL;
    jest.restoreAllMocks();
  });

  async function connect(allowedToolIds: string[] | null, serverId = 'srv-1') {
    rolesService.getAllowedToolIds.mockResolvedValue(allowedToolIds);
    const req: any = {
      user: { sub: 'u-1', organizationId: ORG_A, authMethod: 'jwt' },
      headers: {},
    };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.handlePost(serverId, req, res, {});
    expect(built).toBeDefined();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built!.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }

  async function readFailure(client: Client, uri: string): Promise<any> {
    try {
      await client.readResource({ uri });
    } catch (err) {
      return err;
    }
    throw new Error(`read of ${uri} unexpectedly succeeded`);
  }

  /** The error for `uri`, with the URI itself masked, for comparison. */
  async function notFoundShape(client: Client, uri: string) {
    const err = await readFailure(client, uri);
    return { code: err.code, message: String(err.message).split(uri).join('<uri>') };
  }

  it('a role-denied connector yields no resources, no instructions and not-found reads', async () => {
    const client = await connect(['crm_get']);

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        serverInstructionsUri('srv-1'),
        connectorInstructionsUri('srv-1', 'c-crm'),
        'crm://schema',
      ]),
    );
    expect(uris).not.toContain(connectorInstructionsUri('srv-1', 'c-fibu'));
    expect(uris).not.toContain('fibu://ledger');

    // initialize: the denied connector's instructions and its skills are gone.
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('SERVER-GUIDANCE');
    expect(instructions).toContain('CRM-GUIDANCE');
    expect(instructions).not.toContain('FIBU-GUIDANCE');
    expect(instructions).not.toContain('FIBU-SKILL');

    // The composed-instructions resource carries the same scoped text.
    const composed = await client.readResource({ uri: serverInstructionsUri('srv-1') });
    expect((composed.contents[0] as any).text).toBe(instructions);

    // A denied connector's URIs read exactly like URIs that never existed.
    const never = await notFoundShape(
      client,
      connectorInstructionsUri('srv-1', 'c-does-not-exist'),
    );
    expect(await notFoundShape(client, connectorInstructionsUri('srv-1', 'c-fibu'))).toEqual(
      never,
    );
    expect(await notFoundShape(client, 'fibu://ledger')).toEqual(
      await notFoundShape(client, 'fibu://never-existed'),
    );
    expect(never.message).toMatch(/not found/i);
    expect(never.message).not.toMatch(/forbidden|denied|permission/i);

    await client.close();
  });

  it('a caller who sees everything keeps the full instructions', async () => {
    const client = await connect(null);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('SERVER-GUIDANCE');
    expect(instructions).toContain('CRM-GUIDANCE');
    expect(instructions).toContain('FIBU-GUIDANCE');
    expect(instructions).toContain('FIBU-SKILL');

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        connectorInstructionsUri('srv-1', 'c-crm'),
        connectorInstructionsUri('srv-1', 'c-fibu'),
        'crm://schema',
        'fibu://ledger',
      ]),
    );
    await client.close();
  });

  it('a connector of another organization or another server is not-found', async () => {
    const client = await connect(null);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).not.toContain('FOREIGN-GUIDANCE');
    expect(instructions).not.toContain('SRV2-GUIDANCE');

    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).not.toContain(connectorInstructionsUri('srv-1', 'c-foreign'));
    expect(uris).not.toContain('foreign://doc');

    const never = await notFoundShape(client, connectorInstructionsUri('srv-1', 'c-nope'));
    for (const uri of [
      connectorInstructionsUri('srv-1', 'c-foreign'),
      connectorInstructionsUri('srv-1', 'c-srv2'),
      connectorInstructionsUri('srv-2', 'c-srv2'),
      serverInstructionsUri('srv-2'),
    ]) {
      expect(await notFoundShape(client, uri)).toEqual(never);
    }
    expect(await notFoundShape(client, 'foreign://doc')).toEqual(
      await notFoundShape(client, 'foreign://never-existed'),
    );
    await client.close();
  });

  it('serves a stored data object or remote URL as the placeholder, without fetching', async () => {
    resources = [
      row('c-crm', 'crm://config', { data: { apiKey: 'sk_live_SECRET' } }),
      row('c-crm', 'crm://remote', { url: 'https://internal.example/secret.json' }),
    ];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = await connect(['crm_get']);

    for (const uri of ['crm://config', 'crm://remote']) {
      const result = await client.readResource({ uri });
      expect(result.contents).toEqual([
        { uri, mimeType: 'text/plain', text: RESOURCE_PLACEHOLDER_TEXT },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/sk_live_SECRET|internal\.example/);
    }
    const listed = JSON.stringify(await client.listResources());
    expect(listed).not.toMatch(/sk_live_SECRET|internal\.example/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close();
  });

  it('withholds a URI that two visible connectors both claim', async () => {
    resources = [
      row('c-crm', 'shared://doc', { text: 'FROM-CRM' }),
      row('c-fibu', 'shared://doc', { text: 'FROM-FIBU' }),
    ];
    const client = await connect(null);
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).not.toContain('shared://doc');
    expect(await notFoundShape(client, 'shared://doc')).toEqual(
      await notFoundShape(client, 'shared://never-existed'),
    );
    await client.close();
  });

  it('a duplicate is only a duplicate among what the caller can see', async () => {
    resources = [
      row('c-crm', 'shared://doc', { text: 'FROM-CRM' }),
      row('c-fibu', 'shared://doc', { text: 'FROM-FIBU' }),
    ];
    // Fibu is denied, so its claim never enters the plan and CRM's stands.
    const client = await connect(['crm_get']);
    const result = await client.readResource({ uri: 'shared://doc' });
    expect((result.contents[0] as any).text).toBe('FROM-CRM');
    await client.close();
  });

  it('keeps the knowledge-graph resource registered next to the new ones', async () => {
    const client = await connect(['crm_get']);
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain('anythingmcp://server/srv-1/knowledge-graph');
    const kg = await client.readResource({ uri: 'anythingmcp://server/srv-1/knowledge-graph' });
    expect((kg.contents[0] as any).text).toBe('# Knowledge graph');
    expect(kgService.describeForResource).toHaveBeenCalledWith(
      ORG_A,
      expect.objectContaining({ connectorIds: ['c-crm'] }),
    );
    await client.close();
  });

  it('a role allowing no tool on the server sees only server-level text', async () => {
    const client = await connect([]);
    expect(client.getInstructions()).toBe('SERVER-GUIDANCE');
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris.filter((u) => u.includes('/connector/'))).toEqual([]);
    expect(uris).not.toContain('crm://schema');
    await client.close();
  });
});
