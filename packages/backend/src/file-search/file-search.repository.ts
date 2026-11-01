import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export type FileTx = Parameters<Parameters<PrismaService['tenantTx']>[1]>[0];

/**
 * Every query on the file_* tables goes through here (#1380).
 *
 * `withTenant` opens PrismaService.tenantTx (sets `app.current_org` for the
 * transaction) and switches to the `amcp_files` role for the rest of it. That
 * role has no BYPASSRLS and rights on file_* only, so the `org_isolation`
 * policy applies even while the application connects as a superuser: a query
 * that forgets its `organizationId` filter returns nothing of another
 * workspace instead of leaking it. Both settings are transaction-local, so a
 * pooled connection never keeps them.
 *
 * Cross-workspace maintenance in the worker (the scheduler picking due
 * sources, the share sweeper) uses `prisma` directly and never touches file
 * content.
 */
@Injectable()
export class FileSearchRepository {
  private readonly logger = new Logger(FileSearchRepository.name);
  /** Whether this database user may switch to amcp_files (checked once). */
  private roleCheck: Promise<boolean> | null = null;

  constructor(readonly prisma: PrismaService) {}

  private canUseRole(): Promise<boolean> {
    this.roleCheck ??= this.prisma.$queryRaw<Array<{ ok: boolean; bypass: boolean }>>`
        SELECT coalesce(pg_has_role(current_user, 'amcp_files', 'MEMBER'), false) AS ok,
               (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
      .then(([r]) => {
        if (!r?.ok && r?.bypass) {
          this.logger.warn('Role amcp_files is missing and the database user bypasses RLS: File Search relies on its query filters only');
        }
        return !!r?.ok;
      })
      .catch(() => false);
    return this.roleCheck;
  }

  withTenant<T>(organizationId: string, fn: (tx: FileTx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    if (!organizationId) throw new Error('withTenant requires an organizationId');
    return this.canUseRole().then((useRole) =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
          if (useRole) await tx.$executeRawUnsafe('SET LOCAL ROLE amcp_files');
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
}
