import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { getAdapter, AdapterDefinition } from '../adapters/catalog';
import {
  hashContent,
  hashInstructions,
} from '../adapters/catalog-fingerprint';

/**
 * Re-sync of catalog-installed connectors with the current catalog.
 *
 * Tool definitions (description/parameters/endpointMapping) are copied into
 * `mcp_tools` at install, so later catalog fixes do not reach existing
 * connectors. This service computes the connector ↔ catalog diff and applies
 * it, matching by tool NAME (the stable identity for catalog adapters, and
 * unique per connector) and preserving operator customisations
 * (responseMapping, role access, manual enable/disable, useProxy).
 *
 * Change classes:
 *   - safe       — only description/parameters changed. Non-breaking guidance;
 *                  eligible for automatic (boot-time) application.
 *   - structural — endpointMapping changed, or a tool was added/removed.
 *                  Requires an explicit user/operator action.
 */

export type ToolChangeKind = 'safe' | 'structural';

export interface CatalogDiff {
  connectorId: string;
  slug: string;
  catalogVersion: string;
  connectorVersion: string | null;
  updated: Array<{ name: string; kind: ToolChangeKind }>;
  added: string[];
  removed: string[];
  /** instructions changed upstream AND the user has not edited theirs. */
  instructionsRefreshable: boolean;
  isUpToDate: boolean;
  /** Has changes, and every change is safe (no structural). */
  isSafeClass: boolean;
}

type CatalogTool = AdapterDefinition['tools'][number] & {
  responseMapping?: unknown;
  useProxy?: boolean;
};

@Injectable()
export class CatalogResyncService {
  private readonly logger = new Logger(CatalogResyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Resolve the source adapter slug for a connector (explicit, else name match). */
  resolveSlug(connector: {
    name: string;
    config?: unknown;
  }): string | null {
    const cfg = connector.config as Record<string, unknown> | null | undefined;
    const explicit =
      cfg && typeof cfg.adapterSlug === 'string' ? cfg.adapterSlug : null;
    if (explicit && getAdapter(explicit)) return explicit;
    return null;
  }

  /**
   * Compute the diff between a connector and its catalog adapter.
   * Returns null when the connector is not catalog-managed (no resolvable slug).
   */
  async computeDiff(connectorId: string): Promise<CatalogDiff | null> {
    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      include: { tools: true },
    });
    if (!connector) return null;

    const slug = this.resolveSlug(connector);
    if (!slug) return null;
    const adapter = getAdapter(slug);
    if (!adapter) return null;

    const catalogTools = adapter.tools as CatalogTool[];
    const catalogByName = new Map(catalogTools.map((t) => [t.name, t]));
    const existingByName = new Map(connector.tools.map((t) => [t.name, t]));

    const updated: CatalogDiff['updated'] = [];
    const added: string[] = [];

    for (const ct of catalogTools) {
      const et = existingByName.get(ct.name);
      if (!et) {
        added.push(ct.name);
        continue;
      }
      const endpointChanged =
        hashContent(ct.endpointMapping ?? {}) !==
        hashContent(et.endpointMapping ?? {});
      const descParamsChanged =
        (ct.description ?? '') !== (et.description ?? '') ||
        hashContent(ct.parameters ?? {}) !== hashContent(et.parameters ?? {});
      if (endpointChanged) {
        updated.push({ name: ct.name, kind: 'structural' });
      } else if (descParamsChanged) {
        updated.push({ name: ct.name, kind: 'safe' });
      }
    }

    // Existing, non-deprecated tools no longer present upstream.
    const removed: string[] = [];
    for (const et of connector.tools) {
      if (et.deprecatedAt) continue;
      if (!catalogByName.has(et.name)) removed.push(et.name);
    }

    const cfg = (connector.config ?? {}) as Record<string, unknown>;
    const connectorVersion =
      typeof cfg.adapterVersion === 'string' ? cfg.adapterVersion : null;
    const baseline =
      typeof cfg.instructionsBaseline === 'string'
        ? cfg.instructionsBaseline
        : null;
    const instructionsChanged =
      hashInstructions(adapter.instructions) !==
      hashInstructions(connector.instructions);
    const userEditedInstructions =
      baseline !== null &&
      baseline !== hashInstructions(connector.instructions);
    const instructionsRefreshable = instructionsChanged && !userEditedInstructions;

    const isUpToDate =
      updated.length === 0 &&
      added.length === 0 &&
      removed.length === 0 &&
      !instructionsRefreshable;
    const isSafeClass =
      !isUpToDate &&
      added.length === 0 &&
      removed.length === 0 &&
      updated.every((u) => u.kind === 'safe');

    return {
      connectorId,
      slug,
      catalogVersion: adapter.version,
      connectorVersion,
      updated,
      added,
      removed,
      instructionsRefreshable,
      isUpToDate,
      isSafeClass,
    };
  }

  /**
   * Apply the catalog to a connector. `mode: 'safe'` applies only
   * description/parameters updates (and instructions-if-untouched), refusing if
   * the diff has any structural change. `mode: 'full'` applies everything,
   * including endpoint changes, new tools, and soft-deprecating removed tools.
   *
   * Always preserves responseMapping, role access, manual enable/disable and
   * useProxy. Never touches auth/baseUrl/envVars/headers.
   */
  async resync(
    connectorId: string,
    mode: 'safe' | 'full' = 'full',
  ): Promise<{ applied: boolean; diff: CatalogDiff; snapshot: unknown }> {
    const diff = await this.computeDiff(connectorId);
    if (!diff) {
      throw new Error('Connector is not catalog-managed');
    }
    if (diff.isUpToDate) {
      return { applied: false, diff, snapshot: null };
    }
    if (mode === 'safe' && !diff.isSafeClass) {
      // Safe-mode caller must not apply structural changes.
      return { applied: false, diff, snapshot: null };
    }

    const adapter = getAdapter(diff.slug) as AdapterDefinition;
    const catalogTools = adapter.tools as CatalogTool[];
    const catalogByName = new Map(catalogTools.map((t) => [t.name, t]));

    const result = await this.prisma.$transaction(async (tx) => {
      const connector = await tx.connector.findUnique({
        where: { id: connectorId },
        include: { tools: true },
      });
      if (!connector) throw new Error('Connector vanished mid-resync');

      // Pre-image snapshot for rollback / audit.
      const snapshot = {
        connectorId,
        slug: diff.slug,
        at: new Date().toISOString(),
        tools: connector.tools.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          endpointMapping: t.endpointMapping,
          deprecatedAt: t.deprecatedAt,
          isEnabled: t.isEnabled,
        })),
        instructions: connector.instructions,
        config: connector.config,
      };

      const existingByName = new Map(connector.tools.map((t) => [t.name, t]));
      let updatedCount = 0;
      let createdCount = 0;
      let deprecatedCount = 0;

      for (const ct of catalogTools) {
        const et = existingByName.get(ct.name);
        if (et) {
          const endpointChanged =
            hashContent(ct.endpointMapping ?? {}) !==
            hashContent(et.endpointMapping ?? {});
          // In safe mode never touch endpointMapping.
          if (mode === 'safe' && endpointChanged) continue;
          await tx.mcpTool.update({
            where: { id: et.id },
            data: {
              description: ct.description,
              parameters: ct.parameters as any,
              endpointMapping:
                mode === 'safe'
                  ? (et.endpointMapping as any)
                  : (ct.endpointMapping as any),
              // Un-deprecate a tool the catalog brought back; never flip a
              // user's manual disable.
              deprecatedAt: null,
              isEnabled: et.deprecatedAt ? true : et.isEnabled,
              // responseMapping / useProxy / roleAccess preserved.
            },
          });
          updatedCount++;
        } else if (mode === 'full') {
          await tx.mcpTool.create({
            data: {
              connectorId,
              name: ct.name,
              description: ct.description,
              parameters: ct.parameters as any,
              endpointMapping: ct.endpointMapping as any,
              responseMapping: (ct.responseMapping as any) ?? undefined,
              useProxy: ct.useProxy === true,
            },
          });
          createdCount++;
        }
      }

      // Soft-deprecate tools no longer in the catalog (full mode only).
      if (mode === 'full') {
        const now = new Date();
        for (const et of connector.tools) {
          if (et.deprecatedAt) continue;
          if (catalogByName.has(et.name)) continue;
          await tx.mcpTool.update({
            where: { id: et.id },
            data: { deprecatedAt: now, isEnabled: false },
          });
          deprecatedCount++;
        }
      }

      // Refresh instructions only if the user hasn't edited them.
      let newInstructions = connector.instructions;
      if (diff.instructionsRefreshable) {
        newInstructions = adapter.instructions ?? null;
      }

      // Bump the stored version only when the connector is now fully in sync
      // with the catalog (full mode, or safe mode on a pure safe-class diff).
      const fullySynced = mode === 'full' || diff.isSafeClass;
      const cfg = ((connector.config ?? {}) as Record<string, unknown>) || {};
      const newConfig = {
        ...cfg,
        ...(fullySynced ? { adapterVersion: adapter.version } : {}),
        instructionsBaseline: hashInstructions(newInstructions),
      };

      await tx.connector.update({
        where: { id: connectorId },
        data: {
          instructions: newInstructions,
          config: newConfig as any,
        },
      });

      return { snapshot, updatedCount, createdCount, deprecatedCount };
    });

    this.logger.log(
      `Re-synced connector ${connectorId} (${diff.slug}, mode=${mode}): ` +
        `${result.updatedCount} updated, ${result.createdCount} added, ` +
        `${result.deprecatedCount} deprecated → ${adapter.version}`,
    );

    return { applied: true, diff, snapshot: result.snapshot };
  }
}
