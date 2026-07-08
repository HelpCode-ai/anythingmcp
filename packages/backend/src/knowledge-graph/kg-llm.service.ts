import { createHash } from 'crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KgStaticService } from './kg-static.service';
import { chatJson, resolveLlmConfig } from './llm-client';

const MAX_ENTITIES = 120; // cost cap: never send more than this to the model

// Minimum confidence for an AI-suggested edge to be auto-applied (status 'active')
// when the workspace opts in. Mirrors the skill auto-apply bar (0.9). The LLM
// confidence is itself capped at 0.9, so only edges the model rates top-confidence
// qualify; everything else stays a suggestion for manual review.
export const EDGE_AUTO_APPLY_MIN = 0.9;

const SYSTEM_PROMPT = `You analyze a software workspace's data entities (drawn from connected SaaS/ERP systems) and infer relationships a naive name-matching heuristic misses.

You receive a JSON list of entities, each with a stable "ref", its connector, its name, its input field names ("fields") and the field names its tools RETURN ("outputs").

Return STRICT JSON: {"relationships":[{"from":"<ref>","to":"<ref>","kind":"same_identity"|"references","confidence":0..1,"reason":"<short>"}]}.

Rules:
- "same_identity": the two entities represent the SAME real-world thing across DIFFERENT connectors (e.g. a CRM "person", a billing "customer" and a support "user" are the same person). This is the most valuable output.
- "references": one entity points at another (a foreign-key-like link) that the field names alone don't make obvious.
- DATA FLOW is a strong signal: if a field one entity RETURNS (in "outputs") matches a key/id field another entity takes as INPUT ("fields"), that is usually a "references" link from the producer to the consumer.
- Only include links you are reasonably confident about. Prefer precision over recall. No self-links. Keep reasons under 12 words.
- Never invent refs that are not in the input.`;

/**
 * Optional LLM-assisted KG enrichment. Opt-in twice: a global env flag
 * (KG_LLM_ENABLED + an API key) AND a per-workspace switch (kg_llm_enabled,
 * default off, because it costs money). PII-safe: only entity + field NAMES are
 * sent to the model — never values. Results are stored as suggested LLM edges
 * for a human to confirm. Cached by a content hash so unchanged graphs don't
 * re-spend.
 */
@Injectable()
export class KgLlmService {
  private readonly logger = new Logger(KgLlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kgStatic: KgStaticService,
  ) {}

  /** Globally available (env flag + a configured API key). */
  globallyAvailable(): boolean {
    return process.env.KG_LLM_ENABLED === 'true' && !!resolveLlmConfig();
  }

  /** Enabled for this workspace (global + per-org switch + KG itself on). */
  async isEnabled(organizationId: string): Promise<boolean> {
    if (!this.globallyAvailable()) return false;
    if (!(await this.kgStatic.isEnabled(organizationId))) return false;
    return this.kgStatic.getFlag(organizationId, 'kg_llm_enabled', false);
  }

  async enrich(
    organizationId: string,
    opts?: { force?: boolean },
  ): Promise<{ suggested: number; skipped?: boolean; model?: string; usage?: any }> {
    if (!(await this.isEnabled(organizationId))) {
      throw new ConflictException('AI enrichment is disabled for this workspace.');
    }
    const cfg = resolveLlmConfig()!;
    const built = await this.buildEnrichRequest(organizationId, opts);
    if (!built) return { suggested: 0, model: cfg.model };
    if ('skipped' in built) return { suggested: 0, skipped: true, model: cfg.model };

    const { json, usage } = await chatJson(cfg, built.system, built.user);
    const suggested = await this.applyEnrichResult(organizationId, json, built);
    this.logger.log(
      `KG LLM enrich ${organizationId}: ${suggested} suggested (${cfg.model}, in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'})`,
    );
    return { suggested, model: cfg.model, usage };
  }

  /**
   * Pure prompt builder for enrichment — also usable for batch submission.
   * Returns the system/user prompts plus the ref→nodeId map and content hash
   * needed to apply the result later. `{ skipped: true }` when the graph is
   * unchanged since the last run; `null` when there's nothing to enrich.
   */
  async buildEnrichRequest(
    organizationId: string,
    opts?: { force?: boolean },
  ): Promise<
    | { system: string; user: string; idByRef: Record<string, string>; hash: string }
    | { skipped: true }
    | null
  > {
    const nodes = await this.prisma.kgNode.findMany({
      where: { organizationId },
      select: {
        id: true,
        entity: true,
        fields: true,
        outputFields: true,
        connector: { select: { name: true } },
      },
      orderBy: { entity: 'asc' },
      take: MAX_ENTITIES,
    });
    if (nodes.length < 2) return null;

    const catalog = nodes.map((n, i) => ({
      ref: `e${i}`,
      id: n.id,
      connector: n.connector?.name ?? '',
      entity: n.entity,
      fields: ((n.fields as Array<{ name: string }>) ?? []).slice(0, 12).map((f) => f.name),
      outputs: ((n.outputFields as string[]) ?? []).slice(0, 12),
    }));

    const hash = createHash('sha256')
      .update(
        JSON.stringify(
          catalog.map((c) => ({ c: c.connector, e: c.entity, f: c.fields, o: c.outputs })),
        ),
      )
      .digest('hex');
    const prev = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: 'kg_llm_hash' } },
      select: { value: true },
    });
    if (!opts?.force && prev?.value === hash) return { skipped: true };

    const user = JSON.stringify({
      entities: catalog.map((c) => ({
        ref: c.ref,
        connector: c.connector,
        entity: c.entity,
        fields: c.fields,
        outputs: c.outputs,
      })),
    });
    const idByRef: Record<string, string> = {};
    for (const c of catalog) idByRef[c.ref] = c.id;
    return { system: SYSTEM_PROMPT, user, idByRef, hash };
  }

  /** Apply an enrichment LLM result (sync or batch) and persist the content hash. */
  async applyEnrichResult(
    organizationId: string,
    json: any,
    ctx: { idByRef: Record<string, string>; hash: string },
  ): Promise<number> {
    const rels: any[] = Array.isArray(json?.relationships) ? json.relationships : [];
    // Read the per-workspace auto-apply switch once (no AI cost): when on,
    // high-confidence edges land as 'active' instead of 'suggested'.
    const autoApply = await this.kgStatic.getFlag(organizationId, 'kg_edge_auto_apply', false);
    let suggested = 0;
    for (const r of rels) {
      let src = ctx.idByRef[r?.from];
      let tgt = ctx.idByRef[r?.to];
      if (!src || !tgt || src === tgt) continue;
      const kind = r?.kind === 'same_identity' ? 'same_identity' : 'references';
      if (kind === 'same_identity' && src > tgt) [src, tgt] = [tgt, src];
      const confidence = Math.max(0, Math.min(0.9, Number(r?.confidence) || 0.5));
      const note = typeof r?.reason === 'string' ? r.reason.slice(0, 200) : null;
      try {
        if (await this.upsertLlmEdge(organizationId, src, tgt, kind, confidence, note, autoApply)) {
          suggested++;
        }
      } catch (e: any) {
        // A node may have been deleted between submit and apply (batch path).
        this.logger.warn(`KG LLM apply edge failed (${organizationId}): ${e.message}`);
      }
    }
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key: 'kg_llm_hash' } },
      create: { organizationId, key: 'kg_llm_hash', value: ctx.hash },
      update: { value: ctx.hash },
    });
    return suggested;
  }

  /** Create an LLM edge, or annotate an existing one without downgrading it. */
  private async upsertLlmEdge(
    organizationId: string,
    sourceNodeId: string,
    targetNodeId: string,
    kind: string,
    confidence: number,
    note: string | null,
    autoApply = false,
  ): Promise<boolean> {
    // High-confidence + opted in → apply directly; otherwise leave for review.
    const applied = autoApply && confidence >= EDGE_AUTO_APPLY_MIN;
    const existing = await this.prisma.kgEdge.findUnique({
      where: {
        organizationId_sourceNodeId_targetNodeId_kind: {
          organizationId,
          sourceNodeId,
          targetNodeId,
          kind,
        },
      },
      select: { id: true, isManual: true, status: true },
    });
    if (!existing) {
      await this.prisma.kgEdge.create({
        data: {
          organizationId,
          sourceNodeId,
          targetNodeId,
          kind,
          source: 'LLM',
          status: applied ? 'active' : 'suggested',
          confidence,
          note,
        },
      });
      return true;
    }
    // Don't touch a human-curated or rejected edge; just attach the rationale.
    if (existing.isManual || existing.status === 'rejected') return false;
    // Promote a still-pending suggestion to active when auto-apply qualifies.
    const promote = applied && existing.status === 'suggested';
    await this.prisma.kgEdge.update({
      where: { id: existing.id },
      data: {
        note: note ?? undefined,
        lastSeenAt: new Date(),
        ...(promote ? { status: 'active' } : {}),
      },
    });
    return promote;
  }
}
