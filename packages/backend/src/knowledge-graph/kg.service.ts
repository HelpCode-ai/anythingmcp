import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { RolesService } from '../roles/roles.service';
import { KgStaticService } from './kg-static.service';
import { KgObservationalService } from './kg-observational.service';
import { KgLlmService } from './kg-llm.service';

@Injectable()
export class KgService {
  private readonly logger = new Logger(KgService.name);
  // Per-org cooldown between auto-triggered observational ingests. A burst of
  // tool calls then triggers at most one ingest per window (bounds cost under
  // multi-tenant load). Falls back to an in-memory map when Redis is absent.
  private readonly observeCooldownSec = Number(process.env.KG_OBSERVE_COOLDOWN_SEC) || 45;
  private readonly localObserveAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly roles: RolesService,
    private readonly staticSvc: KgStaticService,
    private readonly observationalSvc: KgObservationalService,
    private readonly llmSvc: KgLlmService,
  ) {}

  /**
   * Connectors the user is allowed to see in the graph. ADMIN / unrestricted
   * users see all of the org's connectors; a user with a restricted mcpRole
   * sees only connectors that expose at least one tool they're permitted to use.
   * Returns null = no restriction.
   */
  private async visibleConnectorIds(
    organizationId: string,
    userId: string,
  ): Promise<string[] | null> {
    const allowedToolIds = await this.roles.getAllowedToolIds(userId);
    if (allowedToolIds === null) return null;
    if (allowedToolIds.length === 0) return [];
    const tools = await this.prisma.mcpTool.findMany({
      where: { id: { in: allowedToolIds }, connector: { organizationId } },
      select: { connectorId: true },
      distinct: ['connectorId'],
    });
    return tools.map((t) => t.connectorId);
  }

  isEnabled(organizationId: string): Promise<boolean> {
    return this.staticSvc.isEnabled(organizationId);
  }

  async getSettings(organizationId: string) {
    const [enabled, llmEnabled, captureIntent, autoExtend, skillAutoApply, edgeAutoApply] =
      await Promise.all([
        this.staticSvc.isEnabled(organizationId),
        this.staticSvc.getFlag(organizationId, 'kg_llm_enabled', false),
        this.staticSvc.getFlag(organizationId, 'kg_capture_intent', false),
        this.staticSvc.getFlag(organizationId, 'kg_llm_auto', false),
        this.staticSvc.getFlag(organizationId, 'kg_skill_auto_apply', false),
        this.staticSvc.getFlag(organizationId, 'kg_edge_auto_apply', false),
      ]);
    return {
      enabled,
      llmEnabled,
      llmAvailable: this.llmSvc.globallyAvailable(),
      captureIntent,
      // Scheduled AI extension of graph + skills from captured intents.
      autoExtend,
      // Auto-apply generated skills at/above the confidence threshold.
      skillAutoApply,
      // Auto-apply high-confidence AI-suggested graph connections (no extra AI cost —
      // it only changes the status of edges the enrichment pass already produced).
      edgeAutoApply,
    };
  }

  async updateSettings(
    organizationId: string,
    body: {
      enabled?: boolean;
      llmEnabled?: boolean;
      captureIntent?: boolean;
      autoExtend?: boolean;
      skillAutoApply?: boolean;
      edgeAutoApply?: boolean;
    },
  ) {
    if (typeof body.enabled === 'boolean') {
      await this.staticSvc.setEnabled(organizationId, body.enabled);
    }
    if (typeof body.llmEnabled === 'boolean') {
      await this.staticSvc.setFlag(organizationId, 'kg_llm_enabled', body.llmEnabled);
    }
    if (typeof body.captureIntent === 'boolean') {
      await this.staticSvc.setFlag(organizationId, 'kg_capture_intent', body.captureIntent);
    }
    if (typeof body.autoExtend === 'boolean') {
      await this.staticSvc.setFlag(organizationId, 'kg_llm_auto', body.autoExtend);
    }
    if (typeof body.skillAutoApply === 'boolean') {
      await this.staticSvc.setFlag(organizationId, 'kg_skill_auto_apply', body.skillAutoApply);
    }
    if (typeof body.edgeAutoApply === 'boolean') {
      await this.staticSvc.setFlag(organizationId, 'kg_edge_auto_apply', body.edgeAutoApply);
    }
    return this.getSettings(organizationId);
  }

  /** Run the optional LLM enrichment pass (under the rebuild lock). */
  async enrich(organizationId: string) {
    const lockKey = `kg_enrich_lock:${organizationId}`;
    const locked = this.redis.isConnected && (await this.redis.incr(lockKey)) > 1;
    if (locked) throw new ConflictException('An AI enrichment is already running.');
    if (this.redis.isConnected) await this.redis.expire(lockKey, 120);
    try {
      return await this.llmSvc.enrich(organizationId, { force: true });
    } finally {
      if (this.redis.isConnected) await this.redis.del(lockKey);
    }
  }

  /** Whether intent capture is on for this org (used by the MCP path). */
  captureIntentEnabled(organizationId: string): Promise<boolean> {
    return this.staticSvc.getFlag(organizationId, 'kg_capture_intent', false);
  }

  /**
   * Opportunistically refresh the observational layer after tool traffic, so
   * the graph grows from real usage without depending on a cron (matters for
   * self-host, and keeps the UI fresh). Debounced per org and fire-and-forget:
   * never blocks or throws into the caller's request path.
   */
  async scheduleObservationalIngest(organizationId?: string): Promise<void> {
    if (!organizationId) return;
    try {
      // Per-org cooldown. Redis: first caller in the window sets the key (TTL);
      // later callers see count>1 and back off. In-memory fallback otherwise.
      if (this.redis.isConnected) {
        const key = `kg_observe_cooldown:${organizationId}`;
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, this.observeCooldownSec);
        if (count > 1) return;
      } else {
        const now = Date.now();
        const last = this.localObserveAt.get(organizationId) ?? 0;
        if (now - last < this.observeCooldownSec * 1000) return;
        this.localObserveAt.set(organizationId, now);
      }
    } catch {
      return; // cooldown bookkeeping must never break the caller
    }
    // Detached: do not await. ingestOrganization is gated by kg_enabled and is
    // idempotent (per-connector watermark).
    void this.observationalSvc
      .ingestOrganization(organizationId)
      .catch((e) =>
        this.logger.warn(
          `KG observational auto-ingest failed for ${organizationId}: ${e.message}`,
        ),
      );
  }

  /** Full graph for an org, RBAC-filtered, ready for the UI. */
  async getGraph(organizationId: string, userId: string) {
    if (!(await this.staticSvc.isEnabled(organizationId))) {
      return { nodes: [], edges: [], lastBuiltAt: null, enabled: false };
    }
    const visible = await this.visibleConnectorIds(organizationId, userId);

    const nodes = await this.prisma.kgNode.findMany({
      where: {
        organizationId,
        ...(visible ? { connectorId: { in: visible } } : {}),
      },
      select: {
        id: true,
        entity: true,
        label: true,
        description: true,
        connectorId: true,
        fields: true,
        toolNames: true,
        source: true,
        confidence: true,
        observations: true,
        connector: { select: { name: true } },
      },
      orderBy: { entity: 'asc' },
    });

    const nodeIds = nodes.map((n) => n.id);
    const edges = nodeIds.length
      ? await this.prisma.kgEdge.findMany({
          where: {
            organizationId,
            status: { not: 'rejected' },
            sourceNodeId: { in: nodeIds },
            targetNodeId: { in: nodeIds },
          },
          select: {
            id: true,
            sourceNodeId: true,
            targetNodeId: true,
            kind: true,
            matchKey: true,
            note: true,
            source: true,
            confidence: true,
            observations: true,
            isManual: true,
            status: true,
          },
        })
      : [];

    const state = await this.prisma.kgConnectorState.aggregate({
      where: { organizationId },
      _max: { lastStaticAt: true, lastObservedAt: true },
    });

    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        entity: n.entity,
        label: n.label,
        description: n.description,
        connectorId: n.connectorId,
        connectorName: n.connector?.name ?? null,
        fields: n.fields,
        toolNames: n.toolNames,
        source: n.source,
        confidence: n.confidence,
        observations: n.observations,
      })),
      edges,
      lastBuiltAt: state._max.lastStaticAt ?? state._max.lastObservedAt ?? null,
      enabled: true,
    };
  }

  async stats(organizationId: string) {
    const [nodes, edges, suggested] = await Promise.all([
      this.prisma.kgNode.count({ where: { organizationId } }),
      this.prisma.kgEdge.count({ where: { organizationId, status: { not: 'rejected' } } }),
      this.prisma.kgEdge.count({ where: { organizationId, status: 'suggested' } }),
    ]);
    return { nodes, edges, suggested };
  }

  /** Rebuild the whole org graph (static + observational) under a per-org lock. */
  async rebuild(organizationId: string) {
    if (!(await this.staticSvc.isEnabled(organizationId))) {
      throw new ConflictException('The knowledge graph is disabled for this workspace.');
    }
    const lockKey = `kg_rebuild_lock:${organizationId}`;
    const locked =
      this.redis.isConnected && (await this.redis.incr(lockKey)) > 1;
    if (locked) {
      throw new ConflictException('A graph rebuild is already running for this workspace.');
    }
    if (this.redis.isConnected) await this.redis.expire(lockKey, 120);
    try {
      const staticResult = await this.staticSvc.syncOrganization(organizationId, { force: true });
      const obs = await this.observationalSvc.ingestOrganization(organizationId);
      return { ...staticResult, ...obs };
    } finally {
      if (this.redis.isConnected) await this.redis.del(lockKey);
    }
  }

  /**
   * Create a custom entity by hand, attached to a chosen connector (so it stays
   * tenant-scoped, is served to the MCP servers that use that connector, and
   * survives rebuilds — STATIC sweeps never touch MANUAL nodes). Lets a workspace
   * model concepts its tool names don't surface, and link them to real entities.
   */
  async createNode(
    organizationId: string,
    body: { connectorId: string; label: string; entity?: string; description?: string },
  ) {
    if (!body.connectorId) {
      throw new ForbiddenException('A connector is required for a manual entity.');
    }
    const connector = await this.prisma.connector.findUnique({
      where: { id: body.connectorId },
      select: { organizationId: true },
    });
    if (!connector || connector.organizationId !== organizationId) {
      throw new NotFoundException('Connector not found.');
    }
    const label = (body.label || '').trim().slice(0, 200);
    if (!label) throw new ConflictException('A label is required.');
    const entity =
      ((body.entity || label)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80)) || 'entity';

    const exists = await this.prisma.kgNode.findUnique({
      where: {
        organizationId_connectorId_entity: {
          organizationId,
          connectorId: body.connectorId,
          entity,
        },
      },
      select: { id: true },
    });
    if (exists) {
      throw new ConflictException('An entity with that name already exists for this connector.');
    }
    return this.prisma.kgNode.create({
      data: {
        organizationId,
        connectorId: body.connectorId,
        entity,
        label,
        description:
          typeof body.description === 'string' ? body.description.slice(0, 2000) : null,
        source: 'MANUAL',
        confidence: 1,
      },
    });
  }

  async createManualEdge(
    organizationId: string,
    body: { sourceNodeId: string; targetNodeId: string; kind?: string; note?: string },
  ) {
    if (!body.sourceNodeId || !body.targetNodeId || body.sourceNodeId === body.targetNodeId) {
      throw new ForbiddenException('Invalid source/target.');
    }
    const count = await this.prisma.kgNode.count({
      where: { organizationId, id: { in: [body.sourceNodeId, body.targetNodeId] } },
    });
    if (count !== 2) throw new NotFoundException('Node not found in this workspace.');

    const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : undefined;
    return this.prisma.kgEdge.upsert({
      where: {
        organizationId_sourceNodeId_targetNodeId_kind: {
          organizationId,
          sourceNodeId: body.sourceNodeId,
          targetNodeId: body.targetNodeId,
          kind: body.kind || 'same_identity',
        },
      },
      create: {
        organizationId,
        sourceNodeId: body.sourceNodeId,
        targetNodeId: body.targetNodeId,
        kind: body.kind || 'same_identity',
        source: 'MANUAL',
        confidence: 1,
        isManual: true,
        status: 'active',
        note,
      },
      update: {
        source: 'MANUAL',
        isManual: true,
        status: 'active',
        confidence: 1,
        ...(note !== undefined ? { note } : {}),
      },
    });
  }

  /**
   * Edit an edge: confirm/reject (status), retype (kind), or add a human
   * description (note) that the MCP-served graph then exposes to AI clients.
   * Editing marks the edge MANUAL so later rebuilds never silently overwrite it.
   */
  async updateEdge(
    organizationId: string,
    edgeId: string,
    body: {
      status?: 'active' | 'rejected' | 'suggested';
      kind?: string;
      note?: string | null;
      matchKey?: string | null;
    },
  ) {
    const edge = await this.prisma.kgEdge.findUnique({
      where: { id: edgeId },
      select: { organizationId: true, kind: true, sourceNodeId: true, targetNodeId: true },
    });
    if (!edge || edge.organizationId !== organizationId) {
      throw new NotFoundException('Edge not found.');
    }

    // Retyping changes the (org, source, target, kind) identity — guard the
    // unique constraint so a clash surfaces as a clear 409 rather than a 500.
    if (body.kind && body.kind !== edge.kind) {
      const clash = await this.prisma.kgEdge.findUnique({
        where: {
          organizationId_sourceNodeId_targetNodeId_kind: {
            organizationId,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            kind: body.kind,
          },
        },
        select: { id: true },
      });
      if (clash && clash.id !== edgeId) {
        throw new ConflictException('An edge of that kind already exists between these entities.');
      }
    }

    const data: Record<string, unknown> = {};
    if (body.status) data.status = body.status;
    if (body.kind) data.kind = body.kind;
    if (body.note !== undefined) {
      data.note = body.note === null ? null : String(body.note).slice(0, 1000);
      data.isManual = true; // a human curated the rationale
    }
    if (body.matchKey !== undefined) data.matchKey = body.matchKey;
    return this.prisma.kgEdge.update({ where: { id: edgeId }, data });
  }

  /** Backwards-compatible alias used by older callers/tests. */
  setEdgeStatus(organizationId: string, edgeId: string, status: 'active' | 'rejected') {
    return this.updateEdge(organizationId, edgeId, { status });
  }

  /** Edit a node's human-facing label and/or description (served to AI clients). */
  async updateNode(
    organizationId: string,
    nodeId: string,
    body: { label?: string; description?: string | null },
  ) {
    const node = await this.prisma.kgNode.findUnique({
      where: { id: nodeId },
      select: { organizationId: true },
    });
    if (!node || node.organizationId !== organizationId) {
      throw new NotFoundException('Node not found.');
    }
    const data: Record<string, unknown> = {};
    if (typeof body.label === 'string' && body.label.trim()) {
      data.label = body.label.trim().slice(0, 200);
    }
    if (body.description !== undefined) {
      data.description =
        body.description === null ? null : String(body.description).slice(0, 2000);
    }
    return this.prisma.kgNode.update({ where: { id: nodeId }, data });
  }

  /**
   * Delete a node and (via FK cascade) its edges. Note: a STATIC node will be
   * re-created on the next rebuild if its connector still exposes the tools that
   * imply it; deleting is permanent only for OBSERVED/MANUAL noise.
   */
  async deleteNode(organizationId: string, nodeId: string) {
    const node = await this.prisma.kgNode.findUnique({
      where: { id: nodeId },
      select: { organizationId: true },
    });
    if (!node || node.organizationId !== organizationId) {
      throw new NotFoundException('Node not found.');
    }
    await this.prisma.kgNode.delete({ where: { id: nodeId } });
    return { ok: true };
  }

  /**
   * Answer "how do I obtain / what relates to X" — the payload behind the
   * MCP-exposed system tool. X is an entity or a parameter name (e.g.
   * "customer_id", "order").
   *
   * When `opts.connectorIds` is given (the per-server MCP path), the graph is
   * scoped to ONLY those connectors so an AI client sees its own server's
   * entities, never the whole org. Human descriptions on nodes/edges and the
   * org's applied skills are included so the client can act on curated context.
   */
  async lookup(
    organizationId: string,
    query: string,
    opts?: { connectorIds?: string[]; mcpServerId?: string },
  ) {
    const scope = opts?.connectorIds
      ? { connectorId: { in: opts.connectorIds.length ? opts.connectorIds : ['__none__'] } }
      : {};

    const skills = await this.scopedSkills(organizationId, opts);
    const q = (query || '').toLowerCase().trim().replace(/\s+/g, '_');
    if (!q) return { query, entities: [], howToObtain: [], relatedTo: [], skills };

    const nodes = await this.prisma.kgNode.findMany({
      where: { organizationId, ...scope },
      select: {
        id: true,
        entity: true,
        label: true,
        description: true,
        fields: true,
        toolNames: true,
      },
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const label = (id: string) => byId.get(id)?.label ?? '?';
    const tools = (id: string) => (byId.get(id)?.toolNames as string[] | undefined) ?? [];

    // Only edges whose BOTH endpoints are in scope (so cross-server entities
    // never leak through a shared org graph).
    const allEdges = await this.prisma.kgEdge.findMany({
      where: { organizationId, status: 'active' },
      select: { sourceNodeId: true, targetNodeId: true, kind: true, matchKey: true, note: true },
    });
    const edges = allEdges.filter(
      (e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId),
    );

    const matchedEntities = nodes
      .filter(
        (n) =>
          n.entity === q ||
          n.entity.includes(q) ||
          (n.fields as Array<{ name: string }>).some((f) => f.name.toLowerCase() === q),
      )
      .map((n) => ({
        entity: n.entity,
        label: n.label,
        ...(n.description ? { description: n.description } : {}),
        tools: tools(n.id),
      }));

    // Tools that PRODUCE the requested key/entity (edges whose match key is q,
    // or that point at the requested entity).
    const howToObtain = edges
      .filter((e) => e.matchKey?.toLowerCase() === q || label(e.targetNodeId).toLowerCase() === q)
      .map((e) => ({
        field: e.matchKey ?? q,
        fromEntity: label(e.sourceNodeId),
        toEntity: label(e.targetNodeId),
        kind: e.kind,
        ...(e.note ? { description: e.note } : {}),
        viaTools: tools(e.sourceNodeId).slice(0, 8),
      }));

    const relatedTo = edges
      .filter((e) => matchedEntities.some((m) => m.label === label(e.sourceNodeId) || m.label === label(e.targetNodeId)))
      .map((e) => ({
        from: label(e.sourceNodeId),
        to: label(e.targetNodeId),
        kind: e.kind,
        matchKey: e.matchKey,
        ...(e.note ? { description: e.note } : {}),
      }));

    return { query, entities: matchedEntities, howToObtain, relatedTo: relatedTo.slice(0, 25), skills };
  }

  /** Applied skills for the scope (server-wide skills + assigned connectors'). */
  private async scopedSkills(
    organizationId: string,
    opts?: { connectorIds?: string[]; mcpServerId?: string },
  ) {
    const or: any[] = [];
    if (opts?.mcpServerId) or.push({ mcpServerId: opts.mcpServerId });
    if (opts?.connectorIds?.length) or.push({ connectorId: { in: opts.connectorIds } });
    const rows = await this.prisma.kgSkillSuggestion.findMany({
      where: {
        organizationId,
        status: 'applied',
        ...(or.length ? { OR: or } : {}),
      },
      select: { title: true, whenToUse: true },
      take: 25,
    });
    return rows.map((r) => ({ title: r.title, whenToUse: r.whenToUse }));
  }

  async deleteEdge(organizationId: string, edgeId: string) {
    const edge = await this.prisma.kgEdge.findUnique({
      where: { id: edgeId },
      select: { organizationId: true },
    });
    if (!edge || edge.organizationId !== organizationId) {
      throw new NotFoundException('Edge not found.');
    }
    await this.prisma.kgEdge.delete({ where: { id: edgeId } });
    return { ok: true };
  }
}
