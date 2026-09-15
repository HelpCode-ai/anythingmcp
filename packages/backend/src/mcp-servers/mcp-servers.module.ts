import { Module } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpServersController } from './mcp-servers.controller';
import { McpConnectionsController } from './mcp-connections.controller';
import { McpSessionManager } from './mcp-session.manager';
import { LicenseModule } from '../license/license.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [LicenseModule, AuditModule],
  providers: [McpServersService, McpSessionManager, McpConnectionGrantService],
  controllers: [McpServersController, McpConnectionsController],
  exports: [McpServersService, McpSessionManager, McpConnectionGrantService],
})
export class McpServersModule {}
