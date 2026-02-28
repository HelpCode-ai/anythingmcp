import { Module, forwardRef } from '@nestjs/common';
import { McpServerService } from './mcp-server.service';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { WebhookEngine } from '../connectors/engines/webhook.engine';

const ENGINES = [
  RestEngine,
  GraphqlEngine,
  SoapEngine,
  McpClientEngine,
  DatabaseEngine,
  WebhookEngine,
];

@Module({
  providers: [McpServerService, ToolRegistry, DynamicMcpTools, ...ENGINES],
  exports: [McpServerService, ToolRegistry],
})
export class McpServerModule {}
