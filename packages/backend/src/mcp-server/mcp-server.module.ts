import { Module } from '@nestjs/common';
import { McpServerService } from './mcp-server.service';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { ToolRateLimitService } from './tool-rate-limit.service';
import { CodeExecutorService } from './code-executor.service';
import { McpEndpointController } from './mcp-endpoint.controller';
import { WellKnownOAuthController } from './well-known-oauth.controller';
import { RegistryCatchUpController } from './registry-catch-up.controller';
import { McpCombinedAuthGuard } from '../auth/mcp-combined-auth.guard';
import { McpPrincipalRateLimitGuard } from '../auth/mcp-principal-rate-limit.guard';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { ODataEngine } from '../connectors/engines/odata.engine';
import { EmailEngine } from '../connectors/engines/email.engine';
import { OAuth2TokenService } from '../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../connectors/engines/login-token.service';
import { ConnectorAuthStatusService } from '../connectors/engines/connector-auth-status.service';
import { WebhookEventsService } from '../connectors/webhook-events.service';
import { BearerTokenRenewalService } from '../connectors/engines/bearer-token-renewal.service';
import { ShopeeTokenService } from '../connectors/engines/shopee-token.service';
import { TikTokShopTokenService } from '../connectors/engines/tiktok-shop-token.service';
import { UserCredentialsService } from '../connectors/user-credentials.service';
import { SettingsModule } from '../settings/settings.module';
import { GraphqlSchemaService } from '../connectors/engines/graphql-schema.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { LicenseModule } from '../license/license.module';
import { SharedSetupRegistry } from './shared-setup';
import { FileSearchCoreModule } from '../file-search/file-search-core.module';

const ENGINES = [
  RestEngine,
  GraphqlEngine,
  SoapEngine,
  McpClientEngine,
  DatabaseEngine,
  ODataEngine,
  EmailEngine,
];

@Module({
  imports: [McpServersModule, LicenseModule, SettingsModule, FileSearchCoreModule],
  controllers: [McpEndpointController, WellKnownOAuthController, RegistryCatchUpController],
  providers: [ToolRateLimitService, SharedSetupRegistry, McpServerService, ToolRegistry, DynamicMcpTools, CodeExecutorService, McpCombinedAuthGuard, McpPrincipalRateLimitGuard, OAuth2TokenService, LoginTokenService, ConnectorAuthStatusService, BearerTokenRenewalService, ShopeeTokenService, TikTokShopTokenService, UserCredentialsService, GraphqlSchemaService, WebhookEventsService, ...ENGINES],
  exports: [McpServerService, ToolRegistry, SharedSetupRegistry, DynamicMcpTools, CodeExecutorService, OAuth2TokenService, LoginTokenService, ConnectorAuthStatusService, BearerTokenRenewalService, ShopeeTokenService, TikTokShopTokenService, UserCredentialsService, WebhookEventsService],
})
export class McpServerModule {}
