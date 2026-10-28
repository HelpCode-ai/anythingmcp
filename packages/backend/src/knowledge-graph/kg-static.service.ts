import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { buildStaticGraph } from './static/static-extractor';
import { StaticGraph, ToolLike } from './static/types';

// Prisma closes an interactive transaction after 5 s by default. A connector
// with thousands of tools has thousands of nodes to upsert one by one, so the
// transaction expired every time, the hash was never stored and every cron
// run tried to write the whole graph again (16,608 tools on Cloud, Oct 2026).
const PERSIST_TRANSACTION = { maxWait: 10_000, timeout: 180_000 };

// Connectors above this many tools get no static graph. Writing the graph of
// a 16,608-tool connector did not finish within the 180 s transaction on
// Cloud (Oct 2026): every cron run held a transaction for 3 minutes, stalled
// the event loop for up to 3 s and failed. The next largest connector has
// 1,645 tools and syncs fine. The check runs before any tool is loaded.
const MAX_STATIC_TOOLS = 5_000;

// Part of the stored fingerprint: bump it when buildStaticGraph changes what
// it derives from the same tools, so every connector is rebuilt once.
const STATIC_SURFACE_VERSION = 'surface-v1';

/**
 * Persists the STATIC knowledge-graph layer for a connector, org-scoped.
 *
 * Pure extraction lives in ./static (no DB). This service maps the draft graph
 * onto kg_nodes / kg_edges, merging with whatever the observational layer has
 * already learned: it never downgrades an OBSERVED/MANUAL node or edge back to
 * STATIC, and it sweeps stale STATIC entries on re-sync. Idempotent: a stable
 * hash of the connector's tool surface short-circuits unchanged re-syncs.
 *
 * Tenant isolation is enforced at the application layer — every write carries
 * the connector's organizationId; nothing crosses orgs.
 */
@Injectable()
export class KgStaticService {
  private readonly logger = new Logger(KgStaticService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Generic per-workspace boolean flag. */
  async getFlag(organizationId: string, key: string, defaultValue: boolean): Promise<boolean> {
    const row = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { value: true },
    });
    if (!row) return defaultValue;
    return row.value === 'true';
  }

  async setFlag(organizationId: string, key: string, value: boolean): Promise<void> {
    const v = value ? 'true' : 'false';
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value: v },
      update: { value: v },
    });
  }

  /** Whether the knowledge graph is enabled for this workspace (default true). */
  isEnabled(organizationId: string): Promise<boolean> {
    return this.getFlag(organizationId, 'kg_enabled', true);
  }

  setEnabled(organizationId: string, enabled: boolean): Promise<void> {
    return this.setFlag(organizationId, 'kg_enabled', enabled);
  }

  /** Build + persist the static graph for one connector. */
  async syncConnector(
    connectorId: string,
    opts?: { force?: boolean },
  ): Promise<{ nodes: number; edges: number; skipped: boolean }> {
    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: { id: true, organizationId: true },
    });
    if (!connector) return { nodes: 0, edges: 0, skipped: true };

    const organizationId = connector.organizationId;
    if (!(await this.isEnabled(organizationId))) {
      return { nodes: 0, edges: 0, skipped: true };
    }

    // Skip unchanged connectors before loading their tools: on a connector
    // with 16,608 tools, loading them and building the graph blocked the
    // event loop for up to 2.6 s on every cron run (Cloud, Oct 2026), even
    // though nothing had changed. Postgres fingerprints the tool surface.
    const surface = await this.toolSurface(connectorId);
    const state = await this.prisma.kgConnectorState.findUnique({
      where: { connectorId },
      select: { staticHash: true },
    });
    if (!opts?.force && state?.staticHash === surface.key) {
      const [nodes, edges] = await Promise.all([
        this.prisma.kgNode.count({ where: { organizationId, connectorId, source: 'STATIC' } }),
        this.prisma.kgEdge.count({ where: { organizationId, source: 'STATIC', sourceNode: { connectorId } } }),
      ]);
      return { nodes, edges, skipped: true };
    }
    if (surface.tools > MAX_STATIC_TOOLS) {
      this.logger.warn(
        `KG static sync ${connectorId}: ${surface.tools} tools, above the ${MAX_STATIC_TOOLS} limit; skipped`,
      );
      return { nodes: 0, edges: 0, skipped: true };
    }

    const rows = await this.prisma.mcpTool.findMany({
      where: { connectorId },
      select: { name: true, description: true, parameters: true, outputSchema: true },
    });
    const tools: ToolLike[] = rows.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as ToolLike['parameters'],
      outputSchema: t.outputSchema as ToolLike['outputSchema'],
    }));
    // Let pending requests run between the load and the (synchronous) build.
    await new Promise((resolve) => setImmediate(resolve));
    const slug = deriveSlug(rows.map((t) => t.name));
    const graph = buildStaticGraph(slug, tools);

    await this.persist(organizationId, connectorId, graph);

    await this.prisma.kgConnectorState.upsert({
      where: { connectorId },
      create: {
        organizationId,
        connectorId,
        staticHash: surface.key,
        lastStaticAt: new Date(),
      },
      update: { staticHash: surface.key, lastStaticAt: new Date() },
    });

    this.logger.debug(
      `KG static sync ${connectorId}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    );
    return { nodes: graph.nodes.length, edges: graph.edges.length, skipped: false };
  }

  /**
   * Fingerprint of everything the static graph is built from (tool names,
   * descriptions, parameters, output schemas), computed in Postgres so an
   * unchanged connector costs one small query instead of loading every tool.
   * The jsonb columns are hashed as jsonb: turning them into text first made
   * the query take twice as long (1.4 s against 0.7 s for 16,608 tools). A
   * Postgres upgrade may change these hashes; that only rebuilds once.
   */
  private async toolSurface(connectorId: string): Promise<{ tools: number; key: string }> {
    const [row] = await this.prisma.$queryRaw<Array<{ tools: number; digest: string }>>`
      SELECT count(*)::int AS tools,
             md5(coalesce(string_agg(
               hashtextextended(name, 0)::text || ',' || hashtextextended(description, 0)::text || ',' ||
                 jsonb_hash_extended(parameters, 0)::text || ',' || coalesce(jsonb_hash_extended(output_schema, 0)::text, ''),
               ';' ORDER BY name), '')) AS digest
      FROM mcp_tools
      WHERE connector_id = ${connectorId}
    `;
    return { tools: row?.tools ?? 0, key: `${STATIC_SURFACE_VERSION}:${row?.digest ?? ''}` };
  }

  /** Sync every connector in an organization. Returns aggregate counts. */
  async syncOrganization(
    organizationId: string,
    opts?: { force?: boolean },
  ): Promise<{ connectors: number; nodes: number; edges: number }> {
    if (!(await this.isEnabled(organizationId))) {
      return { connectors: 0, nodes: 0, edges: 0 };
    }
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { id: true },
    });
    let nodes = 0;
    let edges = 0;
    for (const c of connectors) {
      const r = await this.syncConnector(c.id, opts);
      nodes += r.nodes;
      edges += r.edges;
    }
    return { connectors: connectors.length, nodes, edges };
  }

  /** Upsert nodes + edges and sweep stale STATIC entries, in one transaction. */
  private async persist(
    organizationId: string,
    connectorId: string,
    graph: StaticGraph,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1) Upsert entity nodes.
      for (const n of graph.nodes) {
        const existing = await tx.kgNode.findUnique({
          where: {
            organizationId_connectorId_entity: {
              organizationId,
              connectorId,
              entity: n.entity,
            },
          },
          select: { id: true, confidence: true },
        });
        if (!existing) {
          await tx.kgNode.create({
            data: {
              organizationId,
              connectorId,
              entity: n.entity,
              label: n.label,
              fields: n.fields as any,
              outputFields: n.outputFields as any,
              toolNames: n.toolNames as any,
              source: 'STATIC',
              confidence: n.confidence,
            },
          });
        } else {
          // Refresh the surface; never lower a confidence the observational
          // layer may have raised, and leave its source untouched.
          await tx.kgNode.update({
            where: { id: existing.id },
            data: {
              label: n.label,
              fields: n.fields as any,
              outputFields: n.outputFields as any,
              toolNames: n.toolNames as any,
              confidence: Math.max(existing.confidence, n.confidence),
              lastSeenAt: new Date(),
            },
          });
        }
      }

      // 2) Sweep STATIC nodes that no longer exist in the tool surface.
      const keepEntities = graph.nodes.map((n) => n.entity);
      await tx.kgNode.deleteMany({
        where: {
          organizationId,
          connectorId,
          source: 'STATIC',
          entity: { notIn: keepEntities.length ? keepEntities : ['__none__'] },
        },
      });

      // 3) Resolve entity -> nodeId for this connector.
      const nodeRows = await tx.kgNode.findMany({
        where: { organizationId, connectorId },
        select: { id: true, entity: true },
      });
      const idByEntity = new Map(nodeRows.map((r) => [r.entity, r.id]));

      // 4) Upsert edges; track which ones we touched to sweep the rest.
      const keptEdgeIds: string[] = [];
      for (const e of graph.edges) {
        const sourceNodeId = idByEntity.get(e.sourceEntity);
        const targetNodeId = idByEntity.get(e.targetEntity);
        if (!sourceNodeId || !targetNodeId) continue;

        const existing = await tx.kgEdge.findUnique({
          where: {
            organizationId_sourceNodeId_targetNodeId_kind: {
              organizationId,
              sourceNodeId,
              targetNodeId,
              kind: e.kind,
            },
          },
          select: { id: true, confidence: true },
        });
        if (!existing) {
          const created = await tx.kgEdge.create({
            data: {
              organizationId,
              sourceNodeId,
              targetNodeId,
              kind: e.kind,
              matchKey: e.matchKey,
              source: 'STATIC',
              confidence: e.confidence,
            },
            select: { id: true },
          });
          keptEdgeIds.push(created.id);
        } else {
          await tx.kgEdge.update({
            where: { id: existing.id },
            data: {
              matchKey: e.matchKey,
              confidence: Math.max(existing.confidence, e.confidence),
              lastSeenAt: new Date(),
            },
          });
          keptEdgeIds.push(existing.id);
        }
      }

      // 5) Sweep STATIC edges of this connector we didn't just (re)write.
      await tx.kgEdge.deleteMany({
        where: {
          organizationId,
          source: 'STATIC',
          sourceNode: { connectorId },
          id: { notIn: keptEdgeIds.length ? keptEdgeIds : ['__none__'] },
        },
      });
    }, PERSIST_TRANSACTION);
  }
}

/** The shared leading token(s) of a connector's tool names, used as the slug. */
export function deriveSlug(toolNames: string[]): string {
  if (!toolNames.length) return '';
  const split = toolNames.map((n) => n.split('_'));
  let prefix = split[0];
  for (const tokens of split) {
    let i = 0;
    while (i < prefix.length && i < tokens.length && prefix[i] === tokens[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix.join('_');
}
