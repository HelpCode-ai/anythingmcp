// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma.service';
import { FileSearchRepository } from '../../../file-search/file-search.repository';
import { FileShareService } from '../../../file-search/file-share.service';
import { ScanRunner } from '../scan/scan-runner';
import { SyncRunner } from './sync-runner';

/**
 * The files-worker loop (#1383). Coordination happens only through Postgres:
 * a source is claimed with a lease (`FOR UPDATE SKIP LOCKED`), so several
 * workers (blue/green, scale-out) never run the same source twice, and a
 * crashed worker's lease simply expires.
 *
 * Fairness: at most FILES_WORKER_CONCURRENCY runs at once, never two of the
 * same workspace, ordered by how overdue they are. A big backfill runs in
 * slices and goes back to the queue after each one.
 *
 * Every query runs inside FileSearchRepository.withTenant, one workspace at a
 * time (#1418): the file_* policies stay binding for maintenance too, and a
 * database user without superuser or BYPASSRLS sees what it needs. A tick
 * first surveys each workspace (its most overdue source, its oldest queued
 * scan), sorts the candidates across workspaces and then claims them, each
 * claim in its own workspace transaction that checks the lease conditions
 * again.
 */

const TICK_MS = 5_000;
const LEASE_MIN = 10;
/** How long `stop` waits for running slices before releasing their leases. */
const STOP_WAIT_MS = 20_000;
const SWEEP_MS = 10 * 60_000;
/** How long the list of workspaces with File Search is reused. */
const TENANTS_TTL_MS = 30_000;
const MAX_SCANS = 2;
const ELIGIBLE = ['active', 'syncing', 'paused_quota', 'paused_licence', 'paused_error'];

interface Survey {
  organizationId: string;
  /** Most overdue eligible source, when the workspace holds no live lease. */
  source: { connectorId: string; nextSyncAt: Date } | null;
  /** Oldest queued or describing scan. */
  scanAt: Date | null;
}

export interface Claim {
  connectorId: string;
  organizationId: string;
}

export class Scheduler {
  private readonly logger = new Logger(Scheduler.name);
  private running = new Map<string, Promise<void>>();
  /** Leases this worker holds: connectorId → organizationId. */
  private leases = new Map<string, string>();
  private scanning = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastSweep = 0;
  private wake: (() => void) | null = null;
  private tenantCache: { at: number; ids: Promise<string[]> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly sync: SyncRunner,
    private readonly scans: ScanRunner,
    private readonly shares: FileShareService,
    private readonly workerId: string,
    private readonly concurrency: number,
  ) {}

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    // Give running slices a moment, then release the leases in any case: a
    // slice on a slow server can outlast the container's stop timeout, and an
    // unreleased lease would hold its sync for LEASE_MIN after every deploy.
    // Progress is saved per file, so the next worker continues from there.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS))),
    ]);
    if (timer) clearTimeout(timer);
    await Promise.allSettled([...this.leases].map(([connectorId, organizationId]) => this.release(connectorId, organizationId)));
  }

  /** Called by /internal/kick: run a tick now instead of waiting (a new workspace's first source included). */
  kick(): void {
    this.tenantCache = null;
    this.wake?.();
  }

  get busy() {
    return { syncs: this.running.size, scans: this.scanning.size };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`tick failed: ${(err as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, TICK_MS);
      });
    }
  }

  /** Workspaces with a FILE_SEARCH connector (active or not), cached for TENANTS_TTL_MS. */
  private tenants(): Promise<string[]> {
    if (!this.tenantCache || Date.now() - this.tenantCache.at > TENANTS_TTL_MS) {
      const ids = this.repo.tenantsWithFileSearch();
      this.tenantCache = { at: Date.now(), ids };
      ids.catch(() => (this.tenantCache = null));
    }
    return this.tenantCache.ids;
  }

  private async tick(): Promise<void> {
    const tenants = await this.tenants();
    const slots = this.concurrency - this.running.size;
    const surveys: Survey[] = [];
    for (const org of tenants) {
      try {
        surveys.push(await this.survey(org, slots > 0));
      } catch (err) {
        this.logger.warn(`survey of workspace ${org} failed: ${(err as Error).message}`);
      }
    }
    await this.pickScans(surveys);
    if (slots > 0) {
      for (const claimed of await this.claimDue(surveys, slots)) {
        const p = this.runSource(claimed).finally(() => this.running.delete(claimed.connectorId));
        this.running.set(claimed.connectorId, p);
      }
    }
    if (Date.now() - this.lastSweep > SWEEP_MS) {
      this.lastSweep = Date.now();
      await this.sweep(tenants).catch((err) => this.logger.warn(`sweep failed: ${(err as Error).message}`));
    }
  }

  /**
   * One workspace: fail the scans a dead worker left running, and read the
   * candidates of this tick. Read-only apart from the stale scans.
   */
  private async survey(organizationId: string, wantSource: boolean): Promise<Survey> {
    return this.repo.withTenant(organizationId, async (tx) => {
      // A scan that has been "running" for 15 minutes belongs to a worker that died.
      await tx.$executeRaw`UPDATE file_scans SET status = 'failed', error = 'The scan was interrupted. Start it again.', finished_at = now()
        WHERE organization_id = ${organizationId} AND status IN ('running', 'describing_running')
          AND created_at < now() - interval '15 minutes' AND id <> ALL(${[...this.scanning]}::text[])`;
      const [scan] = await tx.$queryRaw<Array<{ created_at: Date }>>`
        SELECT created_at FROM file_scans WHERE organization_id = ${organizationId} AND status IN ('queued', 'describing')
        ORDER BY created_at LIMIT 1`;
      let source: Survey['source'] = null;
      if (wantSource) {
        const [row] = await tx.$queryRaw<Array<{ connector_id: string; next_sync_at: Date }>>`
          SELECT s.connector_id, s.next_sync_at FROM file_sources s
          JOIN connectors c ON c.id = s.connector_id AND c.is_active = true
          WHERE s.organization_id = ${organizationId}
            AND s.setup_state = ANY(${ELIGIBLE}::text[])
            AND s.next_sync_at IS NOT NULL AND s.next_sync_at <= now()
            AND (s.lease_until IS NULL OR s.lease_until < now())
            AND NOT EXISTS (SELECT 1 FROM file_sources l WHERE l.organization_id = ${organizationId} AND l.lease_until > now())
          ORDER BY s.next_sync_at
          LIMIT 1`;
        if (row) source = { connectorId: row.connector_id, nextSyncAt: row.next_sync_at };
      }
      return { organizationId, source, scanAt: scan?.created_at ?? null };
    });
  }

  /**
   * Claims up to `slots` sources, most overdue first across workspaces, at
   * most one per workspace. Each claim runs in its workspace's transaction,
   * holds a transaction-level advisory lock on the workspace (so two workers
   * cannot both find it free) and checks every lease condition again.
   */
  private async claimDue(surveys: Survey[], slots: number): Promise<Claim[]> {
    const busy = new Set(this.leases.values());
    const candidates = surveys
      .filter((s) => s.source && !busy.has(s.organizationId))
      .sort((a, b) => a.source!.nextSyncAt.getTime() - b.source!.nextSyncAt.getTime());
    const claimed: Claim[] = [];
    for (const c of candidates) {
      if (claimed.length >= slots) break;
      try {
        const got = await this.claimIn(c.organizationId);
        if (got) {
          this.leases.set(got.connectorId, got.organizationId);
          claimed.push(got);
        }
      } catch (err) {
        this.logger.warn(`claim in workspace ${c.organizationId} failed: ${(err as Error).message}`);
      }
    }
    return claimed;
  }

  private claimIn(organizationId: string): Promise<Claim | null> {
    return this.repo.withTenant(organizationId, async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${'amcp-files-claim:' + organizationId}, 0)) AS ok`;
      if (!lock?.ok) return null;
      const rows = await tx.$queryRaw<Array<{ connector_id: string; organization_id: string }>>`
        UPDATE file_sources SET lease_owner = ${this.workerId}, lease_until = now() + make_interval(mins => ${LEASE_MIN})
        WHERE organization_id = ${organizationId} AND connector_id = (
          SELECT s.connector_id FROM file_sources s
          JOIN connectors c ON c.id = s.connector_id AND c.is_active = true
          WHERE s.organization_id = ${organizationId}
            AND s.setup_state = ANY(${ELIGIBLE}::text[])
            AND s.next_sync_at IS NOT NULL AND s.next_sync_at <= now()
            AND (s.lease_until IS NULL OR s.lease_until < now())
            AND NOT EXISTS (SELECT 1 FROM file_sources l WHERE l.organization_id = ${organizationId} AND l.lease_until > now())
          ORDER BY s.next_sync_at
          LIMIT 1
          FOR UPDATE OF s SKIP LOCKED
        )
        RETURNING connector_id, organization_id`;
      return rows[0] ? { connectorId: rows[0].connector_id, organizationId: rows[0].organization_id } : null;
    });
  }

  private renew(connectorId: string, organizationId: string): Promise<number> {
    return this.repo.withTenant(organizationId, (tx) =>
      tx.$executeRaw`UPDATE file_sources SET lease_until = now() + make_interval(mins => ${LEASE_MIN})
        WHERE connector_id = ${connectorId} AND organization_id = ${organizationId} AND lease_owner = ${this.workerId}`,
    );
  }

  private async release(connectorId: string, organizationId: string): Promise<void> {
    try {
      await this.repo.withTenant(organizationId, (tx) =>
        tx.$executeRaw`UPDATE file_sources SET lease_owner = NULL, lease_until = NULL
          WHERE connector_id = ${connectorId} AND organization_id = ${organizationId} AND lease_owner = ${this.workerId}`,
      );
      this.leases.delete(connectorId);
    } catch (err) {
      // The lease expires on its own after LEASE_MIN.
      this.logger.warn(`release of ${connectorId} failed: ${(err as Error).message}`);
    }
  }

  private async runSource({ connectorId, organizationId }: Claim): Promise<void> {
    const renew = setInterval(() => {
      this.renew(connectorId, organizationId).catch((err) => this.logger.warn(`lease renewal of ${connectorId} failed: ${(err as Error).message}`));
    }, 2 * 60_000);
    try {
      const out = await this.sync.run(connectorId, 'schedule');
      if (out.status !== 'skipped') this.logger.log(`sync ${connectorId}: ${out.status}${out.more ? ' (more queued)' : ''}`);
    } catch (err) {
      this.logger.error(`sync ${connectorId} crashed: ${(err as Error).message}`);
    } finally {
      clearInterval(renew);
      await this.release(connectorId, organizationId);
    }
  }

  /** Claims queued scans, oldest first across workspaces, each in its workspace. */
  private async pickScans(surveys: Survey[]): Promise<void> {
    const queued = surveys.filter((s) => s.scanAt).sort((a, b) => a.scanAt!.getTime() - b.scanAt!.getTime());
    for (const s of queued) {
      const room = MAX_SCANS - this.scanning.size;
      if (room <= 0) return;
      let rows: Array<{ id: string; organization_id: string; status: string }>;
      try {
        rows = await this.repo.withTenant(s.organizationId, (tx) =>
          tx.$queryRaw<Array<{ id: string; organization_id: string; status: string }>>`
            UPDATE file_scans SET status = CASE WHEN status = 'queued' THEN 'running' ELSE 'describing_running' END
            WHERE organization_id = ${s.organizationId} AND id IN (
              SELECT id FROM file_scans WHERE organization_id = ${s.organizationId} AND status IN ('queued', 'describing')
              ORDER BY created_at LIMIT ${room}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id, organization_id, status`,
        );
      } catch (err) {
        this.logger.warn(`scan claim in workspace ${s.organizationId} failed: ${(err as Error).message}`);
        continue;
      }
      for (const r of rows) {
        this.scanning.add(r.id);
        const job = r.status === 'running' ? this.scans.run(r.id, r.organization_id) : this.scans.redescribe(r.id, r.organization_id);
        void job
          .catch((err) => this.logger.error(`scan ${r.id} failed: ${(err as Error).message}`))
          .finally(() => this.scanning.delete(r.id));
      }
    }
  }

  private async sweep(tenants: string[]): Promise<void> {
    const purged = await this.shares.sweep(tenants);
    if (purged) this.logger.log(`File Share: removed ${purged} expired or revoked files`);
    for (const org of tenants) {
      try {
        await this.sweepWorkspace(org);
      } catch (err) {
        this.logger.warn(`sweep of workspace ${org} failed: ${(err as Error).message}`);
      }
    }
  }

  private async sweepWorkspace(organizationId: string): Promise<void> {
    const { drafts, expired } = await this.repo.withTenant(organizationId, async (tx) => {
      // Drafts nobody finished within 7 days.
      const drafts = await tx.$queryRaw<Array<{ connector_id: string }>>`
        SELECT s.connector_id FROM file_sources s JOIN connectors c ON c.id = s.connector_id
        WHERE s.organization_id = ${organizationId} AND s.setup_state = 'draft' AND c.is_active = false
          AND s.created_at < now() - interval '7 days' LIMIT 100`;
      // Scan samples are only needed during setup.
      await tx.$executeRaw`UPDATE file_scans SET samples = NULL
        WHERE organization_id = ${organizationId} AND samples IS NOT NULL AND created_at < now() - interval '7 days'`;
      // Licence pause: the index is kept 30 days, then removed.
      const expired = await tx.$queryRaw<Array<{ connector_id: string }>>`
        SELECT connector_id FROM file_sources
        WHERE organization_id = ${organizationId} AND setup_state = 'paused_licence' AND paused_at < now() - interval '30 days' LIMIT 50`;
      return { drafts, expired };
    });
    if (drafts.length) {
      // connectors has no RLS; the workspace filter keeps this to the drafts read above.
      await this.prisma.connector.deleteMany({ where: { id: { in: drafts.map((d) => d.connector_id) }, organizationId, isActive: false } });
      this.logger.log(`removed ${drafts.length} unfinished File Search drafts`);
    }
    for (const e of expired) {
      await this.repo.withTenant(organizationId, (tx) => tx.fileEntry.deleteMany({ where: { connectorId: e.connector_id, organizationId } }));
      this.logger.log(`licence pause over 30 days: removed the index of ${e.connector_id}`);
    }
  }
}
