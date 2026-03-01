import { Global, Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { McpApiKeysService } from './mcp-api-keys.service';
import { McpApiKeysController } from './mcp-api-keys.controller';

@Global()
@Module({
  controllers: [RolesController, McpApiKeysController],
  providers: [RolesService, McpApiKeysService],
  exports: [RolesService, McpApiKeysService],
})
export class RolesModule {}
