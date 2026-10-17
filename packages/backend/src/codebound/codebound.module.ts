import { Module } from '@nestjs/common';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { CodeboundController } from './codebound.controller';
import { CodeboundService } from './codebound.service';
import { SavedScriptsController } from './saved-scripts.controller';
import { SavedScriptsService } from './saved-scripts.service';
import { CodeboundMcpService } from './codebound-mcp.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

@Module({
  imports: [McpServerModule, McpServersModule, LicenseModule],
  controllers: [CodeboundController, SavedScriptsController],
  providers: [CodeboundService, SavedScriptsService, CodeboundMcpService],
})
export class CodeboundModule {}
