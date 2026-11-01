import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { buildFileSearchBuiltinTools } from './file-search-builtins';
import { FileSearchRepository } from './file-search.repository';

const BATCH = 50;

/**
 * Gives every existing File Search connector the built-in tools added in a
 * later release (view_page), once per backend boot, in all workspaces.
 *
 * Only missing tools are created: existing tools, their enabled flag and
 * their descriptions are never touched, share_file is created switched off
 * as at activation, and File Share connectors (config.fileShare) keep their
 * own tool set. Connectors that were never activated (no built-in tool yet)
 * are left alone: activation creates their tools. Runs in the background
 * after the MCP registry has loaded; an error is logged, never thrown.
 * The files-worker does not load this module.
 */
@Injectable()
export class FileSearchBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FileSearchBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly mcpServer: McpServerService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.backfillBuiltinTools().catch((err) => this.logger.error(`File Search tool backfill failed: ${(err as Error).message}`));
  }

  async backfillBuiltinTools(): Promise<{ connectors: number; tools: number }> {
    let connectorsUpdated = 0;
    let toolsCreated = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.connector.findMany({
        where: { type: 'FILE_SEARCH' as any },
        select: { id: true, organizationId: true, name: true, config: true, isActive: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;

      const sources = batch.filter((c) => {
        const config = (c.config ?? {}) as { fileShare?: unknown; fileSearch?: { toolPrefix?: unknown } };
        return config.fileShare !== true && typeof config.fileSearch?.toolPrefix === 'string' && !!config.fileSearch.toolPrefix;
      });
      if (sources.length) {
        const existing = await this.prisma.mcpTool.findMany({
          where: { connectorId: { in: sources.map((c) => c.id) } },
          select: { connectorId: true, name: true },
        });
        const names = new Map<string, Set<string>>();
        for (const t of existing) {
          if (!names.has(t.connectorId)) names.set(t.connectorId, new Set());
          names.get(t.connectorId)!.add(t.name);
        }
        const summaries = await this.summaries(sources);

        for (const c of sources) {
          const prefix = (c.config as { fileSearch: { toolPrefix: string } }).fileSearch.toolPrefix;
          const have = names.get(c.id) ?? new Set<string>();
          const builtins = buildFileSearchBuiltinTools({ prefix, displayName: c.name, summary: summaries.get(c.id) ?? null });
          // Never activated: activation creates the whole set.
          if (!builtins.some((t) => have.has(t.name))) continue;
          const missing = builtins.filter((t) => !have.has(t.name));
          if (!missing.length) continue;
          const created = await this.prisma.mcpTool.createMany({
            data: missing.map((t) => ({
              connectorId: c.id,
              name: t.name,
              description: t.description,
              parameters: t.parameters as any,
              endpointMapping: t.endpointMapping as any,
              isEnabled: t.enabled !== false,
            })),
            skipDuplicates: true,
          });
          if (!created.count) continue;
          connectorsUpdated++;
          toolsCreated += created.count;
          if (c.isActive) await this.mcpServer.reloadConnectorTools(c.id);
        }
      }
      if (batch.length < BATCH) break;
    }
    this.logger.log(`File Search tool backfill: ${connectorsUpdated} connectors updated, ${toolsCreated} tools created`);
    return { connectors: connectorsUpdated, tools: toolsCreated };
  }

  /** The one-line summaries the tool descriptions carry, read per workspace (row-level security). */
  private async summaries(connectors: Array<{ id: string; organizationId: string }>): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const byOrg = new Map<string, string[]>();
    for (const c of connectors) {
      byOrg.set(c.organizationId, [...(byOrg.get(c.organizationId) ?? []), c.id]);
    }
    for (const [organizationId, ids] of byOrg) {
      const rows = await this.repo.withTenant(organizationId, (tx) =>
        tx.fileSource.findMany({ where: { organizationId, connectorId: { in: ids } }, select: { connectorId: true, summary: true } }),
      );
      for (const r of rows) out.set(r.connectorId, r.summary);
    }
    return out;
  }
}
