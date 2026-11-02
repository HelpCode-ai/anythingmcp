// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma.module';
import { SettingsModule } from '../../settings/settings.module';
import { FileSearchCoreModule } from '../../file-search/file-search-core.module';
import { FilesWorkerService } from './files-worker.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(__dirname, '..', '..', '..', '..', '..', '.env'), join(__dirname, '..', '..', '..', '..', '.env'), '.env'],
    }),
    PrismaModule,
    SettingsModule,
    FileSearchCoreModule,
  ],
  providers: [FilesWorkerService],
})
export class FilesWorkerModule {}
