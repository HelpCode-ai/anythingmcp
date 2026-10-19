import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KgLlmService } from './kg-llm.service';
import { chatJson, resolveLlmConfig } from './llm-client';
import { maybeRedactIntent } from './redact';
import { findFixPatterns, FIX_WINDOW_MS, type FixPattern } from './error-fix';
import {
  folderVisibility,
  resolveFolder,
  subtreeIds,
  type FolderAccess,
  type FolderNode,
} from '../knowledge-folders/knowledge-folders.service';

const MAX_INTENTS = 200;

/** Where a skill came from; generation only ever replaces its own `llm` rows. */
export type SkillSource = 'manual' | 'llm' | 'finder' | 'consolidation' | 'errors';

/** Longest procedure (`body`) a skill can carry. Served by skill_get only. */
export const SKILL_BODY_MAX = 20_000;

/** How applied skills reach the model on initialize (per MCP server). */
export const SKILLS_DELIVERY_MODES = ['auto', 'inline', 'index'] as const;
export type SkillsDelivery = (typeof SKILLS_DELIVERY_MODES)[number];

/**
 * `auto` keeps the full text up to this many characters, then switches to the
 * index. The skills_v2 migration pins every server that already received
 * applied skills to `inline`, so this only applies to new servers and to
 * admins who choose it.
 */
export const SKILLS_INLINE_BUDGET = 6_000;
/** Most text the shared /mcp guide returns for skills before shortening. */
const SKILLS_FULL_BUDGET = 30_000;
/** The index stops listing entries past this size and points to skills_list. */
const SKILLS_INDEX_BUDGET = 8_000;
const INDEX_WHEN_MAX = 200;

/** Built-in MCP tool names (per-server endpoint). */
export const SKILLS_LIST_TOOL = 'skills_list';
export const SKILL_GET_TOOL = 'skill_get';

interface SkillRow {
  id: string;
  title: string;
  whenToUse: string;
  instruction: string;
  body: string | null;
  version: number;
  folderId?: string | null;
}

/** The skills a caller may see: the server's own and its visible connectors'. */
function visibleWhere(
  organizationId: string,
  serverIds: string[],
  connectorIds: string[],
  folders?: FolderAccess | null,
) {
  const inFolders = folderVisibility(folders);
  return {
    // Re-stated rather than trusted from the ids, so a stray id can never
    // pull another workspace's skills in.
    organizationId,
    status: 'applied',
    OR: [
      { mcpServerId: { in: serverIds.length ? serverIds : ['__none__'] } },
      { connectorId: { in: connectorIds.length ? connectorIds : ['__none__'] } },
    ],
    // Skills in folders limited to roles the caller lacks are not there.
    ...(Object.keys(inFolders).length ? { AND: [inFolders] } : {}),
  };
}

function pathOf(folders: FolderNode[] | undefined, folderId?: string | null): string | null {
  if (!folderId || !folders) return null;
  return folders.find((f) => f.id === folderId)?.path ?? null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function inlineText(rows: SkillRow[], withBodies: boolean, folders?: FolderNode[]): string {
  const body = rows
    .map((s) => {
      const path = pathOf(folders, s.folderId);
      const head = `- ${s.title}${path ? ` [${path}]` : ''}${s.whenToUse ? ` (when: ${s.whenToUse})` : ''}: ${s.instruction}`;
      if (!s.body) return head;
      return withBodies
        ? `${head}\n\n${s.body}\n`
        : `${head} (full procedure: ${SKILL_GET_TOOL} "${s.id}")`;
    })
    .join('\n');
  return `## Workspace skills\n${body}`;
}

function indexLine(s: SkillRow): string {
  return `- \`${s.id}\` ${s.title}${s.whenToUse ? `: ${oneLine(s.whenToUse, INDEX_WHEN_MAX)}` : ''}`;
}

/**
 * The skills as an index for skill_get. Without folders: one list, cut at the
 * budget. With folders: grouped by folder; when that does not fit, the root
 * skills plus one line per top-level folder (description and count), which
 * the model opens with skills_list.
 */
function indexText(rows: SkillRow[], folders?: FolderNode[]): string {
  const head =
    `## Workspace skills\n` +
    `This workspace has ${rows.length} skill${rows.length === 1 ? '' : 's'}: its procedures and rules. ` +
    `Before a task that matches one, call \`${SKILL_GET_TOOL}\` with its id and follow it. ` +
    `\`${SKILLS_LIST_TOOL}\` searches them all.`;
  const fit = (lines: string[], start: number) => {
    const out: string[] = [];
    let size = start;
    for (const line of lines) {
      if (size + line.length + 1 > SKILLS_INDEX_BUDGET) break;
      out.push(line);
      size += line.length + 1;
    }
    return out;
  };

  const filed = rows.some((r) => pathOf(folders, r.folderId));
  if (!filed) {
    const lines = fit(rows.map(indexLine), head.length);
    const rest = rows.length - lines.length;
    if (rest > 0) lines.push(`- …and ${rest} more: call \`${SKILLS_LIST_TOOL}\`.`);
    return `${head}\n${lines.join('\n')}`;
  }

  const root = rows.filter((r) => !pathOf(folders, r.folderId));
  const byPath = new Map<string, SkillRow[]>();
  for (const r of rows) {
    const p = pathOf(folders, r.folderId);
    if (p) byPath.set(p, [...(byPath.get(p) ?? []), r]);
  }
  const grouped = [
    ...root.map(indexLine),
    ...[...byPath.keys()].sort().flatMap((p) => [`### ${p}`, ...byPath.get(p)!.map(indexLine)]),
  ];
  if (grouped.join('\n').length + head.length + 1 <= SKILLS_INDEX_BUDGET) {
    return `${head}\n${grouped.join('\n')}`;
  }

  // Too many: the root skills, then one line per top-level folder.
  const tops = (folders ?? []).filter((f) => !f.parentId);
  const folderLines = tops
    .map((t) => {
      const ids = subtreeIds(folders!, t.id);
      const n = rows.filter((r) => r.folderId && ids.has(r.folderId)).length;
      if (!n) return null;
      return `- Folder "${t.path}" (${n} skill${n === 1 ? '' : 's'})${t.description ? `: ${oneLine(t.description, INDEX_WHEN_MAX)}` : ''}`;
    })
    .filter((l): l is string => !!l);
  const intro = `Skills are filed in folders. Open one with \`${SKILLS_LIST_TOOL}\` and its folder.`;
  const folderBlock = [intro, ...folderLines];
  const start = head.length + folderBlock.join('\n').length + 2;
  const rootLines = fit(root.map(indexLine), start);
  const restRoot = root.length - rootLines.length;
  if (restRoot > 0) rootLines.push(`- …and ${restRoot} more outside folders: call \`${SKILLS_LIST_TOOL}\`.`);
  return `${head}\n${[...folderBlock, ...rootLines].join('\n')}`;
}

/** Auto-apply a generated skill only when at/above this confidence. */
export const SKILL_AUTO_APPLY_MIN = 0.9;

const CONSOLIDATE_PROMPT = `You are tidying the ACTIVE skills (standing rules) of an AI tool-integration platform. You receive the currently-applied skills of one scope, each with a "ref"; several may overlap, duplicate, or restate the same rule.

Propose merges: combine duplicates and near-duplicates into one skill that preserves every real rule of the skills it replaces; never drop a rule's meaning; do not invent new rules. Write each merged instruction once, concisely: state a rule a single time even when several skills say it. Leave skills that need no merging out of the answer.

Return STRICT JSON: {"skills":[{"title":"<short>","whenToUse":"<when this rule applies>","instruction":"<imperative guidance>","confidence":0..1,"replaces":["<ref>","<ref>"]}]}.
Each merged skill lists the refs it replaces (at least two); a ref appears in at most one merged skill. Keep titles short and instructions actionable.`;

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
    // Learning from fixed errors needs no model; it runs with every pass.
    const fromErrors = await this.proposeFromErrors(organizationId).catch((e: any) => {
      this.logger.warn(`Skill proposals from errors failed for ${organizationId}: ${e?.message ?? e}`);
      return { created: 0 };
    });
    this.logger.log(`KG skills (connectors) ${organizationId}: ${created} (+${fromErrors.created} from errors)`);
    return { created: created + fromErrors.created, model: cfg.model, usage };
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

  /**
   * Proposes skills from calls that failed and were then fixed by changing
   * the format of an argument (see error-fix.ts). Only calls stamped
   * learnable (members who contribute to learning) are read, and only the
   * argument names and value formats are kept. Each pattern seen at least
   * twice becomes a pending skill on the tool's connector; previous pending
   * proposals of this kind are replaced and dismissed ones are not proposed
   * again. Needs no AI model.
   */
  async proposeFromErrors(
    organizationId: string,
    opts?: { days?: number; now?: Date },
  ): Promise<{ created: number; patterns: number }> {
    const now = opts?.now ?? new Date();
    const since = new Date(now.getTime() - (opts?.days ?? 30) * 24 * 60 * 60 * 1000);
    const failures = await this.prisma.toolInvocation.findMany({
      where: {
        organizationId,
        learnable: true,
        status: { not: 'SUCCESS' },
        createdAt: { gte: since },
        userId: { not: null },
      },
      select: { toolId: true, userId: true, status: true, input: true, error: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    if (failures.length === 0) return { created: 0, patterns: 0 };

    // Successes of the same people and tools, from the first failure on.
    const pairs = [...new Set(failures.map((f) => `${f.userId}|${f.toolId}`))].slice(0, 300);
    const first = new Date(Math.min(...failures.map((f) => f.createdAt.getTime())));
    const successes = await this.prisma.toolInvocation.findMany({
      where: {
        organizationId,
        learnable: true,
        status: 'SUCCESS',
        createdAt: { gte: first, lte: new Date(now.getTime() + FIX_WINDOW_MS) },
        OR: pairs.map((p) => {
          const [userId, toolId] = p.split('|');
          return { userId, toolId };
        }),
      },
      select: { toolId: true, userId: true, status: true, input: true, error: true, createdAt: true },
      // Newest first, like the failures, so busy workspaces keep recent fixes.
      orderBy: { createdAt: 'desc' },
      take: 3000,
    });
    const rows = [...failures, ...successes]
      .map((r) => ({ ...r, userId: r.userId ?? null, status: String(r.status) }))
      .sort(
        (a, b) =>
          (a.userId ?? '').localeCompare(b.userId ?? '') ||
          a.toolId.localeCompare(b.toolId) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    const patterns = findFixPatterns(rows);

    const tools = patterns.length
      ? await this.prisma.mcpTool.findMany({
          where: { id: { in: [...new Set(patterns.map((p) => p.toolId))] }, connector: { organizationId } },
          select: { id: true, name: true, connectorId: true },
        })
      : [];
    const known = new Set(
      (
        await this.prisma.kgSkillSuggestion.findMany({
          where: { organizationId, source: 'errors', status: { in: ['applied', 'dismissed'] } },
          select: { title: true },
        })
      ).map((r) => r.title),
    );

    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, status: 'pending', source: 'errors' },
    });
    let created = 0;
    for (const p of patterns.slice(0, 20)) {
      const tool = tools.find((t) => t.id === p.toolId);
      if (!tool) continue;
      const draft = errorFixSkill(tool.name, p);
      if (known.has(draft.title)) continue;
      await this.prisma.kgSkillSuggestion.create({
        data: {
          organizationId,
          connectorId: tool.connectorId,
          ...draft,
          confidence: Math.min(0.95, 0.5 + 0.1 * p.occurrences),
          evidenceCount: p.occurrences,
          status: 'pending',
          source: 'errors',
        },
      });
      created++;
    }
    return { created, patterns: patterns.length };
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

    // Replace only the previous generation's pending output: manual pending
    // skills and Finder suggestions awaiting approval are not ours to drop.
    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, status: 'pending', source: 'llm', mcpServerId: null },
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
      where: { organizationId, status: 'pending', source: 'llm', mcpServerId },
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
        source: 'llm',
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
    opts?: {
      status?: string;
      q?: string;
      take?: number;
      skip?: number;
      /** A folder id (with its subfolders), or 'none' for skills outside folders. */
      folderId?: string;
      /** The caller's folder access; skills in folders they may not see are left out. */
      folders?: FolderAccess | null;
    },
  ) {
    const visible = folderVisibility(opts?.folders);
    const where: any = { organizationId, AND: [visible] };
    if (opts?.folderId === 'none') {
      where.folderId = null;
    } else if (opts?.folderId) {
      const tree = opts.folders?.folders ?? [];
      where.folderId = tree.some((f) => f.id === opts.folderId)
        ? { in: [...subtreeIds(tree, opts.folderId)] }
        : '__none__';
    }
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
        where: { organizationId, AND: [visible] },
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
  ): Promise<{ before: number; after: number; proposed: number; replaced: number; model?: string; usage?: any }> {
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

    // Skills with a procedure are left out: the merge works on the short
    // rules only and would drop the procedure.
    const where = mcpServerId
      ? { organizationId, status: 'applied', mcpServerId, body: null }
      : { organizationId, status: 'applied', mcpServerId: null, body: null };
    const current = await this.prisma.kgSkillSuggestion.findMany({
      where,
      select: {
        id: true,
        title: true,
        whenToUse: true,
        instruction: true,
        connectorId: true,
        folderId: true,
      },
    });
    const none = { before: current.length, after: current.length, proposed: 0, replaced: 0, model: cfg.model };
    if (current.length < 2) return none;

    // Merge only within one folder (and one connector), so a merged skill
    // keeps exactly the place, and the audience, of what it replaces.
    const groups = new Map<string, typeof current>();
    for (const sk of current) {
      const key = `${sk.folderId ?? ''}|${mcpServerId ? '' : (sk.connectorId ?? '')}`;
      groups.set(key, [...(groups.get(key) ?? []), sk]);
    }
    const drafts: Array<{ data: Record<string, unknown>; replaces: string[] }> = [];
    let usage: any;
    let answered = false;
    for (const group of [...groups.values()].filter((g) => g.length >= 2).slice(0, 10)) {
      const refs = new Map(group.map((sk, i) => [`s${i + 1}`, sk]));
      const payload = [...refs].map(([ref, sk]) => ({
        ref,
        title: sk.title,
        whenToUse: sk.whenToUse,
        instruction: sk.instruction,
      }));
      const res = await chatJson(cfg, CONSOLIDATE_PROMPT, JSON.stringify({ skills: payload }));
      usage = res.usage ?? usage;
      if (res.skipped || !Array.isArray(res.json?.skills)) continue;
      answered = true;
      const merged: any[] = res.json.skills;
      const used = new Set<string>();
      for (const m of merged) {
        const title = typeof m?.title === 'string' ? m.title.slice(0, 160) : null;
        const instruction = typeof m?.instruction === 'string' ? m.instruction.slice(0, 2000) : null;
        const replaced = (Array.isArray(m?.replaces) ? m.replaces : [])
          .filter((r: unknown) => typeof r === 'string' && refs.has(r) && !used.has(r)) as string[];
        if (!title || !instruction || replaced.length < 2) continue;
        replaced.forEach((r) => used.add(r));
        const first = refs.get(replaced[0])!;
        drafts.push({
          replaces: replaced.map((r) => refs.get(r)!.id),
          data: {
            organizationId,
            mcpServerId,
            connectorId: mcpServerId ? null : first.connectorId,
            folderId: first.folderId,
            title,
            whenToUse: typeof m?.whenToUse === 'string' ? m.whenToUse.slice(0, 1000) : '',
            instruction,
            confidence: Math.max(0, Math.min(1, Number(m?.confidence) || 0.8)),
            evidenceCount: 0,
          },
        });
      }
    }

    // A model that gave no usable answer leaves earlier proposals alone.
    if (!answered) return { ...none, usage };
    // Proposals only: nothing live changes until an admin applies one.
    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, status: 'pending', source: 'consolidation', mcpServerId },
    });
    for (const d of drafts) {
      await this.prisma.kgSkillSuggestion.create({
        data: { ...(d.data as any), status: 'pending', source: 'consolidation', replaces: d.replaces },
      });
    }
    const replaced = drafts.reduce((n, d) => n + d.replaces.length, 0);
    this.logger.log(
      `KG skills consolidate ${organizationId}: ${drafts.length} proposal(s) replacing ${replaced} of ${current.length}`,
    );
    return {
      before: current.length,
      after: current.length - replaced + drafts.length,
      proposed: drafts.length,
      replaced,
      model: cfg.model,
      usage,
    };
  }

  /**
   * Applied skills as instruction text. `inline` is the full text (procedures
   * referenced, not pasted), `index` lists titles for skill_get, `auto` picks
   * inline while it fits SKILLS_INLINE_BUDGET, `full` pastes the procedures
   * too (the shared /mcp guide, which has no skill_get).
   */
  async activeSkillsText(
    organizationId: string,
    serverId: string | string[],
    connectorIds: string[],
    mode: SkillsDelivery | 'full' = 'inline',
    folders?: FolderAccess | null,
  ): Promise<string | null> {
    const serverIds = Array.isArray(serverId) ? serverId : [serverId];
    const rows: SkillRow[] = await this.prisma.kgSkillSuggestion.findMany({
      where: visibleWhere(organizationId, serverIds, connectorIds, folders),
      select: {
        id: true,
        title: true,
        whenToUse: true,
        instruction: true,
        body: true,
        version: true,
        folderId: true,
      },
      orderBy: { confidence: 'desc' },
    });
    if (!rows.length) return null;
    const tree = folders?.folders;
    if (mode === 'full') {
      // The shared guide has no skill_get; keep it bounded all the same.
      const full = inlineText(rows, true, tree);
      if (full.length <= SKILLS_FULL_BUDGET) return full;
      const inline = inlineText(rows, false, tree);
      return inline.length <= SKILLS_FULL_BUDGET ? inline : indexText(rows, tree);
    }
    if (mode === 'index') return indexText(rows, tree);
    const inline = inlineText(rows, false, tree);
    if (mode === 'inline' || inline.length <= SKILLS_INLINE_BUDGET) return inline;
    return indexText(rows, tree);
  }

  /** Whether a caller sees at least one applied skill (offers the skill tools). */
  async hasVisible(
    organizationId: string,
    serverId: string,
    connectorIds: string[],
    folders?: FolderAccess | null,
  ): Promise<boolean> {
    const n = await this.prisma.kgSkillSuggestion.count({
      where: visibleWhere(organizationId, [serverId], connectorIds, folders),
    });
    return n > 0;
  }

  /** skills_list: the caller's visible skills, optionally filtered. */
  async listForCaller(
    organizationId: string,
    serverId: string,
    connectorIds: string[],
    query?: string,
    folders?: FolderAccess | null,
    folderRef?: string,
  ) {
    const q = (query ?? '').trim();
    // A folder narrows the list to it and its subfolders (by id or path,
    // among the folders this caller may see).
    let inFolder: Record<string, unknown> | null = null;
    if (folderRef?.trim()) {
      const f = resolveFolder(folders?.folders ?? [], folderRef);
      if (!f) return [];
      inFolder = { folderId: { in: [...subtreeIds(folders!.folders, f.id)] } };
    }
    const rows = await this.prisma.kgSkillSuggestion.findMany({
      where: {
        AND: [
          visibleWhere(organizationId, [serverId], connectorIds, folders),
          ...(inFolder ? [inFolder] : []),
          ...(q
            ? [
                {
                  OR: [
                    { title: { contains: q, mode: 'insensitive' as const } },
                    { whenToUse: { contains: q, mode: 'insensitive' as const } },
                    { instruction: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { id: true, title: true, whenToUse: true, body: true, version: true, folderId: true },
      orderBy: { confidence: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      whenToUse: r.whenToUse,
      version: r.version,
      hasProcedure: !!r.body,
      folder: pathOf(folders?.folders, r.folderId),
    }));
  }

  /**
   * The subfolders of a folder (or the top-level folders) that hold at least
   * one skill this caller can see, with counts, for skills_list.
   */
  async folderSummary(
    organizationId: string,
    serverId: string,
    connectorIds: string[],
    folders: FolderAccess | null | undefined,
    parentRef?: string,
  ): Promise<Array<{ path: string; description: string | null; skills: number }>> {
    const tree = folders?.folders ?? [];
    if (!tree.length) return [];
    const parent = parentRef?.trim() ? resolveFolder(tree, parentRef) : null;
    if (parentRef?.trim() && !parent) return [];
    const rows = await this.prisma.kgSkillSuggestion.findMany({
      where: { AND: [visibleWhere(organizationId, [serverId], connectorIds, folders), { folderId: { not: null } }] },
      select: { folderId: true },
    });
    return tree
      .filter((f) => f.parentId === (parent?.id ?? null))
      .map((f) => {
        const ids = subtreeIds(tree, f.id);
        return {
          path: f.path,
          description: f.description,
          skills: rows.filter((r) => r.folderId && ids.has(r.folderId)).length,
        };
      })
      .filter((f) => f.skills > 0);
  }

  /**
   * skill_get: one visible skill by id or exact title (case-insensitive).
   * Counts the use. Null when the caller cannot see it, the same answer as
   * for a skill that does not exist.
   */
  async getForCaller(
    organizationId: string,
    serverId: string,
    connectorIds: string[],
    ref: string,
    folders?: FolderAccess | null,
  ) {
    const key = (ref ?? '').trim();
    if (!key) return null;
    const skill = await this.prisma.kgSkillSuggestion.findFirst({
      where: {
        AND: [
          visibleWhere(organizationId, [serverId], connectorIds, folders),
          { OR: [{ id: key }, { title: { equals: key, mode: 'insensitive' as const } }] },
        ],
      },
      select: {
        id: true,
        title: true,
        whenToUse: true,
        instruction: true,
        body: true,
        version: true,
        updatedAt: true,
      },
    });
    if (!skill) return null;
    // Best effort: a failed counter must never fail the read.
    this.prisma.kgSkillSuggestion
      .update({
        where: { id: skill.id },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch((e: any) => this.logger.warn(`skill use count failed: ${e?.message ?? e}`));
    return skill;
  }

  /** Earlier versions of one skill, newest first. */
  async versions(organizationId: string, id: string, folders?: FolderAccess | null) {
    const skill = await this.owned(organizationId, id);
    // A skill in a folder the caller may not see answers like a missing one.
    if (skill.folderId && folders && !folders.all && !folders.ids.has(skill.folderId)) {
      throw new NotFoundException('Suggestion not found.');
    }
    return this.prisma.kgSkillVersion.findMany({
      where: { skillId: id, organizationId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        title: true,
        whenToUse: true,
        instruction: true,
        body: true,
        editedByUserId: true,
        createdAt: true,
      },
    });
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
      source?: SkillSource;
      body?: string | null;
      folderId?: string | null;
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
        source: body.source === 'finder' ? 'finder' : 'manual',
        body: normalizeBody(body.body),
        folderId: await this.ownFolder(organizationId, body.folderId),
      },
    });
  }

  /** A folder id of this workspace, or null; anything else is refused. */
  private async ownFolder(organizationId: string, folderId?: string | null): Promise<string | null> {
    if (!folderId) return null;
    const f = await this.prisma.knowledgeFolder.findFirst({
      where: { id: folderId, organizationId },
      select: { id: true },
    });
    if (!f) throw new NotFoundException('Folder not found.');
    return f.id;
  }

  private async owned(organizationId: string, id: string) {
    const s = await this.prisma.kgSkillSuggestion.findUnique({ where: { id } });
    if (!s || s.organizationId !== organizationId) throw new NotFoundException('Suggestion not found.');
    return s;
  }

  /**
   * Activate a skill. A consolidation proposal also dismisses the applied
   * skills it replaces (they stay, with their history, and can be activated
   * again).
   */
  async apply(organizationId: string, id: string) {
    const skill = await this.owned(organizationId, id);
    const replaces = Array.isArray(skill.replaces) ? (skill.replaces as string[]) : [];
    if (!replaces.length) {
      return this.prisma.kgSkillSuggestion.update({ where: { id }, data: { status: 'applied' } });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.kgSkillSuggestion.updateMany({
        where: { organizationId, id: { in: replaces }, status: 'applied' },
        data: { status: 'dismissed' },
      });
      return tx.kgSkillSuggestion.update({ where: { id }, data: { status: 'applied' } });
    });
  }

  async dismiss(organizationId: string, id: string) {
    await this.owned(organizationId, id);
    return this.prisma.kgSkillSuggestion.update({ where: { id }, data: { status: 'dismissed' } });
  }

  /**
   * Edit a skill. A change to its content (title, when, instruction, body)
   * keeps the previous content as a version and increments `version`; a
   * status-only change does not.
   */
  async update(
    organizationId: string,
    id: string,
    patch: {
      title?: string;
      whenToUse?: string;
      instruction?: string;
      body?: string | null;
      status?: string;
      folderId?: string | null;
    },
    editedByUserId?: string,
  ) {
    const current = await this.owned(organizationId, id);
    // Activating a merge proposal must also deactivate what it replaces.
    const replaces = Array.isArray(current.replaces) ? (current.replaces as string[]) : [];
    if (patch.status === 'applied' && current.status !== 'applied' && replaces.length) {
      const { status: _status, ...rest } = patch;
      if (Object.keys(rest).length) await this.update(organizationId, id, rest, editedByUserId);
      return this.apply(organizationId, id);
    }
    const data: Record<string, unknown> = {};
    if (typeof patch.title === 'string') data.title = patch.title.slice(0, 160);
    if (typeof patch.whenToUse === 'string') data.whenToUse = patch.whenToUse.slice(0, 1000);
    if (typeof patch.instruction === 'string') data.instruction = patch.instruction.slice(0, 2000);
    if (patch.body !== undefined) data.body = normalizeBody(patch.body);
    if (patch.status && ['pending', 'applied', 'dismissed'].includes(patch.status)) {
      data.status = patch.status;
    }
    // Filing a skill elsewhere is not a content change: no new version.
    if (patch.folderId !== undefined) {
      data.folderId = await this.ownFolder(organizationId, patch.folderId);
    }

    const changed = (['title', 'whenToUse', 'instruction', 'body'] as const).some(
      (k) => k in data && data[k] !== (current as any)[k],
    );
    if (!changed) {
      return this.prisma.kgSkillSuggestion.update({ where: { id }, data });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.kgSkillVersion.create({
        data: {
          skillId: id,
          organizationId,
          version: current.version,
          title: current.title,
          whenToUse: current.whenToUse,
          instruction: current.instruction,
          body: current.body,
          editedByUserId: editedByUserId ?? null,
        },
      });
      return tx.kgSkillSuggestion.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
    });
  }

  async remove(organizationId: string, id: string) {
    await this.owned(organizationId, id);
    await this.prisma.kgSkillSuggestion.delete({ where: { id } });
    return { ok: true };
  }
}

/** Trimmed, capped procedure; empty means none. */
function normalizeBody(body: string | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, SKILL_BODY_MAX) : null;
}

/** The skill text for a fixed-error pattern: names and formats only. */
export function errorFixSkill(
  toolName: string,
  p: FixPattern,
): { title: string; whenToUse: string; instruction: string } {
  const changed = p.changes
    .map((c) => (c.after === 'missing' ? `leave out \`${c.key}\`` : `\`${c.key}\` as ${c.after}`))
    .join(', ');
  const from = p.changes
    .map((c) => `\`${c.key}\` ${c.before === 'missing' ? 'missing' : `as ${c.before}`}`)
    .join(', ');
  // Only an error CODE, never the message: messages quote values (names,
  // ids, tokens) that would then be stored and served to every client.
  const error = errorCode(p.error);
  const patterned = p.changes.some((c) => c.before.startsWith('"') || c.after.startsWith('"'));
  return {
    title: `${toolName}: ${changed}`.slice(0, 160),
    whenToUse: `When calling ${toolName}`,
    instruction:
      `Send ${changed}. Calls with ${from} failed${error ? ` (${error})` : ''} and worked after ` +
      `this change (${p.occurrences} times, ${p.users} ${p.users === 1 ? 'person' : 'people'}).` +
      (patterned ? ' In the formats, 9 stands for a digit and a for a letter.' : ''),
  };
}

/**
 * A machine-readable error code from an error message, or null: an
 * upper-case code (`INVALID_INPUT`, `VALIDATION_ERROR`) or an HTTP status.
 */
export function errorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  const code = message.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  if (code) return code[0].slice(0, 40);
  const status = message.match(/\b([45]\d\d)\b/);
  return status ? `HTTP ${status[1]}` : null;
}
