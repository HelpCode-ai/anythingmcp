import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { KgStaticService } from '../../knowledge-graph/kg-static.service';
import { KgObservationalService } from '../../knowledge-graph/kg-observational.service';
import { KgLlmService } from '../../knowledge-graph/kg-llm.service';
import { KgSkillService } from '../../knowledge-graph/kg-skill.service';
import {
  resolveLlmConfig,
  submitBatch,
  getBatchResults,
  type BatchRequest,
} from '../../knowledge-graph/llm-client';

type LlmExtendResult = {
  llmOrgs: number;
  llmGraphSuggested: number;
  llmSkillsCreated: number;
  llmBatchSubmitted?: number;
};

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Cloud-only maintenance pass for the Knowledge Graph + audit log.
 *
 *  1. For a capped, staleness-ordered batch of orgs: refresh the static layer
 *     (incremental) and ingest new tool_invocations into the observational layer.
 *  2. Prune kg_value_seen rows past their TTL (hashes are short-lived).
 *  3. Retention: delete tool_invocations older than INVOCATION_RETENTION_DAYS —
 *     AFTER observational ingest, so the graph consumes rows before they're purged.
 *  4. Payload trim: rows older than INVOCATION_PAYLOAD_RETENTION_DAYS keep their
 *     metadata (status, timing, tool, org: what analytics count) but their large
 *     input/output is replaced by a short excerpt. Long since ingested by then.
 */
@Injectable()
export class KgCronService {
  private readonly logger = new Logger(KgCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kgStatic: KgStaticService,
    private readonly kgObservational: KgObservationalService,
    private readonly kgLlm: KgLlmService,
    private readonly kgSkill: KgSkillService,
  ) {}

  async run(): Promise<{
    orgsProcessed: number;
    orgsTotal: number;
    nodes: number;
    edges: number;
    invocations: number;
    prunedValueSeen: number;
    prunedInvocations: number;
    trimmedPayloads: number;
  }> {
    const maxOrgs = intEnv('KG_CRON_MAX_ORGS', 50);

    // Orgs that have at least one connector. Staleness-ordered: those whose KG
    // was observed longest ago (or never) come first.
    const states = await this.prisma.kgConnectorState.findMany({
      select: { organizationId: true, lastObservedAt: true },
    });
    const oldestByOrg = new Map<string, number>();
    for (const s of states) {
      const t = s.lastObservedAt ? s.lastObservedAt.getTime() : 0;
      const cur = oldestByOrg.get(s.organizationId);
      if (cur === undefined || t < cur) oldestByOrg.set(s.organizationId, t);
    }
    const allOrgs = (
      await this.prisma.connector.findMany({
        distinct: ['organizationId'],
        select: { organizationId: true },
      })
    ).map((c) => c.organizationId);

    const ordered = allOrgs.sort(
      (a, b) => (oldestByOrg.get(a) ?? 0) - (oldestByOrg.get(b) ?? 0),
    );
    const batch = ordered.slice(0, maxOrgs);

    let nodes = 0;
    let edges = 0;
    let invocations = 0;
    for (const orgId of batch) {
      try {
        const s = await this.kgStatic.syncOrganization(orgId);
        const o = await this.kgObservational.ingestOrganization(orgId);
        nodes += s.nodes;
        edges += s.edges;
        invocations += o.invocations;
      } catch (e: any) {
        this.logger.warn(`KG cron failed for org ${orgId}: ${e.message}`);
      }
    }

    if (ordered.length > batch.length) {
      this.logger.log(
        `KG cron processed ${batch.length}/${ordered.length} orgs this run (capped at ${maxOrgs}).`,
      );
    }

    // Optional AI pass: extend graph + skills from captured intents. Runs AFTER
    // the deterministic layers so the LLM sees the freshest structure.
    const llm = await this.runLlmExtend();

    const prunedValueSeen = await this.pruneValueSeen();
    const prunedInvocations = await this.retention();
    const trimmedPayloads = await this.trimOldPayloads();

    return {
      orgsProcessed: batch.length,
      orgsTotal: ordered.length,
      nodes,
      edges,
      invocations,
      ...llm,
      prunedValueSeen,
      prunedInvocations,
      trimmedPayloads,
    };
  }

  /**
   * Scheduled AI extension of the graph + skills, learned from the captured
   * user intents (the chat context passed on tool calls). Designed to be cheap
   * and bounded:
   *  - Global kill switch: KG_LLM_CRON_ENABLED must be 'true'.
   *  - Per-workspace opt-in: the `kg_llm_auto` flag (UI toggle, default off).
   *  - Per-org cooldown (KG_LLM_MIN_INTERVAL_HOURS, default 24h) so it runs
   *    "every so often" regardless of how frequently the cron fires.
   *  - Per-run org cap (KG_LLM_CRON_MAX_ORGS, default 20).
   *  - Only spends when there's something new: enrichment is content-hash cached
   *    (no-op on an unchanged graph), and skill generation is skipped unless new
   *    intents arrived since the last AI run.
   */
  private async runLlmExtend(): Promise<LlmExtendResult> {
    if (process.env.KG_LLM_CRON_ENABLED !== 'true') {
      return { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0 };
    }
    // Batch mode (Anthropic only): submit on one run, apply on a later run, at
    // ~50% of the synchronous price. Opt-in via KG_LLM_BATCH.
    if (process.env.KG_LLM_BATCH === 'true' && resolveLlmConfig()?.provider === 'anthropic') {
      return this.runLlmExtendBatch();
    }
    return this.runLlmExtendSync();
  }

  private async runLlmExtendSync(): Promise<LlmExtendResult> {
    const empty = { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0 };
    if (process.env.KG_LLM_CRON_ENABLED !== 'true') return empty;

    const maxOrgs = intEnv('KG_LLM_CRON_MAX_ORGS', 20);
    const cooldownMs = intEnv('KG_LLM_MIN_INTERVAL_HOURS', 24) * 60 * 60 * 1000;

    // Workspaces that opted into scheduled AI extension.
    const optedIn = await this.prisma.orgSettings.findMany({
      where: { key: 'kg_llm_auto', value: 'true' },
      select: { organizationId: true },
    });
    if (optedIn.length === 0) return empty;

    let llmOrgs = 0;
    let llmGraphSuggested = 0;
    let llmSkillsCreated = 0;

    for (const { organizationId } of optedIn) {
      if (llmOrgs >= maxOrgs) break;
      try {
        // Cooldown: skip if we ran for this org within the window.
        const last = await this.getLastRun(organizationId);
        if (last && Date.now() - last < cooldownMs) continue;
        // Requires global AI availability + per-org AI enrichment enabled.
        if (!(await this.kgLlm.isEnabled(organizationId))) continue;

        // Graph: enrichment is hash-cached → a no-op (no spend) if unchanged.
        const e = await this.kgLlm.enrich(organizationId, { force: false });
        llmGraphSuggested += e.suggested || 0;

        // Skills: only spend if new intents arrived since the last AI run.
        if (await this.hasNewIntentsSince(organizationId, last)) {
          const sk = await this.kgSkill.generate(organizationId);
          llmSkillsCreated += sk.created || 0;
        }

        await this.setLastRun(organizationId, Date.now());
        llmOrgs++;
      } catch (e: any) {
        this.logger.warn(`KG LLM cron failed for org ${organizationId}: ${e.message}`);
      }
    }

    if (llmOrgs > 0) {
      this.logger.log(
        `KG LLM cron: ${llmOrgs} org(s), +${llmGraphSuggested} graph suggestions, +${llmSkillsCreated} skills.`,
      );
    }
    return { llmOrgs, llmGraphSuggested, llmSkillsCreated };
  }

  /**
   * Batch variant (Anthropic, ~50% cost). Two-phase + deferred: each run either
   * APPLIES a previously-submitted batch that has completed, or SUBMITS a new
   * one for the opted-in orgs. Only one batch is in flight at a time. Same
   * gating/cost-control as the sync path (opt-in, cooldown, cap, hash/new-intent).
   */
  private async runLlmExtendBatch(): Promise<LlmExtendResult> {
    const cfg = resolveLlmConfig();
    if (!cfg) return { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0 };

    // ── APPLY phase ──
    const pending = await this.prisma.kgLlmBatch.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    if (pending) {
      let graph = 0;
      let skills = 0;
      const orgs = new Set<string>();
      try {
        const { done, results } = await getBatchResults(cfg, pending.externalId);
        if (!done) {
          return { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0, llmBatchSubmitted: 0 };
        }
        const ctx = (pending.context as Record<string, any>) || {};
        for (const { customId, json } of results) {
          const c = ctx[customId];
          if (!c) continue;
          try {
            if (c.type === 'enrich') {
              graph += await this.kgLlm.applyEnrichResult(c.organizationId, json, {
                idByRef: c.idByRef,
                hash: c.hash,
              });
            } else if (c.type === 'skill') {
              skills += await this.kgSkill.applyConnectorResult(c.organizationId, json);
            }
            orgs.add(c.organizationId);
          } catch (e: any) {
            this.logger.warn(`KG LLM batch apply failed (${customId}): ${e.message}`);
          }
        }
        await this.prisma.kgLlmBatch.delete({ where: { id: pending.id } });
        this.logger.log(
          `KG LLM batch applied: ${orgs.size} org(s), +${graph} graph, +${skills} skills.`,
        );
      } catch (e: any) {
        this.logger.warn(`KG LLM batch poll failed: ${e.message}`);
      }
      // One batch in flight at a time — don't submit a new one this run.
      return {
        llmOrgs: orgs.size,
        llmGraphSuggested: graph,
        llmSkillsCreated: skills,
        llmBatchSubmitted: 0,
      };
    }

    // ── SUBMIT phase ──
    const maxOrgs = intEnv('KG_LLM_CRON_MAX_ORGS', 20);
    const cooldownMs = intEnv('KG_LLM_MIN_INTERVAL_HOURS', 24) * 60 * 60 * 1000;
    const optedIn = await this.prisma.orgSettings.findMany({
      where: { key: 'kg_llm_auto', value: 'true' },
      select: { organizationId: true },
    });

    const requests: BatchRequest[] = [];
    const context: Record<string, any> = {};
    let orgsBuilt = 0;
    for (const { organizationId } of optedIn) {
      if (orgsBuilt >= maxOrgs) break;
      try {
        const last = await this.getLastRun(organizationId);
        if (last && Date.now() - last < cooldownMs) continue;
        if (!(await this.kgLlm.isEnabled(organizationId))) continue;

        let added = false;
        const enrichReq = await this.kgLlm.buildEnrichRequest(organizationId, { force: false });
        if (enrichReq && !('skipped' in enrichReq)) {
          const cid = `enrich:${organizationId}`;
          requests.push({ customId: cid, system: enrichReq.system, user: enrichReq.user });
          context[cid] = {
            type: 'enrich',
            organizationId,
            idByRef: enrichReq.idByRef,
            hash: enrichReq.hash,
          };
          added = true;
        }
        if (await this.hasNewIntentsSince(organizationId, last)) {
          const skillReq = await this.kgSkill.buildConnectorRequest(organizationId);
          if (skillReq) {
            const cid = `skill:${organizationId}`;
            requests.push({ customId: cid, system: skillReq.system, user: skillReq.user });
            context[cid] = { type: 'skill', organizationId };
            added = true;
          }
        }
        // Stamp the cooldown so the next run applies results, not re-submits.
        await this.setLastRun(organizationId, Date.now());
        if (added) orgsBuilt++;
      } catch (e: any) {
        this.logger.warn(`KG LLM batch build failed for org ${organizationId}: ${e.message}`);
      }
    }

    if (requests.length === 0) {
      return { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0, llmBatchSubmitted: 0 };
    }
    const externalId = await submitBatch(cfg, requests);
    await this.prisma.kgLlmBatch.create({
      data: { provider: cfg.provider, externalId, status: 'pending', context },
    });
    this.logger.log(
      `KG LLM batch submitted: ${requests.length} request(s) across ${orgsBuilt} org(s) (${externalId}).`,
    );
    return { llmOrgs: 0, llmGraphSuggested: 0, llmSkillsCreated: 0, llmBatchSubmitted: requests.length };
  }

  private async getLastRun(organizationId: string): Promise<number | null> {
    const row = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: 'kg_llm_auto_last' } },
      select: { value: true },
    });
    const t = row ? parseInt(row.value, 10) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  private async setLastRun(organizationId: string, ts: number): Promise<void> {
    const value = String(ts);
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key: 'kg_llm_auto_last' } },
      create: { organizationId, key: 'kg_llm_auto_last', value },
      update: { value },
    });
  }

  private async hasNewIntentsSince(
    organizationId: string,
    since: number | null,
  ): Promise<boolean> {
    const n = await this.prisma.toolInvocation.count({
      where: {
        organizationId,
        intent: { not: null },
        ...(since ? { createdAt: { gt: new Date(since) } } : {}),
      },
    });
    return n > 0;
  }

  /** Drop hashed identifier rows older than the TTL. */
  private async pruneValueSeen(): Promise<number> {
    const days = intEnv('KG_VALUE_TTL_DAYS', 30);
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.kgValueSeen.deleteMany({
      where: { seenAt: { lt: cutoff } },
    });
    return count;
  }

  /**
   * Replace the large payloads of old audit rows with a short excerpt, in
   * batches so the table is never locked for long. Up to TRIM_MAX_BATCHES
   * batches per run; the next run continues where this one stopped.
   */
  async trimOldPayloads(): Promise<number> {
    const days = intEnv('INVOCATION_PAYLOAD_RETENTION_DAYS', 14);
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const batchSize = intEnv('INVOCATION_TRIM_BATCH', 5000);
    const maxBatches = intEnv('INVOCATION_TRIM_MAX_BATCHES', 40);
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const updated = await this.prisma.$executeRaw`
        UPDATE tool_invocations AS t SET
          output = CASE WHEN pg_column_size(t.output) > 2048
            THEN jsonb_build_object('_amcp_truncated',
                   jsonb_build_object('originalBytes', octet_length(t.output::text), 'trimmed', 'age'),
                   'excerpt', left(t.output::text, 1000))
            ELSE t.output END,
          input = CASE WHEN pg_column_size(t.input) > 8192
            THEN jsonb_build_object('_amcp_truncated',
                   jsonb_build_object('originalBytes', octet_length(t.input::text), 'trimmed', 'age'),
                   'excerpt', left(t.input::text, 1000))
            ELSE t.input END
        WHERE t.id IN (
          SELECT id FROM tool_invocations
          WHERE created_at < ${cutoff}
            AND (pg_column_size(output) > 2048 OR pg_column_size(input) > 8192)
          LIMIT ${batchSize}
        )`;
      total += updated;
      if (updated < batchSize) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (total > 0) this.logger.log(`Payload trim: shortened ${total} tool_invocations older than ${days}d.`);
    return total;
  }

  /** Delete audit rows older than the retention window (cloud-only). */
  private async retention(): Promise<number> {
    const days = intEnv('INVOCATION_RETENTION_DAYS', 90);
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.toolInvocation.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Retention: pruned ${count} tool_invocations older than ${days}d.`);
    return count;
  }
}
