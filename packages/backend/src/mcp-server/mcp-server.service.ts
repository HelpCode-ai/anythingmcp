import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ToolRegistry } from './tool-registry';

@Injectable()
export class McpServerService implements OnModuleInit {
  private readonly logger = new Logger(McpServerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing dynamic MCP server...');
    await this.loadAllTools();
    this.logger.log(
      `MCP server ready with ${this.toolRegistry.getToolCount()} tools`,
    );
  }

  async loadAllTools(): Promise<void> {
    const connectors = await this.prisma.connector.findMany({
      where: { isActive: true },
      include: { tools: { where: { isEnabled: true } } },
    });

    for (const connector of connectors) {
      for (const tool of connector.tools) {
        this.toolRegistry.registerTool({
          id: tool.id,
          connectorId: connector.id,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          connectorType: connector.type,
          connectorConfig: {
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig: connector.authConfig ?? undefined,
            headers: connector.headers as Record<string, string> | undefined,
            envVars: connector.envVars as Record<string, string> | undefined,
          },
          endpointMapping: tool.endpointMapping as any,
          responseMapping: tool.responseMapping as Record<string, unknown> | undefined,
        });
      }
    }
  }

  async reloadConnectorTools(connectorId: string): Promise<void> {
    this.toolRegistry.unregisterConnectorTools(connectorId);

    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      include: { tools: { where: { isEnabled: true } } },
    });

    if (connector && connector.isActive) {
      for (const tool of connector.tools) {
        this.toolRegistry.registerTool({
          id: tool.id,
          connectorId: connector.id,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          connectorType: connector.type,
          connectorConfig: {
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig: connector.authConfig ?? undefined,
            headers: connector.headers as Record<string, string> | undefined,
            envVars: connector.envVars as Record<string, string> | undefined,
          },
          endpointMapping: tool.endpointMapping as any,
          responseMapping: tool.responseMapping as Record<string, unknown> | undefined,
        });
      }
    }

    this.logger.log(
      `Reloaded tools for connector ${connectorId}. Total tools: ${this.toolRegistry.getToolCount()}`,
    );
  }
}
