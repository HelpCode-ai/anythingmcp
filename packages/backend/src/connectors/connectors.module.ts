import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController } from './connectors.controller';
import { ToolsController } from './tools.controller';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { RestEngine } from './engines/rest.engine';
import { SoapEngine } from './engines/soap.engine';
import { GraphqlEngine } from './engines/graphql.engine';
import { McpClientEngine } from './engines/mcp-client.engine';
import { DatabaseEngine } from './engines/database.engine';
import { WebhookEngine } from './engines/webhook.engine';
import { OpenApiParser } from './parsers/openapi.parser';
import { WsdlParser } from './parsers/wsdl.parser';
import { GraphqlParser } from './parsers/graphql.parser';
import { PostmanParser } from './parsers/postman.parser';
import { CurlParser } from './parsers/curl.parser';
import { McpOAuthService } from './mcp-oauth.service';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';

const ENGINES = [
  RestEngine,
  SoapEngine,
  GraphqlEngine,
  McpClientEngine,
  DatabaseEngine,
  WebhookEngine,
];

const PARSERS = [OpenApiParser, WsdlParser, GraphqlParser, PostmanParser, CurlParser];

@Module({
  imports: [McpServerModule],
  controllers: [ConnectorsController, McpOAuthCallbackController, ToolsController],
  providers: [ConnectorsService, McpOAuthService, ...ENGINES, ...PARSERS],
  exports: [ConnectorsService, McpOAuthService, ...ENGINES],
})
export class ConnectorsModule {}
