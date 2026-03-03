import { Module } from '@nestjs/common';
import { McpServerService } from './mcp-server.service';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { McpEndpointController } from './mcp-endpoint.controller';
import { McpCombinedAuthGuard } from '../auth/mcp-combined-auth.guard';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

const ENGINES = [
  RestEngine,
  GraphqlEngine,
  SoapEngine,
  McpClientEngine,
  DatabaseEngine,
];

@Module({
  imports: [McpServersModule],
  controllers: [McpEndpointController],
  providers: [McpServerService, ToolRegistry, DynamicMcpTools, McpCombinedAuthGuard, ...ENGINES],
  exports: [McpServerService, ToolRegistry],
})
export class McpServerModule {}
