import { Module } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpServersController } from './mcp-servers.controller';
import { McpConnectionsController } from './mcp-connections.controller';
import { McpSessionManager } from './mcp-session.manager';
import { LicenseModule } from '../license/license.module';
import { AuditModule } from '../audit/audit.module';
import { MemberVisibilityModule } from '../settings/member-visibility.module';

// MemberVisibilityModule (not SettingsModule): which servers a restricted
// member may read, list as targets and grant to an AI client.
@Module({
  imports: [LicenseModule, AuditModule, MemberVisibilityModule],
  providers: [McpServersService, McpSessionManager, McpConnectionGrantService],
  controllers: [McpServersController, McpConnectionsController],
  exports: [McpServersService, McpSessionManager, McpConnectionGrantService],
})
export class McpServersModule {}
