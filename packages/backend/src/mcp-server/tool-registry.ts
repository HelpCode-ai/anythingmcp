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
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  connectorType: string;
  connectorConfig: {
    baseUrl: string;
    authType: string;
    authConfig?: string; // decrypted JSON string
    headers?: Record<string, string>;
    envVars?: Record<string, string>; // runtime environment variables
    config?: Record<string, unknown>; // connector-specific settings (e.g. readOnly for DATABASE)
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
}

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  // Keyed by tool.id (globally unique) to prevent cross-org name collisions
  private readonly toolsById = new Map<string, RegisteredTool>();
  // Secondary index by name for backward-compatible lookups (within a filtered set)
  private readonly toolsByName = new Map<string, RegisteredTool[]>();

  /**
   * Register a tool in the runtime registry.
   */
  registerTool(tool: RegisteredTool): void {
    this.toolsById.set(tool.id, tool);
    // Append to name index (multiple tools can share a name across orgs)
    const existing = this.toolsByName.get(tool.name) || [];
    existing.push(tool);
    this.toolsByName.set(tool.name, existing);
    this.logger.debug(`Registered MCP tool: ${tool.name} (${tool.id})`);
  }

  /**
   * Unregister all tools belonging to a connector.
   */
  unregisterConnectorTools(connectorId: string): void {
    for (const [id, tool] of this.toolsById.entries()) {
      if (tool.connectorId === connectorId) {
        this.toolsById.delete(id);
        this.logger.debug(`Unregistered MCP tool: ${tool.name} (${id})`);
      }
    }
    // Rebuild name index
    this.toolsByName.clear();
    for (const tool of this.toolsById.values()) {
      const existing = this.toolsByName.get(tool.name) || [];
      existing.push(tool);
      this.toolsByName.set(tool.name, existing);
    }
  }

  /**
   * Get a tool definition by name, optionally scoped to connector IDs.
   * When connectorIds is provided, only returns a tool from those connectors.
   */
  getTool(name: string, connectorIds?: string[]): RegisteredTool | undefined {
    const candidates = this.toolsByName.get(name);
    if (!candidates || candidates.length === 0) return undefined;
    if (!connectorIds) return candidates[0];
    return candidates.find((t) => connectorIds.includes(t.connectorId));
  }

  /**
   * Get all registered tools.
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.toolsById.values());
  }

  /**
   * Get the count of registered tools.
   */
  getToolCount(): number {
    return this.toolsById.size;
  }
}
