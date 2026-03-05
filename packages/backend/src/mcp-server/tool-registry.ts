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
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool in the runtime registry.
   */
  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered MCP tool: ${tool.name}`);
  }

  /**
   * Unregister all tools belonging to a connector.
   */
  unregisterConnectorTools(connectorId: string): void {
    for (const [name, tool] of this.tools.entries()) {
      if (tool.connectorId === connectorId) {
        this.tools.delete(name);
        this.logger.debug(`Unregistered MCP tool: ${name}`);
      }
    }
  }

  /**
   * Get a tool definition by name.
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get the count of registered tools.
   */
  getToolCount(): number {
    return this.tools.size;
  }
}
