import type { SetupStatus } from '../connectors/connector-setup-status.util';
import { processGauges } from '../common/process-vitals';
import { Injectable, Logger } from '@nestjs/common';

/**
 * ToolRegistry — runtime registry of dynamic MCP tools.
 *
 * Each registered tool maps to a connector + endpoint. When an MCP client
 * calls a tool, the registry routes the call to the correct connector engine.
 *
 * This is the bridge between MCP protocol and the Connector Engine.
 */

export interface RegisteredTool {
  id: string;
  connectorId: string;
  // organizationId of the connector that owns this tool. Used to scope
  // by-name lookups so cross-tenant collisions on the global /mcp endpoint
  // can't leak tools across organizations.
  organizationId: string;
  // The connector's name, for messages that tell the user which one to open.
  connectorName?: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  connectorType: string;
  // Per-tool preference to route the outbound request through the
  // proxy / web-unblocker. Mirrors mcp_tools.use_proxy. The actual
  // decision (env present, license, rate-limit) is made at call time.
  useProxy?: boolean;
  connectorConfig: {
    baseUrl: string;
    authType: string;
    authConfig?: string; // decrypted JSON string
    headers?: Record<string, string>;
    envVars?: Record<string, string>; // runtime environment variables
    config?: Record<string, unknown>; // connector-specific settings (e.g. readOnly for DATABASE)
    // USER: each call carries the caller's own sign-in (UserCredentialsService),
    // never the tokens in authConfig. Undefined counts as SHARED.
    credentialScope?: 'SHARED' | 'USER';
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
    // Response headers the tool wants back with the body (REST only). The
    // usual reason is `["link"]`: cursor pagination lives in that header,
    // and without it every list tool is exactly one page long.
    exposeHeaders?: string[];
  };
  responseMapping?: Record<string, unknown>;
  // JSON Schema of the response, served to clients as the tool's outputSchema.
  outputSchema?: unknown;
  // Explicit MCP tool annotations: an admin override, or the annotations
  // reported by an upstream MCP server. Layered over the derived ones.
  annotations?: unknown;
  // Whether the owning connector can serve calls yet (see
  // connector-setup-status.util). Undefined counts as ready: tools registered
  // outside McpServerService (tests, previews) keep being listed.
  setupStatus?: SetupStatus;
}

/** True when a tool's connector is fully set up, so the tool may be listed. */
export function isListable(tool: RegisteredTool): boolean {
  return tool.setupStatus === undefined || tool.setupStatus === 'ready';
}

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  // Keyed by tool.id (globally unique) to prevent cross-org name collisions
  private readonly toolsById = new Map<string, RegisteredTool>();
  // Secondary index by name for backward-compatible lookups (within a filtered
  // set). A Map per name, like the other indexes, so dropping one tool from a
  // name shared by thousands of installs of a catalog adapter costs O(1).
  private readonly toolsByName = new Map<string, Map<string, RegisteredTool>>();
  // Per-organization and per-connector indexes, so a request reads its own
  // tools instead of copying and filtering the whole registry (134k tools on
  // Cloud in Nov 2026, once per /mcp request). Each keeps the registry's
  // insertion order; `order` lets a multi-connector read restore it.
  private readonly toolsByOrg = new Map<string, Map<string, RegisteredTool>>();
  private readonly toolsByConnector = new Map<string, Map<string, RegisteredTool>>();
  private readonly order = new Map<string, number>();
  private nextOrder = 0;

  constructor() {
    // The registry is the largest long-lived structure in the process (it
    // outgrew a 2 GB heap on 10 Sep). Its size belongs in every vitals line.
    processGauges.register('registeredTools', () => this.toolsById.size);
  }

  /**
   * Register a tool in the runtime registry.
   */
  registerTool(tool: RegisteredTool): void {
    const previous = this.toolsById.get(tool.id);
    if (previous) {
      if (previous.organizationId !== tool.organizationId) {
        this.removeFromIndex(this.toolsByOrg, previous.organizationId, tool.id);
      }
      if (previous.connectorId !== tool.connectorId) {
        this.removeFromIndex(this.toolsByConnector, previous.connectorId, tool.id);
      }
    } else {
      this.order.set(tool.id, this.nextOrder++);
    }
    this.toolsById.set(tool.id, tool);
    this.addToIndex(this.toolsByOrg, tool.organizationId, tool);
    this.addToIndex(this.toolsByConnector, tool.connectorId, tool);
    // Name index (multiple tools can share a name across orgs). A tool
    // registered again under the same id replaces its old entry in place, so
    // the name keeps one entry per tool and its first-registered order.
    if (previous && previous.name !== tool.name) {
      this.removeFromIndex(this.toolsByName, previous.name, tool.id);
    }
    this.addToIndex(this.toolsByName, tool.name, tool);
    this.logger.debug(`Registered MCP tool: ${tool.name} (${tool.id})`);
  }

  /**
   * Unregister all tools belonging to a connector.
   *
   * Reads only that connector's tools through the per-connector index. It
   * used to walk the whole registry and then rebuild the name index from
   * scratch: two passes over every tool of every organization (316k on Cloud
   * in Nov 2026) for each reload, and a dashboard tool toggle reloads its
   * connector. A burst of toggles, or a registry catch-up after a busy day,
   * then held the event loop long enough to slow every /mcp request.
   */
  unregisterConnectorTools(connectorId: string): void {
    const tools = this.toolsByConnector.get(connectorId);
    if (!tools) return;
    for (const [id, tool] of tools) {
      this.toolsById.delete(id);
      this.order.delete(id);
      this.removeFromIndex(this.toolsByOrg, tool.organizationId, id);
      this.removeFromIndex(this.toolsByName, tool.name, id);
      this.logger.debug(`Unregistered MCP tool: ${tool.name} (${id})`);
    }
    this.toolsByConnector.delete(connectorId);
  }

  /**
   * Get a tool definition by name, optionally scoped to connector IDs.
   * When connectorIds is provided, only returns a tool from those connectors.
   */
  getTool(name: string, connectorIds?: string[]): RegisteredTool | undefined {
    const candidates = this.toolsByName.get(name);
    if (!candidates) return undefined;
    for (const t of candidates.values()) {
      if (!connectorIds || connectorIds.includes(t.connectorId)) return t;
    }
    return undefined;
  }

  /**
   * Get a tool definition by name, scoped to a single organization. Used by
   * the global /mcp endpoint when an authenticated user invokes a tool by
   * name — without this, two organizations that happen to define a tool
   * called `weclapp_list_articles` would resolve to whichever was registered
   * first (cross-tenant leak).
   */
  getToolForOrg(
    name: string,
    organizationId: string,
  ): RegisteredTool | undefined {
    const candidates = this.toolsByName.get(name);
    if (!candidates) return undefined;
    for (const t of candidates.values()) {
      if (t.organizationId === organizationId) return t;
    }
    return undefined;
  }

  /**
   * Get all registered tools.
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.toolsById.values());
  }

  /** The tools of one organization, in registration order. */
  getToolsForOrganization(organizationId: string): RegisteredTool[] {
    const tools = this.toolsByOrg.get(organizationId);
    return tools ? Array.from(tools.values()) : [];
  }

  /**
   * The tools of the given connectors, in registration order: the same list
   * as `getAllTools().filter((t) => ids.includes(t.connectorId))`, without
   * reading the rest of the registry.
   */
  getToolsForConnectors(connectorIds: Iterable<string>): RegisteredTool[] {
    const out: RegisteredTool[] = [];
    for (const id of new Set(connectorIds)) {
      const tools = this.toolsByConnector.get(id);
      if (tools) out.push(...tools.values());
    }
    return out.sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0));
  }

  private addToIndex(
    index: Map<string, Map<string, RegisteredTool>>,
    key: string,
    tool: RegisteredTool,
  ): void {
    let bucket = index.get(key);
    if (!bucket) index.set(key, (bucket = new Map()));
    bucket.set(tool.id, tool);
  }

  private removeFromIndex(
    index: Map<string, Map<string, RegisteredTool>>,
    key: string,
    id: string,
  ): void {
    const bucket = index.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  /**
   * Tools whose connector is fully set up: what tools/list and the shared
   * endpoint may show. A connector still missing a credential or an OAuth
   * authorization stays registered (a call by name gets the precise error)
   * but is not offered to the model.
   */
  getListableTools(): RegisteredTool[] {
    return this.getAllTools().filter(isListable);
  }

  /**
   * Count how many tools share a given name across all orgs/connectors.
   * Used by McpServerService to decide whether a tool name is already
   * exposed in the upstream MCP library's (single-tenant) registry.
   */
  countByName(name: string): number {
    return this.toolsByName.get(name)?.size ?? 0;
  }

  /**
   * How many tools each connector has in the registry. Compared against the
   * database by McpServerService.catchUpRegistry to find connectors whose
   * tool set changed without this process hearing about it.
   */
  countByConnector(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [connectorId, tools] of this.toolsByConnector) {
      counts.set(connectorId, tools.size);
    }
    return counts;
  }

  /**
   * Get the count of registered tools.
   */
  getToolCount(): number {
    return this.toolsById.size;
  }
}
