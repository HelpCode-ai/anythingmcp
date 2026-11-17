import { Global, Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { McpApiKeysService } from './mcp-api-keys.service';
import { McpApiKeysController } from './mcp-api-keys.controller';
import { MemberVisibilityModule } from '../settings/member-visibility.module';

@Global()
@Module({
  // For McpApiKeysController (member visibility of the server a key is for).
  imports: [MemberVisibilityModule],
  controllers: [RolesController, McpApiKeysController],
  providers: [RolesService, McpApiKeysService],
  exports: [RolesService, McpApiKeysService],
})
export class RolesModule {}
