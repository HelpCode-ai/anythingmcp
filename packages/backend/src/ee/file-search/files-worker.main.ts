// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { config } from 'dotenv';
import { join } from 'node:path';
config({ path: join(__dirname, '..', '..', '..', '..', '..', '.env') });
config({ path: join(__dirname, '..', '..', '..', '..', '.env') });
config({ path: '.env' });

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FilesWorkerModule } from './files-worker.module';

/**
 * Entry point of files-worker (#1383): `node dist/ee/file-search/files-worker.main.js`.
 * A Nest application context without the public HTTP server; the internal API
 * listens on FILES_WORKER_PORT (default 8891) for the backend only.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(FilesWorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  Logger.log('files-worker ready', 'FilesWorker');
}

bootstrap().catch((err) => {
   
  console.error('files-worker failed to start', err);
  process.exit(1);
});
