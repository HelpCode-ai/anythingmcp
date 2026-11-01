import { Module } from '@nestjs/common';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { FileSearchCoreModule } from './file-search-core.module';
import { FileSearchService } from './file-search.service';
import { FileSearchController } from './file-search.controller';
import { FileShareController } from './file-share.controller';
import { FileShareConnectorService } from './file-share-connector.service';

/**
 * File Search and File Share (#1379): the setup wizard, the Files tab and
 * the share links. The sync itself runs in files-worker (ee/file-search).
 */
@Module({
  imports: [FileSearchCoreModule, McpServerModule, McpServersModule],
  controllers: [FileSearchController, FileShareController],
  providers: [FileSearchService, FileShareConnectorService],
  exports: [FileSearchService],
})
export class FileSearchModule {}
