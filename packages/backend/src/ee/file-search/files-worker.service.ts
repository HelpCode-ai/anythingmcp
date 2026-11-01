// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FileSearchRepository } from '../../file-search/file-search.repository';
import { FileSearchAccessService } from '../../file-search/file-search-access.service';
import { FileShareService } from '../../file-search/file-share.service';
import { EmailService } from '../../settings/email.service';
import { ExtractorClient } from './extractor.client';
import { InternalServer } from './internal-server';
import { ScanRunner } from './scan/scan-runner';
import { PauseNotifier } from './sync/notifier';
import { Scheduler } from './sync/scheduler';
import { SyncRunner } from './sync/sync-runner';

/**
 * files-worker (#1383): runs in its own process (`node dist/ee/file-search/
 * files-worker.main.js`), never inside the backend that answers MCP calls.
 */
@Injectable()
export class FilesWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FilesWorkerService.name);
  private scheduler!: Scheduler;
  private server!: InternalServer;
  readonly workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly access: FileSearchAccessService,
    private readonly shares: FileShareService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /** Pauses while Postgres is busy, so indexing never competes with MCP queries for the database. */
  private readonly backPressure = async (): Promise<void> => {
    const max = Number(process.env.FILES_PG_ACTIVE_MAX ?? 30);
    for (let i = 0; i < 12; i++) {
      const [row] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND datname = current_database() AND pid <> pg_backend_pid()`;
      if (Number(row?.n ?? 0) <= max) return;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  };

  /**
   * A worker stopped mid-sync (deploy, crash, memory limit) leaves its run on
   * "running" forever, and the Files panel would show it in progress. On start
   * such runs become partial, unless a live worker still holds the source's
   * lease. The sync itself continues on its own; no file loses its progress.
   */
  async closeInterruptedRuns(): Promise<number> {
    try {
      const n = await this.prisma.$executeRaw`
        UPDATE file_sync_runs r
           SET status = 'partial', finished_at = now(),
               error = 'Interrupted: the File Search worker restarted. The sync continues on its own.'
         WHERE r.status = 'running'
           AND NOT EXISTS (SELECT 1 FROM file_sources s WHERE s.connector_id = r.connector_id AND s.lease_until > now())`;
      if (n > 0) this.logger.log(`closed ${n} interrupted sync run(s)`);
      return n;
    } catch (err) {
      this.logger.warn(`could not close interrupted sync runs: ${(err as Error).message}`);
      return 0;
    }
  }

  onApplicationBootstrap(): void {
    if (!process.env.FILES_WORKER_TOKEN || process.env.FILES_WORKER_TOKEN.length < 16) {
      throw new Error('FILES_WORKER_TOKEN must be set (at least 16 characters) for files-worker.');
    }
    const extractor = new ExtractorClient();
    const notifier = new PauseNotifier(this.prisma, this.email ?? null);
    const sync = new SyncRunner(this.prisma, this.repo, this.access, extractor, notifier, this.backPressure, this.workerId);
    const scans = new ScanRunner(this.prisma, this.repo, extractor);
    const concurrency = Math.max(1, Math.min(8, Number(process.env.FILES_WORKER_CONCURRENCY ?? 2)));
    this.scheduler = new Scheduler(this.prisma, this.repo, sync, scans, this.shares, this.workerId, concurrency);
    this.server = new InternalServer(this.prisma, this.repo, extractor, this.scheduler);
    this.server.listen(Number(process.env.FILES_WORKER_PORT ?? 8891), process.env.FILES_WORKER_HOST ?? '0.0.0.0');
    // Close the runs a stopped worker left open first, then start syncing.
    void this.closeInterruptedRuns().finally(() => this.scheduler.start());
    this.logger.log(`files-worker ${this.workerId} started (concurrency ${concurrency}, extractor ${extractor.configured ? 'configured' : 'NOT configured'})`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler?.stop();
    await this.server?.close();
  }
}
