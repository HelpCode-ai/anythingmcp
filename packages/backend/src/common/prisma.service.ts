import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  envVarsAtRestExtension,
  isEncryptedEnvVars,
  openEnvVars,
  plaintextAtRest,
  sealEnvVars,
} from './crypto/env-vars-at-rest';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ adapter });
    // Hand out the extended client: connector variables are encrypted on
    // write and decrypted on read for every caller (see env-vars-at-rest.ts).
    // $extends keeps this instance as its prototype, so the methods below
    // stay available on what Nest injects.
    return this.$extends(envVarsAtRestExtension as any) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
    await this.reconcileEnvVarsAtRest();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Bring stored connector variables in line with the mode: encrypt rows that
   * are still plain (written before encryption existed, or patched by hand),
   * or decrypt them all when ENV_VARS_AT_REST=plaintext. Idempotent, so every
   * instance can run it at boot. Each row is only replaced if it is unchanged
   * since it was read. Never stops the boot: a row it cannot convert stays as
   * it is and is still readable.
   */
  async reconcileEnvVarsAtRest(): Promise<{ changed: number }> {
    const toPlain = plaintextAtRest();
    let changed = 0;
    try {
      // Raw on purpose: it bypasses the extension and shows what is stored.
      const rows = await this.$queryRaw<Array<{ id: string; env_vars: unknown }>>`
        SELECT id, env_vars FROM connectors
        WHERE env_vars IS NOT NULL AND jsonb_typeof(env_vars) = 'object' AND env_vars <> '{}'::jsonb`;
      for (const row of rows) {
        const encrypted = isEncryptedEnvVars(row.env_vars);
        const hasPlainKeys = Object.keys(row.env_vars as object).some((k) => k !== '$enc');
        let next: unknown;
        if (toPlain) {
          if (!encrypted) continue;
          next = openEnvVars(row.env_vars);
        } else {
          if (encrypted && !hasPlainKeys) continue;
          next = sealEnvVars(openEnvVars(row.env_vars));
        }
        const updated = await this.$executeRaw`
          UPDATE connectors SET env_vars = ${JSON.stringify(next)}::jsonb
          WHERE id = ${row.id} AND env_vars = ${JSON.stringify(row.env_vars)}::jsonb`;
        changed += updated;
      }
      if (changed > 0) {
        this.logger.log(
          `${toPlain ? 'Decrypted' : 'Encrypted'} the variables of ${changed} connector${changed === 1 ? '' : 's'}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`connector variables not reconciled: ${err?.message ?? err}`);
    }
    return { changed };
  }

  /**
   * Run `fn` inside a transaction that has the tenant context set, so Postgres
   * Row-Level Security policies (`organization_id = current_setting('app.current_org')`)
   * scope every statement to this org. `set_config(..., true)` is **transaction-local**,
   * so it cannot leak to another request sharing the pooled connection.
   *
   * This is the execution path RLS depends on (defense-in-depth on top of the
   * app-layer `where: { organizationId }`). It is inert until RLS is actually
   * enabled on the tables (see `prisma/rls/enable-rls.sql`, gated by ENABLE_RLS):
   * with RLS off the SET is simply ignored.
   */
  async tenantTx<T>(
    organizationId: string,
    fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    if (!organizationId) {
      throw new Error('tenantTx requires a non-empty organizationId');
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
      return fn(tx);
    });
  }
}
