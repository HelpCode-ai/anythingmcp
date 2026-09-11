import { Module } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpServersController } from './mcp-servers.controller';
import { McpSessionManager } from './mcp-session.manager';
import { LicenseModule } from '../license/license.module';

@Module({
  imports: [LicenseModule],
  providers: [McpServersService, McpSessionManager, McpConnectionGrantService],
  controllers: [McpServersController],
  exports: [McpServersService, McpSessionManager, McpConnectionGrantService],
})
export class McpServersModule {}
