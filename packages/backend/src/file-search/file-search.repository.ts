import { Injectable } from '@nestjs/common';
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
  constructor(readonly prisma: PrismaService) {}

  withTenant<T>(organizationId: string, fn: (tx: FileTx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    if (!organizationId) throw new Error('withTenant requires an organizationId');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
        await tx.$executeRawUnsafe('SET LOCAL ROLE amcp_files');
        if (opts?.timeoutMs) {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(opts.timeoutMs))}`);
        }
        return fn(tx as FileTx);
      },
      { timeout: Math.max(10_000, (opts?.timeoutMs ?? 0) + 5_000), maxWait: 10_000 },
    );
  }
}
