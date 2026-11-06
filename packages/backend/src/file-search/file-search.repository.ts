import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export type FileTx = Parameters<Parameters<PrismaService['tenantTx']>[1]>[0];

/**
 * How the database user meets the file_* policies:
 *   - `amcp_files`: it may switch to the amcp_files role, so the policies apply;
 *   - `rls`: no amcp_files, but the user is subject to RLS itself (managed databases);
 *   - `bypass`: no amcp_files and the user is a superuser or has BYPASSRLS, so
 *     only the query filters on organization_id separate the workspaces.
 */
export type FileDbMode = 'amcp_files' | 'rls' | 'bypass';

/**
 * Every query on the file_* tables goes through here (#1380).
 *
 * `withTenant` opens a transaction, sets `app.current_org` for it and
 * switches to the `amcp_files` role for the rest of it. That role has no
 * BYPASSRLS and rights on file_* only, so the `org_isolation` policy applies
 * even while the application connects as a superuser: a query that forgets
 * its `organizationId` filter returns nothing of another workspace instead of
 * leaking it. Both settings are transaction-local, so a pooled connection
 * never keeps them.
 *
 * Cross-workspace maintenance in the worker (the scheduler, the sweeps) runs
 * one workspace at a time through `withTenant` as well (#1418), so it works
 * for a database user without superuser or BYPASSRLS and can never touch
 * another workspace's rows. The only lookup without a workspace is a share
 * link by its token (`withShareToken`).
 */
@Injectable()
export class FileSearchRepository {
  private readonly logger = new Logger(FileSearchRepository.name);
  /** How this database user meets the policies (checked once). */
  private modeCheck: Promise<FileDbMode> | null = null;

  constructor(readonly prisma: PrismaService) {}

  /** Checked once per process; a failed check counts as "no amcp_files". */
  mode(): Promise<FileDbMode> {
    this.modeCheck ??= this.prisma.$queryRaw<Array<{ ok: boolean | null; bypass: boolean | null }>>`
        SELECT coalesce((SELECT pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'amcp_files'), false) AS ok,
               (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
      .then(([r]): FileDbMode => {
        if (r?.ok) return 'amcp_files';
        if (r?.bypass) {
          this.logger.warn('Role amcp_files is missing and the database user bypasses RLS: File Search relies on its query filters only');
          return 'bypass';
        }
        return 'rls';
      })
      .catch((err): FileDbMode => {
        this.logger.warn(`could not check the amcp_files role: ${(err as Error).message}`);
        return 'rls';
      });
    return this.modeCheck;
  }

  withTenant<T>(organizationId: string, fn: (tx: FileTx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    if (!organizationId) throw new Error('withTenant requires an organizationId');
    return this.mode().then((mode) =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
          if (mode === 'amcp_files') await tx.$executeRawUnsafe('SET LOCAL ROLE amcp_files');
          if (opts?.timeoutMs) {
            await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(opts.timeoutMs))}`);
          }
          return fn(tx as FileTx);
        },
        {
          timeout: Math.max(10_000, (opts?.timeoutMs ?? 0) + 5_000),
          maxWait: 10_000,
        },
      ),
    );
  }

  /**
   * Reads a File Share row by the SHA-256 of its link token, before the
   * workspace is known. The transaction sets `app.share_token_hash`, which the
   * SELECT-only `share_by_token` policy matches, and clears `app.current_org`,
   * so nothing else is visible. Writes need `withTenant` with the row's
   * organizationId.
   */
  withShareToken<T>(tokenHash: string, fn: (tx: FileTx) => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('withShareToken requires a SHA-256 hex digest');
    return this.mode().then((mode) =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_org', '', true)`;
          await tx.$executeRaw`SELECT set_config('app.share_token_hash', ${tokenHash}, true)`;
          if (mode === 'amcp_files') await tx.$executeRawUnsafe('SET LOCAL ROLE amcp_files');
          return fn(tx as FileTx);
        },
        { timeout: 10_000, maxWait: 10_000 },
      ),
    );
  }

  /**
   * Workspaces with at least one FILE_SEARCH connector, active or not (drafts
   * and File Share included). `connectors` has no RLS.
   */
  async tenantsWithFileSearch(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ organization_id: string }>>`
      SELECT DISTINCT organization_id FROM connectors WHERE type = 'FILE_SEARCH' ORDER BY organization_id`;
    return rows.map((r) => r.organization_id);
  }

  /**
   * Startup check for the worker log: how many File Search folders (not File
   * Share) the connectors table lists, and how many file_sources rows this
   * process can see through `withTenant`. Folders without any visible source
   * mean the database user cannot read the file_* tables in its workspace.
   */
  async visibility(): Promise<{ mode: FileDbMode; connectors: number; visibleSources: number }> {
    const mode = await this.mode();
    const rows = await this.prisma.$queryRaw<Array<{ organization_id: string; n: number }>>`
      SELECT organization_id, count(*)::int AS n FROM connectors
       WHERE type = 'FILE_SEARCH' AND coalesce(config->>'fileShare', '') <> 'true'
       GROUP BY organization_id`;
    let visibleSources = 0;
    for (const r of rows) {
      visibleSources += await this.withTenant(r.organization_id, (tx) => tx.fileSource.count({ where: { organizationId: r.organization_id } }));
    }
    return { mode, connectors: rows.reduce((n, r) => n + r.n, 0), visibleSources };
  }
}
