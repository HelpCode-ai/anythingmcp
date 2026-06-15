import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { getAdapter } from '../adapters/catalog';
import { CatalogResyncService } from './catalog-resync.service';

/**
 * On startup, auto-applies the **safe class** of catalog updates (description /
 * parameters only — no endpoint change, no tool added/removed) to every
 * catalog-installed connector. Structural updates are left for an explicit
 * user/operator action (surfaced as "update available").
 *
 * This is what makes adapter fixes like the weclapp filter/description bug
 * self-heal across the fleet without manual DB surgery. Gated by
 * CATALOG_AUTOSYNC (default on); a self-hoster can set it to "false".
 */
@Injectable()
export class CatalogReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resync: CatalogResyncService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('CATALOG_AUTOSYNC') === 'false') {
      this.logger.log('Catalog auto-sync disabled (CATALOG_AUTOSYNC=false).');
      return;
    }
    // Fire-and-forget so a slow scan never blocks boot.
    void this.reconcile().catch((err) =>
      this.logger.error(`Catalog auto-sync failed: ${err?.message ?? err}`),
    );
  }

  async reconcile(): Promise<{
    scanned: number;
    autoSynced: number;
    structuralPending: number;
  }> {
    const connectors = await this.prisma.connector.findMany({
      select: { id: true, name: true, config: true },
    });

    let scanned = 0;
    let autoSynced = 0;
    let structuralPending = 0;

    for (const connector of connectors) {
      const slug = this.resync.resolveSlug(connector);
      if (!slug) continue;
      const adapter = getAdapter(slug);
      if (!adapter) continue;
      scanned++;

      // Cheap pre-filter: skip connectors already on the current catalog
      // version (the common case) without loading their tools.
      const cfg = (connector.config ?? {}) as Record<string, unknown>;
      if (cfg.adapterVersion === adapter.version) continue;

      try {
        const diff = await this.resync.computeDiff(connector.id);
        if (!diff || diff.isUpToDate) {
          // Up to date by content but version unstamped (e.g. backfill or a
          // connector synced by hand) — stamp it so we skip it next boot.
          await this.stampVersion(connector.id, adapter.version, cfg);
          continue;
        }
        if (diff.isSafeClass) {
          await this.resync.resync(connector.id, 'safe');
          autoSynced++;
        } else {
          structuralPending++;
        }
      } catch (err: any) {
        this.logger.warn(
          `Catalog auto-sync skipped connector ${connector.id}: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Catalog auto-sync: ${scanned} catalog connectors scanned, ` +
        `${autoSynced} auto-synced (safe), ${structuralPending} with structural ` +
        `updates pending review.`,
    );
    return { scanned, autoSynced, structuralPending };
  }

  /** Stamp the current catalog version on a connector already in sync by content. */
  private async stampVersion(
    connectorId: string,
    version: string,
    cfg: Record<string, unknown>,
  ) {
    await this.prisma.connector.update({
      where: { id: connectorId },
      data: { config: { ...cfg, adapterVersion: version } as any },
    });
  }
}
