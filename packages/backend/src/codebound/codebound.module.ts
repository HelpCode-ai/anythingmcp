import { Module } from '@nestjs/common';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { CodeboundController } from './codebound.controller';
import { CodeboundService } from './codebound.service';
import { SavedScriptsController } from './saved-scripts.controller';
import { SavedScriptsService } from './saved-scripts.service';

@Module({
  imports: [McpServerModule, LicenseModule],
  controllers: [CodeboundController, SavedScriptsController],
  providers: [CodeboundService, SavedScriptsService],
})
export class CodeboundModule {}
