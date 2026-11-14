import { Module } from '@nestjs/common';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { FileSearchCoreModule } from './file-search-core.module';
import { FileSearchService } from './file-search.service';
import { FileSearchController } from './file-search.controller';
import { FileShareController } from './file-share.controller';
import { FileShareConnectorService } from './file-share-connector.service';
import { FileSearchBackfillService } from './file-search-backfill.service';
import { MemberVisibilityModule } from '../settings/member-visibility.module';

/**
 * File Search and File Share (#1379): the setup wizard, the Files tab and
 * the share links. The sync itself runs in files-worker (ee/file-search).
 *
 * MemberVisibilityModule needs RolesService from the API app's global
 * RolesModule. The worker loads only SettingsModule and FileSearchCoreModule,
 * never this module, so it does not need them (file-search.module.spec.ts).
 */
@Module({
  imports: [FileSearchCoreModule, McpServerModule, McpServersModule, MemberVisibilityModule],
  controllers: [FileSearchController, FileShareController],
  providers: [FileSearchService, FileShareConnectorService, FileSearchBackfillService],
  exports: [FileSearchService],
})
export class FileSearchModule {}
