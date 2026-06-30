import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Req,
  Res,
  Body,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpCombinedAuthGuard } from '../auth/mcp-combined-auth.guard';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpSessionManager } from '../mcp-servers/mcp-session.manager';
import { ToolRegistry, RegisteredTool } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RolesService } from '../roles/roles.service';
import { registerDemoTools } from './mcp-demo.tools';
import { KgService } from '../knowledge-graph/kg.service';
import { outputSchemaToZodShape } from '../connectors/output-schema.util';

/** Minimal handle returned by McpServer.tool()/registerTool() that we keep so a
 * live (stateful) session can drop a tool when its surface changes. */
type ToolHandle = { remove: () => void };

/** A planned tool registration: its name, a content signature (changes when the
 * tool's shape changes), and a thunk that performs the registration. */
interface ToolEntry {
  name: string;
  sig: string;
  register: (mcpServer: McpServer) => ToolHandle;
}

/** A live session's registered tools, keyed by name, with each tool's current
 * signature so reconciliation can touch only what actually changed. */
type SessionHandles = Map<string, { handle: ToolHandle; sig: string }>;

/** Inputs needed to (re)compute a server's exposed tool set. The principal and
 * org are fixed for a session; the tool surface and role allowlist are not. */
interface ToolSetParams {
  serverTools: RegisteredTool[];
  allowedToolIds: string[] | null;
  captureIntent: boolean;
  kgEnabled: boolean;
  invocationContext: InvocationContext;
}

interface InvocationContext {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  authMethod: string;
  apiKeyName?: string;
  mcpServerId: string;
  mcpServerName: string;
  connectorIds: string[];
  intent?: string;
}

/**
 * Per-server MCP endpoint controller.
 *
 * Handles POST/GET/DELETE at /mcp/:serverId, creating a fresh MCP server
 * per request that only exposes tools from connectors assigned to that server.
 *
 * This solves the single-endpoint limitation of @rekog/mcp-nest by giving
 * each MCP server its own unique URL that clients like Claude Desktop
 * can connect to independently (via OAuth or API key).
 */
@Controller('mcp')
@SkipThrottle()
@UseGuards(McpCombinedAuthGuard)
export class McpEndpointController {
  private readonly logger = new Logger(McpEndpointController.name);

  constructor(
    private readonly mcpServersService: McpServersService,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: DynamicMcpTools,
    private readonly rolesService: RolesService,
    private readonly kgService: KgService,
    private readonly sessionManager: McpSessionManager,
  ) {}

  // Streamable-HTTP response framing. Default: SSE-framed responses
  // (`text/event-stream`), the spec-standard envelope that also carries
  // streaming and server-initiated notifications. Set
  // MCP_STREAMABLE_JSON_RESPONSE=true for single-shot `application/json`
  // responses instead — required by Microsoft Copilot Studio, whose MCP
  // client cannot deserialize SSE-framed responses ("response could not be
  // deserialized as JSON"). JSON is spec-compliant and handled by every
  // compliant client (incl. Claude); the cloud deployment enables it by
  // default (see docker-compose.cloud.yml).
  private jsonResponseEnabled(): boolean {
    return process.env.MCP_STREAMABLE_JSON_RESPONSE === 'true';
  }

  // ─── Public, anonymous, static demo MCP server ──────────────────────────
  // A self-describing MCP endpoint at the EXACT path /mcp/demo. It exposes only
  // static "how to use AnythingMCP" tools and NEVER resolves a serverId, queries
  // the database, or touches connectors / tenant data — so it has nothing to
  // leak. Exists so directory crawlers (Glama, Smithery, mcp.so) and agents can
  // introspect a working MCP server without auth. The auth guard exempts ONLY
  // this exact path; every /mcp/:serverId stays fail-closed.
  //
  // MUST be declared BEFORE the ':serverId' routes so the static "demo" segment
  // wins route matching (otherwise it'd resolve as serverId="demo").
  @Post('demo')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async handleDemoPost(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    await this.handleDemoRequest(req, res, body);
  }

  @Get('demo')
  handleDemoGet(@Req() _req: Request, @Res() res: Response) {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  @Post(':serverId')
  async handlePost(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    await this.handleMcpRequest(serverId, req, res, body);
  }

  @Get(':serverId')
  async handleGet(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // In stateful mode the GET opens the long-lived SSE stream that carries
    // server-initiated notifications (e.g. tools/list_changed). Route it to the
    // client's existing session; otherwise GET is unsupported (stateless).
    if (await this.routeToSession(serverId, req, res)) return;
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  @Delete(':serverId')
  async handleDelete(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // In stateful mode a DELETE terminates the client's session.
    if (await this.routeToSession(serverId, req, res)) return;
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  /**
   * Handle the public demo MCP server. Builds a per-request McpServer with only
   * the static info tools (see registerDemoTools) — no DB, no connectors, no
   * tenant resolution. Never reaches any of the per-server logic below.
   */
  private async handleDemoRequest(
    req: Request,
    res: Response,
    body: unknown,
  ) {
    const mcpServer = new McpServer(
      { name: 'AnythingMCP Demo', version: '1.0.0' },
      {
        instructions:
          'Public, read-only demo of AnythingMCP. These tools describe the ' +
          'product and how to use it; they expose no customer data. Start with ' +
          'anythingmcp_overview.',
      },
    );
    registerDemoTools(mcpServer);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: this.jsonResponseEnabled(),
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(`Error handling demo MCP request: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      try {
        await transport.close();
        await mcpServer.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async handleMcpRequest(
    serverId: string,
    req: Request,
    res: Response,
    body: unknown,
  ) {
    // Stateful reuse: a POST carrying a known, owned session id is routed
    // straight to that session's live transport (skips rebuilding the server).
    if (await this.routeToSession(serverId, req, res, body)) return;

    // 1. Resolve the MCP server
    const mcpServerConfig = await this.mcpServersService.findById(serverId);
    if (!mcpServerConfig) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP server not found' },
        id: null,
      });
    }

    if (!mcpServerConfig.isActive) {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP server is inactive' },
        id: null,
      });
    }

    // Tenant isolation: a request scoped to a specific server must come from a
    // principal who is a MEMBER of that server's organization. Fail closed —
    // deny when membership can't be established. Instance-level static
    // credentials (self-host, not organization-scoped) are exempt.
    //
    // Membership is checked against organization_members, not just the user's
    // primary `organizationId` column: a user who belongs to several
    // workspaces must reach servers in any org they're a member of, while a
    // non-member is still denied. The primary-org match is kept as a
    // zero-query fast path for the common single-org case.
    const user = (req as any).user;
    const isInstanceLevel =
      user?.authMethod === 'static_api_key' ||
      user?.authMethod === 'static_bearer' ||
      user?.authMethod === 'none';
    if (!isInstanceLevel) {
      const serverOrg = mcpServerConfig.organizationId;
      const primaryOrgMatches =
        !!user?.organizationId && user.organizationId === serverOrg;
      const isMember =
        primaryOrgMatches ||
        (!!user?.sub &&
          !!serverOrg &&
          (await this.mcpServersService.isUserInOrganization(
            user.sub,
            serverOrg,
          )));
      if (!isMember) {
        return res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Access denied' },
          id: null,
        });
      }
    }

    // 2. Get connector IDs and composed instructions for this server
    const [connectorIds, instructions] = await Promise.all([
      this.mcpServersService.getConnectorIds(serverId),
      this.mcpServersService.getComposedInstructions(serverId),
    ]);

    // 3. Filter tools to only those from assigned connectors
    const allTools = this.toolRegistry.getAllTools();
    const serverTools = allTools.filter((t) => connectorIds.includes(t.connectorId));

    // 4. Further filter by role-based access if user is identified
    let allowedToolIds: string[] | null = null;
    if (user?.sub) {
      allowedToolIds = await this.rolesService.getAllowedToolIds(user.sub);
    }

    // 5. Create a per-request MCP server with only the assigned tools
    const mcpServer = new McpServer(
      { name: mcpServerConfig.name, version: mcpServerConfig.version || '1.0.0' },
      { instructions },
    );

    // Build invocation context for audit logging and tool scoping
    // OAuth JWTs store email inside user_data, app JWTs have it top-level
    const invocationContext = {
      userId: user?.sub as string | undefined,
      userEmail: (user?.email || user?.user_data?.email) as string | undefined,
      organizationId:
        (user?.organizationId as string | undefined) ||
        mcpServerConfig.organizationId,
      authMethod: (user?.authMethod || 'none') as string,
      apiKeyName: user?.apiKeyName as string | undefined,
      mcpServerId: mcpServerConfig.id,
      mcpServerName: mcpServerConfig.name,
      connectorIds,
      intent: undefined as string | undefined,
    };

    // Optional: ask the calling agent to pass the user's originating request on
    // every tool call, so we capture the intent/context behind it (used later to
    // optimize the graph and suggest skills). Per-workspace switch, default off.
    const captureIntent = invocationContext.organizationId
      ? await this.kgService.captureIntentEnabled(invocationContext.organizationId)
      : false;
    const kgEnabled =
      process.env.KG_MCP_TOOL !== 'off' && !!invocationContext.organizationId
        ? await this.kgService.isEnabled(invocationContext.organizationId)
        : false;

    const params: ToolSetParams = {
      serverTools,
      allowedToolIds,
      captureIntent,
      kgEnabled,
      invocationContext,
    };

    // Register this server's tool surface onto the per-request McpServer.
    const entries = this.planToolSet(params);
    const handles = this.registerAll(mcpServer, entries, serverId);
    const signature = this.aggregateSig(entries);

    // 6. Create transport and handle the request — stateless by default, or a
    // long-lived session when MCP_STATEFUL_SESSIONS is enabled. Stateful keeps
    // an SSE channel open so we can push notifications/tools/list_changed when a
    // connector or assignment changes, instead of clients needing a refresh.
    if (McpSessionManager.isEnabled()) {
      await this.handleStatefulRequest(
        serverId,
        req,
        res,
        body,
        user,
        mcpServer,
        handles,
        signature,
        captureIntent,
        kgEnabled,
        invocationContext,
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: this.jsonResponseEnabled(),
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(`Error handling MCP request for server ${serverId}: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      // Clean up stateless server
      try {
        await transport.close();
        await mcpServer.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Stable identity of the principal behind a request, used to bind a stateful
   * session to its owner so a guessed/stolen session id can't be driven by a
   * different principal.
   */
  private principalKey(user: any): string {
    if (!user) return 'anon';
    if (user.sub) return `sub:${user.sub}`;
    if (user.apiKeyName) return `key:${user.apiKeyName}`;
    return `static:${user.authMethod || 'none'}`;
  }

  /** Does this live session belong to the current request's principal+server? */
  private sessionOwns(
    session: { serverId: string; principalKey: string },
    serverId: string,
    req: Request,
  ): boolean {
    return (
      session.serverId === serverId &&
      session.principalKey === this.principalKey((req as any).user)
    );
  }

  /**
   * If stateful mode is on and the request carries a known, owned session id,
   * route it to that session's live transport and return true. Returns false
   * when there's nothing to route (stateless, or no session header) so the
   * caller can fall back to its default handling.
   */
  private async routeToSession(
    serverId: string,
    req: Request,
    res: Response,
    body?: unknown,
  ): Promise<boolean> {
    if (!McpSessionManager.isEnabled()) return false;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) return false;

    const session = this.sessionManager.get(sessionId);
    if (!session || !this.sessionOwns(session, serverId, req)) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return true;
    }

    this.sessionManager.touch(sessionId, Date.now());
    try {
      await session.transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(
        `Error routing MCP request to session ${sessionId}: ${error.message}`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
    return true;
  }

  /**
   * Create a new stateful session: a transport with a generated session id, an
   * SSE channel for server-initiated notifications, and a registered session
   * whose tool set can be reconciled on demand.
   */
  private async handleStatefulRequest(
    serverId: string,
    req: Request,
    res: Response,
    body: unknown,
    user: any,
    mcpServer: McpServer,
    handles: SessionHandles,
    signature: string,
    captureIntent: boolean,
    kgEnabled: boolean,
    invocationContext: InvocationContext,
  ) {
    const principalKey = this.principalKey(user);
    let sessionId: string | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: this.jsonResponseEnabled(),
      onsessioninitialized: (sid) => {
        sessionId = sid;
        this.sessionManager.add({
          sessionId: sid,
          serverId,
          organizationId: invocationContext.organizationId ?? null,
          principalKey,
          transport,
          mcpServer,
          handles,
          signature,
          rebuild: this.makeRebuild(
            sid,
            serverId,
            user,
            captureIntent,
            kgEnabled,
            invocationContext,
          ),
          lastActivity: Date.now(),
        });
      },
      onsessionclosed: (sid) => {
        void this.sessionManager.remove(sid);
      },
    });
    transport.onclose = () => {
      if (sessionId) void this.sessionManager.remove(sessionId);
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(
        `Error handling stateful MCP request for server ${serverId}: ${error.message}`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
      // If the session never registered, nothing will clean it up — do it here.
      if (!sessionId) {
        try {
          await transport.close();
          await mcpServer.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Build a closure that reconciles a live session's tool set against the
   * current registry. No-op unless THIS session's surface actually changed
   * (cheap to call broadly). On change: drop the old tools, register the new
   * set, and emit tools/list_changed so the client refetches.
   *
   * Note: principal, org, intent/KG switches are fixed at session creation;
   * toggling those org settings mid-session only takes effect on reconnect.
   */
  private makeRebuild(
    sessionId: string,
    serverId: string,
    user: any,
    captureIntent: boolean,
    kgEnabled: boolean,
    invocationContext: InvocationContext,
  ): () => Promise<void> {
    return async () => {
      const session = this.sessionManager.get(sessionId);
      if (!session) return;

      // Re-fetch connector ids so newly (un)assigned connectors are reflected.
      const connectorIds = await this.mcpServersService.getConnectorIds(serverId);
      const serverTools = this.toolRegistry
        .getAllTools()
        .filter((t) => connectorIds.includes(t.connectorId));
      let allowedToolIds: string[] | null = null;
      if (user?.sub) {
        allowedToolIds = await this.rolesService.getAllowedToolIds(user.sub);
      }

      const entries = this.planToolSet({
        serverTools,
        allowedToolIds,
        captureIntent,
        kgEnabled,
        invocationContext,
      });
      const signature = this.aggregateSig(entries);
      if (signature === session.signature) return; // nothing changed here

      // Reconcile by name so we only touch tools that actually changed: each
      // register()/remove() makes the SDK emit tools/list_changed, so a full
      // rebuild would flood the client. A diff keeps notifications proportional.
      const current = session.handles;
      const desired = new Map(entries.map((e) => [e.name, e]));
      for (const [name, cur] of current) {
        const want = desired.get(name);
        if (!want || want.sig !== cur.sig) {
          try {
            cur.handle.remove();
          } catch {
            // Ignore — tool may already be gone.
          }
          current.delete(name);
        }
      }
      for (const e of entries) {
        if (current.has(e.name)) continue;
        try {
          current.set(e.name, { handle: e.register(session.mcpServer), sig: e.sig });
        } catch (err: any) {
          this.logger.warn(
            `Failed to register a tool on server ${serverId}: ${err.message}`,
          );
        }
      }
      session.signature = signature;
    };
  }

  /**
   * Compute the ordered set of tool registrations for a server, plus a content
   * signature used to detect when the set has actually changed. Pure: builds
   * registration thunks but does not touch any McpServer.
   */
  private planToolSet(params: ToolSetParams): ToolEntry[] {
    const { serverTools, allowedToolIds, captureIntent, invocationContext } =
      params;
    const entries: ToolEntry[] = [];
    const registeredNames = new Set<string>();

    for (const tool of serverTools) {
      // Skip tools not allowed by role
      if (allowedToolIds !== null && !allowedToolIds.includes(tool.id)) continue;
      // Dedupe by tool name. Two connectors can expose the same name (same
      // connector assigned twice, or two configs of one provider); the SDK
      // throws on the second registration, which would 500 the whole request.
      if (registeredNames.has(tool.name)) {
        this.logger.warn(
          `Duplicate tool name "${tool.name}" on server ${invocationContext.mcpServerId} — skipping the extra copy (check for duplicate connector assignments).`,
        );
        continue;
      }
      registeredNames.add(tool.name);

      const schema = this.stripEnvVarParams(
        tool.parameters,
        tool.connectorConfig.envVars,
      );
      const zodShape = this.jsonSchemaToZodShape(schema);
      if (captureIntent) {
        zodShape._intent = z
          .string()
          .optional()
          .describe(
            "The user's natural-language request that led to this tool call (verbatim). " +
              'Helps this workspace understand and improve its tooling. Optional but encouraged.',
          );
      }
      // Permissive output shape (only for object-shaped inferred schemas).
      const outShape = tool.outputSchema
        ? outputSchemaToZodShape(tool.outputSchema)
        : null;

      const sig = [
        tool.name,
        tool.description,
        Object.keys(zodShape).sort().join(','),
        outShape ? Object.keys(outShape).sort().join(',') : '',
      ].join('');

      entries.push({
        name: tool.name,
        sig,
        register: (mcpServer: McpServer) => {
          const handler = async (args: any) => {
            let ctx = invocationContext;
            let toolArgs = args;
            if (captureIntent && args && typeof args === 'object') {
              const { _intent, ...rest } = args;
              toolArgs = rest;
              if (_intent)
                ctx = { ...invocationContext, intent: String(_intent).slice(0, 2000) };
            }
            const result = await this.toolExecutor.executeTool(
              tool.name,
              toolArgs,
              ctx,
            );
            // When an outputSchema is advertised, the SDK requires
            // structuredContent on success. Provide the parsed object
            // (permissive schema never fails); errors skip validation.
            if (outShape && !result.isError) {
              let structured: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(result.content?.[0]?.text ?? '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                  structured = parsed;
              } catch {
                /* keep {} */
              }
              return { ...result, structuredContent: structured };
            }
            return result;
          };

          if (outShape) {
            return mcpServer.registerTool(
              tool.name,
              {
                description: tool.description,
                inputSchema: zodShape,
                outputSchema: outShape,
              },
              handler,
            ) as unknown as ToolHandle;
          }
          return mcpServer.tool(
            tool.name,
            tool.description,
            zodShape,
            handler,
          ) as unknown as ToolHandle;
        },
      });
    }

    // Inject the org-level Knowledge Graph helper tool. Lets the agent ask
    // "how do I obtain X / what relates to X" and chain tools across connectors.
    if (
      params.kgEnabled &&
      invocationContext.organizationId &&
      !registeredNames.has('kg_how_to_obtain')
    ) {
      const orgId = invocationContext.organizationId;
      const scopeConnectorIds = invocationContext.connectorIds;
      const scopeServerId = invocationContext.mcpServerId;
      entries.push({
        name: 'kg_how_to_obtain',
        sig: 'kg_how_to_obtain',
        register: (mcpServer: McpServer) =>
          mcpServer.tool(
            'kg_how_to_obtain',
            'Knowledge graph for THIS MCP server: given an entity or a parameter you need ' +
              '(e.g. "customer_id", "order", "person"), returns which entities/tools produce ' +
              'or relate to it across the connectors assigned to this server, plus any ' +
              'human-written descriptions and the workspace skills (pre-built workflows) you ' +
              'can use. Relationships are learned from these connectors, real usage, and ' +
              'curated edits, so you can chain tool calls.',
            {
              query: z
                .string()
                .describe('An entity or parameter name, e.g. "customer_id" or "deal".'),
            },
            async (args: { query: string }) => {
              const result = await this.kgService.lookup(orgId, args.query, {
                connectorIds: scopeConnectorIds,
                mcpServerId: scopeServerId,
              });
              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify(result, null, 2) },
                ],
              };
            },
          ) as unknown as ToolHandle,
      });
    }

    return entries;
  }

  /** Aggregate content signature of a planned tool set. */
  private aggregateSig(entries: ToolEntry[]): string {
    return entries.map((e) => e.sig).join('\n');
  }

  /** Register a whole planned tool set, returning the by-name handle map. */
  private registerAll(
    mcpServer: McpServer,
    entries: ToolEntry[],
    serverId: string,
  ): SessionHandles {
    const handles: SessionHandles = new Map();
    for (const e of entries) {
      try {
        handles.set(e.name, { handle: e.register(mcpServer), sig: e.sig });
      } catch (err: any) {
        this.logger.warn(
          `Failed to register a tool on server ${serverId}: ${err.message}`,
        );
      }
    }
    return handles;
  }

  /**
   * Convert a JSON Schema to a Zod raw shape for McpServer.tool() registration.
   */
  private jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
    const properties = schema?.properties as Record<string, any> | undefined;
    if (!properties) return {};

    const required = (schema?.required as string[]) || [];
    const shape: Record<string, z.ZodType> = {};

    for (const [key, prop] of Object.entries(properties)) {
      let zodType: z.ZodType;

      switch (prop.type) {
        case 'string':
          zodType = prop.enum
            ? z.enum(prop.enum as [string, ...string[]])
            : z.string();
          break;
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
          break;
        case 'array':
          zodType = z.array(z.any());
          break;
        case 'object':
          zodType = z.record(z.string(), z.any());
          break;
        default:
          zodType = z.any();
      }

      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      if (prop.default !== undefined) {
        zodType = zodType.default(prop.default);
      }

      if (!required.includes(key)) {
        zodType = zodType.optional();
      }

      shape[key] = zodType;
    }

    return shape;
  }

  /**
   * Remove parameters covered by connector env vars.
   */
  private stripEnvVarParams(
    schema: Record<string, unknown>,
    envVars?: Record<string, string>,
  ): Record<string, unknown> {
    if (!envVars || Object.keys(envVars).length === 0) return schema;

    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties) return schema;

    const envKeys = new Set(Object.keys(envVars));
    const newProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!envKeys.has(key)) {
        newProperties[key] = value;
      }
    }

    const required = (schema.required as string[]) || [];
    const newRequired = required.filter((k) => !envKeys.has(k));

    return {
      ...schema,
      properties: newProperties,
      ...(newRequired.length > 0 ? { required: newRequired } : {}),
    };
  }
}
