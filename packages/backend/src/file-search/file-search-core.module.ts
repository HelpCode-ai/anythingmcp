import { Module } from '@nestjs/common';
import { FileSearchRepository } from './file-search.repository';
import { FileSearchAccessService } from './file-search-access.service';
import { FileSearchPolicyService } from './file-search-policy.service';
import { FileSearchQueryService } from './file-search-query.service';
import { FilesWorkerClient } from './files-worker.client';
import { FileShareService } from './file-share.service';
import { FileSearchEngine } from './file-search.engine';

/**
 * File Search, the part the MCP layer needs (#1384): the index queries, the
 * plan check, File Share and the engine behind the `file_*` tools. No
 * dependency on McpServerModule, which imports this module.
 */
@Module({
  providers: [
    FileSearchRepository,
    FileSearchAccessService,
    FileSearchPolicyService,
    FileSearchQueryService,
    FilesWorkerClient,
    FileShareService,
    FileSearchEngine,
  ],
  exports: [
    FileSearchRepository,
    FileSearchAccessService,
    FileSearchPolicyService,
    FileSearchQueryService,
    FilesWorkerClient,
    FileShareService,
    FileSearchEngine,
  ],
})
export class FileSearchCoreModule {}
