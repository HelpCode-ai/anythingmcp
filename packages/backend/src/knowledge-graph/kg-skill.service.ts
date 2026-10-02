import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KgLlmService } from './kg-llm.service';
import { chatJson, resolveLlmConfig } from './llm-client';
import { maybeRedactIntent } from './redact';

const MAX_INTENTS = 200;

/** Auto-apply a generated skill only when at/above this confidence. */
export const SKILL_AUTO_APPLY_MIN = 0.9;

const CONSOLIDATE_PROMPT = `You are tidying the ACTIVE skills (standing rules) of an AI tool-integration platform. You receive a list of currently-applied skills; several may overlap, duplicate, or restate the same rule.

Merge them into the FEWEST distinct, non-redundant skills that together preserve every real rule. Combine duplicates and near-duplicates into one; keep genuinely different rules separate; never drop a rule's meaning; do not invent new rules.

Return STRICT JSON: {"skills":[{"title":"<short>","whenToUse":"<when this rule applies>","instruction":"<imperative guidance>","confidence":0..1,"connector":"<connector name or null>"}]}.
Only use connector names that appear in the input (or null). Keep titles short and instructions actionable.`;

const JSON_SHAPE =
  'Return STRICT JSON: {"skills":[{"title":"<short>","whenToUse":"<when this rule applies>","instruction":"<imperative guidance for the agent>","confidence":0..1,"evidenceCount":<int>}]}.';

const GROUNDING =
  'Ground EVERY skill in the supplied intents (and connectors). Do not invent rules from general knowledge, and never reproduce any example wording from these instructions. If the inputs show no clear, recurring need, return {"skills":[]}.';

const CONNECTOR_PROMPT = `You improve an AI tool-integration platform by turning real user requests ("intents") into reusable "skills" — short corrections or domain rules that make future tool calls behave the way the user actually wants.

You receive recent tool calls, each with: the user's intent, the tool name, its connector, and whether it succeeded.

Look for RECURRING or HIGH-VALUE patterns in the intents where a standing rule would have produced the result the user actually asked for (e.g. a correction the user had to make).

${JSON_SHAPE}

Each skill also has a "connector": "<connector name or null>". Rules:
- Propose at most 6 skills. Prefer specific, actionable rules.
- Only use connector names that appear in the input (or null).
- ${GROUNDING}`;

const SERVER_PROMPT = `You configure a single MCP server that combines SEVERAL connectors into one assistant. Turn real user requests ("intents") into reusable cross-connector "skills" — rules that apply to the WHOLE server, understanding how its connectors relate.

You receive: the server's connectors with their entities, and recent tool calls (intent, tool, connector, success).

Look for HIGH-VALUE rules grounded in the intents that span or coordinate connectors, or encode a domain convention the user explicitly stated or corrected.

${JSON_SHAPE}
Rules: at most 6 server-wide skills, specific and actionable. ${GROUNDING}`;

/**
 * Turns captured user intents into reviewable skill suggestions via the LLM.
 * Scope is a single connector OR a whole MCP server (combined context of all its
 * connectors). Opt-in (requires AI enrichment). Applied skills are composed into
 * the MCP server's instructions dynamically — so editing or deleting one takes
 * effect immediately, without mutating the connector/server instruction blobs.
 */
@Injectable()
export class KgSkillService {
  private readonly logger = new Logger(KgSkillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: KgLlmService,
  ) {}

  async generate(
    organizationId: string,
    opts?: { mcpServerId?: string },
  ): Promise<{ created: number; skipped?: boolean; model?: string; usage?: any }> {
    if (!(await this.llm.isEnabled(organizationId))) {
      throw new ConflictException('AI features are disabled for this workspace.');
    }
    return opts?.mcpServerId
      ? this.generateForServer(organizationId, opts.mcpServerId)
      : this.generateForConnectors(organizationId);
  }

  /** Per-workspace "auto-apply high-confidence skills" switch (default off). */
  async autoApplyEnabled(organizationId: string): Promise<boolean> {
    const row = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: 'kg_skill_auto_apply' } },
      select: { value: true },
    });
    return row?.value === 'true';
  }

  private async generateForConnectors(organizationId: string) {
    const cfg = resolveLlmConfig()!;
    const built = await this.buildConnectorRequest(organizationId);
    if (!built) return { created: 0, model: cfg.model };
    const { json, skipped, usage } = await chatJson(cfg, built.system, built.user);
    // Custom endpoint with an unusable reply: return early before
    // applyConnectorResult so pending suggestions are left untouched.
    if (skipped) return { created: 0, skipped: true, model: cfg.model };
    const created = await this.applyConnectorResult(organizationId, json);
    this.logger.log(`KG skills (connectors) ${organizationId}: ${created}`);
    return { created, model: cfg.model, usage };
  }

  /** Pure prompt builder for connector-scoped skills (intents redacted). */
  async buildConnectorRequest(
    organizationId: string,
  ): Promise<{ system: string; user: string } | null> {
    const invocations = await this.prisma.toolInvocation.findMany({
      where: { organizationId, intent: { not: null } },
      select: {
        intent: true,
        status: true,
        tool: { select: { name: true, connector: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_INTENTS,
    });
    if (invocations.length === 0) return null;

    const calls = invocations.map((i) => ({
      intent: maybeRedactIntent((i.intent ?? '').slice(0, 400)),
      tool: i.tool?.name ?? 'unknown',
      connector: i.tool?.connector?.name ?? '',
      ok: i.status === 'SUCCESS',
    }));
    return { system: CONNECTOR_PROMPT, user: JSON.stringify({ calls }) };
  }

  /** Apply a connector-scoped skills LLM result (sync or batch). */
  async applyConnectorResult(organizationId: string, json: any): Promise<number> {
    const skills: any[] = Array.isArray(json?.skills) ? json.skills : [];
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const idByName = new Map(connectors.map((c) => [c.name.toLowerCase(), c.id]));
    const autoApply = await this.autoApplyEnabled(organizationId);

    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, status: 'pending', mcpServerId: null },
    });

    let created = 0;
    for (const s of skills) {
      const connectorId =
        typeof s?.connector === 'string' ? (idByName.get(s.connector.toLowerCase()) ?? null) : null;
      if (await this.insertSkill(organizationId, { connectorId }, s, autoApply)) created++;
    }
    return created;
  }

  private async generateForServer(organizationId: string, mcpServerId: string) {
    const cfg = resolveLlmConfig()!;
    const server = await this.prisma.mcpServerConfig.findUnique({
      where: { id: mcpServerId },
      select: { id: true, name: true, organizationId: true },
    });
    if (!server || server.organizationId !== organizationId) {
      throw new NotFoundException('MCP server not found.');
    }

    const links = await this.prisma.mcpServerConnector.findMany({
      where: { mcpServerId },
      select: { connectorId: true, connector: { select: { name: true } } },
    });
    const connectorIds = links.map((l) => l.connectorId);

    const nodes = await this.prisma.kgNode.findMany({
      where: { organizationId, connectorId: { in: connectorIds.length ? connectorIds : ['__none__'] } },
      select: { entity: true, connector: { select: { name: true } } },
    });
    const connectorsContext = links.map((l) => ({
      connector: l.connector?.name ?? '',
      entities: nodes.filter((n) => n.connector?.name === l.connector?.name).map((n) => n.entity),
    }));

    const invocations = await this.prisma.toolInvocation.findMany({
      where: { organizationId, mcpServerId, intent: { not: null } },
      select: {
        intent: true,
        status: true,
        tool: { select: { name: true, connector: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_INTENTS,
    });

    const calls = invocations.map((i) => ({
      intent: maybeRedactIntent((i.intent ?? '').slice(0, 400)),
      tool: i.tool?.name ?? 'unknown',
      connector: i.tool?.connector?.name ?? '',
      ok: i.status === 'SUCCESS',
    }));

    const { json, skipped, usage } = await chatJson(
      cfg,
      SERVER_PROMPT,
      JSON.stringify({ server: server.name, connectors: connectorsContext, calls }),
    );
    // Custom endpoint with an unusable reply: return early before the
    // deleteMany below so pending suggestions are left untouched.
    if (skipped) return { created: 0, skipped: true, model: cfg.model };
    const skills: any[] = Array.isArray(json?.skills) ? json.skills : [];

    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, status: 'pending', mcpServerId },
    });
    const autoApply = await this.autoApplyEnabled(organizationId);

    let created = 0;
    for (const s of skills) {
      if (await this.insertSkill(organizationId, { mcpServerId }, s, autoApply)) created++;
    }
    this.logger.log(`KG skills (server ${server.name}) ${organizationId}: ${created}`);
    return { created, model: cfg.model, usage };
  }

  private async insertSkill(
    organizationId: string,
    scope: { connectorId?: string | null; mcpServerId?: string | null },
    s: any,
    autoApply = false,
    forceStatus?: string,
  ): Promise<boolean> {
    const title = typeof s?.title === 'string' ? s.title.slice(0, 160) : null;
    const instruction = typeof s?.instruction === 'string' ? s.instruction.slice(0, 2000) : null;
    if (!title || !instruction) return false;
    const confidence = Math.max(0, Math.min(1, Number(s?.confidence) || 0.5));
    const status =
      forceStatus ?? (autoApply && confidence >= SKILL_AUTO_APPLY_MIN ? 'applied' : 'pending');
    await this.prisma.kgSkillSuggestion.create({
      data: {
        organizationId,
        connectorId: scope.connectorId ?? null,
        mcpServerId: scope.mcpServerId ?? null,
        title,
        whenToUse: typeof s?.whenToUse === 'string' ? s.whenToUse.slice(0, 1000) : '',
        instruction,
        confidence,
        evidenceCount: Math.max(0, Math.min(9999, parseInt(s?.evidenceCount, 10) || 0)),
        status,
      },
    });
    return true;
  }

  /**
   * Paginated, filterable list of skills for the workspace, plus the per-status
   * counts (so the UI can show tabs/totals without loading everything). `status`
   * filters to one bucket; `q` is a case-insensitive search over title / when /
   * instruction.
   */
  async list(
    organizationId: string,
    opts?: { status?: string; q?: string; take?: number; skip?: number },
  ) {
    const where: any = { organizationId };
    if (opts?.status && ['pending', 'applied', 'dismissed'].includes(opts.status)) {
      where.status = opts.status;
    }
    if (opts?.q && opts.q.trim()) {
      const q = opts.q.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { whenToUse: { contains: q, mode: 'insensitive' } },
        { instruction: { contains: q, mode: 'insensitive' } },
      ];
    }
    const take = Math.min(Math.max(opts?.take ?? 25, 1), 100);
    const skip = Math.max(opts?.skip ?? 0, 0);

    const [items, total, grouped] = await Promise.all([
      this.prisma.kgSkillSuggestion.findMany({
        where,
        orderBy: [{ status: 'asc' }, { confidence: 'desc' }],
        include: {
          connector: { select: { name: true } },
          mcpServer: { select: { name: true } },
        },
        take,
        skip,
      }),
      this.prisma.kgSkillSuggestion.count({ where }),
      this.prisma.kgSkillSuggestion.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { _all: true },
      }),
    ]);

    const counts = { pending: 0, applied: 0, dismissed: 0 };
    for (const g of grouped) {
      if (g.status in counts) counts[g.status as keyof typeof counts] = g._count._all;
    }
    return { items, total, counts, take, skip };
  }

  /**
   * Merge the workspace's ACTIVE (applied) skills in a scope into the fewest
   * non-redundant skills via the LLM, then replace them. Pending suggestions and
   * dismissed skills are left untouched, so consolidation never silently
   * activates or revives anything. Scope mirrors generate: a specific server, or
   * the connector-scoped set (mcpServerId = null).
   */
  async consolidate(
    organizationId: string,
    opts?: { mcpServerId?: string },
  ): Promise<{ before: number; after: number; model?: string; usage?: any }> {
    if (!(await this.llm.isEnabled(organizationId))) {
      throw new ConflictException('AI features are disabled for this workspace.');
    }
    const cfg = resolveLlmConfig()!;
    const mcpServerId = opts?.mcpServerId ?? null;
    if (mcpServerId) {
      const srv = await this.prisma.mcpServerConfig.findUnique({
        where: { id: mcpServerId },
        select: { organizationId: true },
      });
      if (!srv || srv.organizationId !== organizationId) {
        throw new NotFoundException('MCP server not found.');
      }
    }

    const where = mcpServerId
      ? { organizationId, status: 'applied', mcpServerId }
      : { organizationId, status: 'applied', mcpServerId: null };
    const current = await this.prisma.kgSkillSuggestion.findMany({
      where,
      select: {
        id: true,
        title: true,
        whenToUse: true,
        instruction: true,
        connector: { select: { name: true } },
      },
    });
    if (current.length < 2) return { before: current.length, after: current.length, model: cfg.model };

    const payload = current.map((s) => ({
      title: s.title,
      whenToUse: s.whenToUse,
      instruction: s.instruction,
      connector: mcpServerId ? undefined : (s.connector?.name ?? null),
    }));
    const { json, usage } = await chatJson(cfg, CONSOLIDATE_PROMPT, JSON.stringify({ skills: payload }));
    const merged: any[] = Array.isArray(json?.skills) ? json.skills : [];
    // Safety: never let a bad/empty model response wipe live skills.
    if (merged.length === 0 || merged.length >= current.length) {
      return { before: current.length, after: current.length, model: cfg.model, usage };
    }

    const idByName = new Map(
      (
        await this.prisma.connector.findMany({
          where: { organizationId },
          select: { id: true, name: true },
        })
      ).map((c) => [c.name.toLowerCase(), c.id]),
    );

    const after = await this.prisma.$transaction(async (tx) => {
      await tx.kgSkillSuggestion.deleteMany({ where });
      let n = 0;
      for (const s of merged) {
        const title = typeof s?.title === 'string' ? s.title.slice(0, 160) : null;
        const instruction = typeof s?.instruction === 'string' ? s.instruction.slice(0, 2000) : null;
        if (!title || !instruction) continue;
        const connectorId =
          !mcpServerId && typeof s?.connector === 'string'
            ? (idByName.get(s.connector.toLowerCase()) ?? null)
            : null;
        await tx.kgSkillSuggestion.create({
          data: {
            organizationId,
            connectorId,
            mcpServerId,
            title,
            whenToUse: typeof s?.whenToUse === 'string' ? s.whenToUse.slice(0, 1000) : '',
            instruction,
            confidence: Math.max(0, Math.min(1, Number(s?.confidence) || 0.8)),
            evidenceCount: 0,
            status: 'applied',
          },
        });
        n++;
      }
      return n;
    });

    this.logger.log(`KG skills consolidate ${organizationId}: ${current.length} → ${after}`);
    return { before: current.length, after, model: cfg.model, usage };
  }

  /** Active skills composed into an MCP server's instructions at serve time. */
  async activeSkillsText(
    serverId: string | string[],
    connectorIds: string[],
  ): Promise<string | null> {
    const serverIds = Array.isArray(serverId) ? serverId : [serverId];
    const skills = await this.prisma.kgSkillSuggestion.findMany({
      where: {
        status: 'applied',
        OR: [
          { mcpServerId: { in: serverIds.length ? serverIds : ['__none__'] } },
          { connectorId: { in: connectorIds.length ? connectorIds : ['__none__'] } },
        ],
      },
      select: { title: true, whenToUse: true, instruction: true },
      orderBy: { confidence: 'desc' },
    });
    if (!skills.length) return null;
    const body = skills
      .map((s) => `- ${s.title}${s.whenToUse ? ` (when: ${s.whenToUse})` : ''}: ${s.instruction}`)
      .join('\n');
    return `## Workspace skills\n${body}`;
  }

  /**
   * Create a skill by hand (not AI-generated). Scoped to a single connector OR a
   * whole MCP server (mutually exclusive). Defaults to `applied` so it is live
   * for MCP immediately — a deliberately authored rule needs no review step.
   */
  async create(
    organizationId: string,
    body: {
      title: string;
      whenToUse?: string;
      instruction: string;
      connectorId?: string | null;
      mcpServerId?: string | null;
      status?: string;
    },
  ) {
    const title = (body.title || '').trim().slice(0, 160);
    const instruction = (body.instruction || '').trim().slice(0, 2000);
    if (!title || !instruction) {
      throw new ConflictException('A skill needs a title and an instruction.');
    }
    // Validate the chosen scope belongs to this org (fail closed).
    let connectorId: string | null = null;
    let mcpServerId: string | null = null;
    if (body.mcpServerId) {
      const srv = await this.prisma.mcpServerConfig.findUnique({
        where: { id: body.mcpServerId },
        select: { organizationId: true },
      });
      if (!srv || srv.organizationId !== organizationId) {
        throw new NotFoundException('MCP server not found.');
      }
      mcpServerId = body.mcpServerId;
    } else if (body.connectorId) {
      const con = await this.prisma.connector.findUnique({
        where: { id: body.connectorId },
        select: { organizationId: true },
      });
      if (!con || con.organizationId !== organizationId) {
        throw new NotFoundException('Connector not found.');
      }
      connectorId = body.connectorId;
    }
    const status =
      body.status && ['pending', 'applied', 'dismissed'].includes(body.status)
        ? body.status
        : 'applied';
    return this.prisma.kgSkillSuggestion.create({
      data: {
        organizationId,
        connectorId,
        mcpServerId,
        title,
        whenToUse: typeof body.whenToUse === 'string' ? body.whenToUse.slice(0, 1000) : '',
        instruction,
        confidence: 1,
        evidenceCount: 0,
        status,
      },
    });
  }

  private async owned(organizationId: string, id: string) {
    const s = await this.prisma.kgSkillSuggestion.findUnique({ where: { id } });
    if (!s || s.organizationId !== organizationId) throw new NotFoundException('Suggestion not found.');
    return s;
  }

  async apply(organizationId: string, id: string) {
    await this.owned(organizationId, id);
    return this.prisma.kgSkillSuggestion.update({ where: { id }, data: { status: 'applied' } });
  }

  async dismiss(organizationId: string, id: string) {
    await this.owned(organizationId, id);
    return this.prisma.kgSkillSuggestion.update({ where: { id }, data: { status: 'dismissed' } });
  }

  async update(
    organizationId: string,
    id: string,
    patch: { title?: string; whenToUse?: string; instruction?: string; status?: string },
  ) {
    await this.owned(organizationId, id);
    const data: Record<string, unknown> = {};
    if (typeof patch.title === 'string') data.title = patch.title.slice(0, 160);
    if (typeof patch.whenToUse === 'string') data.whenToUse = patch.whenToUse.slice(0, 1000);
    if (typeof patch.instruction === 'string') data.instruction = patch.instruction.slice(0, 2000);
    if (patch.status && ['pending', 'applied', 'dismissed'].includes(patch.status)) {
      data.status = patch.status;
    }
    return this.prisma.kgSkillSuggestion.update({ where: { id }, data });
  }

  async remove(organizationId: string, id: string) {
    await this.owned(organizationId, id);
    await this.prisma.kgSkillSuggestion.delete({ where: { id } });
    return { ok: true };
  }
}
