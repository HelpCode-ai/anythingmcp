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
import { ODataEngine } from './engines/odata.engine';
import { LoginTokenService } from './engines/login-token.service';
import { GraphqlSchemaService } from './engines/graphql-schema.service';
import { OpenApiParser } from './parsers/openapi.parser';
import { WsdlParser } from './parsers/wsdl.parser';
import { GraphqlParser } from './parsers/graphql.parser';
import { PostmanParser } from './parsers/postman.parser';
import { CurlParser } from './parsers/curl.parser';
import { McpOAuthService } from './mcp-oauth.service';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';
import { CatalogResyncService } from './catalog-resync.service';
import { CatalogReconciler } from './catalog-reconciler.service';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

const ENGINES = [
  RestEngine,
  SoapEngine,
  GraphqlEngine,
  McpClientEngine,
  DatabaseEngine,
  ODataEngine,
];

const PARSERS = [OpenApiParser, WsdlParser, GraphqlParser, PostmanParser, CurlParser];

// OAuth2TokenService comes from McpServerModule: one instance for the whole
// app. A second one here had its own token cache and refresh mutex, so a
// Test connection and a tool call could refresh with the same refresh token
// at once, and a provider that rotates it revoked the connector's token.
@Module({
  imports: [McpServerModule, McpServersModule, LicenseModule],
  controllers: [ConnectorsController, McpOAuthCallbackController, ToolsController],
  providers: [
    ConnectorsService,
    McpOAuthService,
    CatalogResyncService,
    CatalogReconciler,
    LoginTokenService,
    GraphqlSchemaService,
    ...ENGINES,
    ...PARSERS,
  ],
  exports: [
    ConnectorsService,
    McpOAuthService,
    CatalogResyncService,
    LoginTokenService,
    GraphqlSchemaService,
    ...ENGINES,
  ],
})
export class ConnectorsModule {}
