import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { encrypt, decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { resolveLlmConfig } from '../knowledge-graph/llm-client';
import { FileSearchAccessService } from './file-search-access.service';
import { FileSearchPolicyService } from './file-search-policy.service';
import { FileSearchQueryService } from './file-search-query.service';
import { FileSearchRepository } from './file-search.repository';
import { FilesWorkerClient } from './files-worker.client';
import {
  FileSearchConfigError,
  displayAddress,
  localRootsFromEnv,
  parseFileSearchConfig,
  pickSecrets,
  trimSlashes,
  type FileSearchSecrets,
} from './file-search-config';
import { buildFileSearchBuiltinTools } from './file-search-builtins';
import { clampInterval, nextPlan, SYNC_INTERVALS } from './file-search-quotas';
import { applySelection, checkQuota, estimate, selectionOf, type CompactListing, type Selection } from './file-search-selection';
import { CLOUD_PROTOCOLS, FILE_SEARCH_PROTOCOLS, isPausedState, type FileSearchConfig } from './file-search.types';

/**
 * The setup wizard and the Files tab (#1385). Orchestration only: tests,
 * scans, syncs and descriptions run in files-worker; this service writes the
 * requests and reads the results.
 */

interface Actor {
  sub: string;
  organizationId: string;
  role: string;
}

const TEST_WINDOW_MS = 10 * 60_000;
const TEST_MAX = 10;

@Injectable()
export class FileSearchService {
  private readonly logger = new Logger(FileSearchService.name);
  private readonly encryptionKey: string;
  private readonly testCalls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly repo: FileSearchRepository,
    private readonly access: FileSearchAccessService,
    private readonly policy: FileSearchPolicyService,
    private readonly query: FileSearchQueryService,
    private readonly worker: FilesWorkerClient,
    private readonly mcpServer: McpServerService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY);
  }

  private get cloud(): boolean {
    return this.deployment.isCloud();
  }

  private assertAdmin(actor: Actor): void {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Only workspace administrators can set up File Search connectors.');
    }
  }

  private parse(raw: unknown, name?: string): FileSearchConfig {
    try {
      return parseFileSearchConfig(raw, { cloud: this.cloud, localRoots: localRootsFromEnv(), connectorName: name });
    } catch (err) {
      if (err instanceof FileSearchConfigError) {
        throw new BadRequestException({ statusCode: 400, code: 'invalid_config', field: err.field, message: err.message });
      }
      throw err;
    }
  }

  /** Everything the wizard needs before step 1. */
  async capabilities(actor: Actor) {
    // Fresh on every wizard load: a trial started or a key activated a moment ago counts.
    this.access.invalidate(actor.organizationId);
    const [access, health, policy] = await Promise.all([
      this.access.resolve(actor.organizationId),
      this.worker.health(),
      this.policy.get(actor.organizationId),
    ]);
    const usage = await this.usage(actor.organizationId);
    return {
      cloud: this.cloud,
      worker: health,
      access: access.allowed
        ? { allowed: true, plan: access.plan, quota: access.quota, trialEndsAt: access.trialEndsAt, next: nextPlan(access.plan, this.cloud) }
        : { allowed: false, reason: access.reason, message: access.message, trialAvailable: access.trialAvailable, keyRequired: access.keyRequired },
      protocols: FILE_SEARCH_PROTOCOLS.filter((p) => !this.cloud || CLOUD_PROTOCOLS.has(p)),
      localRoots: this.cloud ? [] : localRootsFromEnv(),
      ai: { available: !!(process.env.KG_LLM_ENABLED === 'true' && resolveLlmConfig()), allowedByPolicy: policy.aiDrafting, provider: resolveLlmConfig()?.provider ?? null, model: resolveLlmConfig()?.model ?? null },
      policy,
      intervals: SYNC_INTERVALS,
      usage,
    };
  }

  /** Files and connectors used across the workspace (quota is per workspace). */
  async usage(organizationId: string, exceptConnectorId?: string) {
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId, type: 'FILE_SEARCH' as any },
      select: { id: true, config: true, isActive: true },
    });
    const sources = connectors.filter((c) => !(c.config as any)?.fileShare);
    const agg = await this.repo.withTenant(organizationId, (tx) =>
      tx.fileEntry.aggregate({
        where: { organizationId, ...(exceptConnectorId ? { connectorId: { not: exceptConnectorId } } : {}) },
        _count: true,
        _sum: { size: true, textChars: true },
      }),
    );
    return {
      connectors: sources.length,
      files: agg._count,
      bytes: Number(agg._sum.size ?? 0),
      textChars: agg._sum.textChars ?? 0,
    };
  }

  private rateLimitTest(userId: string): void {
    const now = Date.now();
    const calls = (this.testCalls.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
    if (calls.length >= TEST_MAX) {
      throw new HttpException('Too many connection tests. Wait a few minutes and try again.', 429);
    }
    calls.push(now);
    this.testCalls.set(userId, calls);
  }

  /** Wizard step 2, before anything is saved. */
  async test(actor: Actor, body: { config: unknown; secrets?: unknown; connectorId?: string }) {
    this.assertAdmin(actor);
    await this.access.assertAllowed(actor.organizationId);
    this.rateLimitTest(actor.sub);
    let secrets = pickSecrets(body.secrets);
    if (body.connectorId) {
      // Re-test of a saved connector: fill in secrets the form left empty.
      const c = await this.loadConnector(actor, body.connectorId);
      secrets = { ...this.secretsOf(c.authConfig), ...secrets };
    }
    const config = this.parse(body.config);
    const policy = await this.policy.get(actor.organizationId);
    const a = await this.access.resolve(actor.organizationId);
    if (config.protocol === 'ftp' && a.allowed && a.quota.policy && !policy.allowPlainFtp) {
      return { ok: false, steps: [], errorKind: 'protocol_not_allowed', message: 'Plain FTP is switched off by your workspace policy. Use FTPS or SFTP.' };
    }
    return this.worker.test(config, secrets, { cloud: this.cloud });
  }

  private secretsOf(authConfig: string | null): FileSearchSecrets {
    if (!authConfig) return {};
    try {
      return pickSecrets(JSON.parse(decrypt(authConfig, this.encryptionKey)));
    } catch {
      return {};
    }
  }

  private async loadConnector(actor: Actor, id: string) {
    const c = await this.prisma.connector.findFirst({ where: { id, organizationId: actor.organizationId, type: 'FILE_SEARCH' as any } });
    if (!c) throw new NotFoundException('File Search connector not found.');
    return c;
  }

  /** Saves a tested connector as a draft: no tools, no schedule, not on any server. */
  async createDraft(actor: Actor, body: { name: string; config: unknown; secrets?: unknown }) {
    this.assertAdmin(actor);
    const a = await this.access.assertAllowed(actor.organizationId);
    const name = (body.name ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('Give the connector a name.');
    const config = this.parse(body.config, name);
    if (config.protocol === 'sftp' && !config.hostKeySha256) {
      throw new BadRequestException({ statusCode: 400, code: 'fingerprint_unconfirmed', message: 'Test the connection and confirm the server fingerprint first.' });
    }
    const usage = await this.usage(actor.organizationId);
    if (a.quota.maxConnectors != null && usage.connectors >= a.quota.maxConnectors) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'file_quota',
        limit: 'connectors',
        max: a.quota.maxConnectors,
        next: nextPlan(a.plan, this.cloud),
        message: `Your plan includes ${a.quota.maxConnectors} File Search connector${a.quota.maxConnectors === 1 ? '' : 's'}. Upgrade to add more.`,
      });
    }
    // Drafts nobody finished: older than 7 days are removed by the worker.
    const secrets = pickSecrets(body.secrets);
    const connector = await this.prisma.connector.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        name,
        type: 'FILE_SEARCH' as any,
        baseUrl: displayAddress(config),
        isActive: false,
        authType: Object.keys(secrets).length ? 'BASIC_AUTH' : 'NONE',
        authConfig: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets), this.encryptionKey) : null,
        config: { fileSearch: config } as any,
      },
    });
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.create({ data: { connectorId: connector.id, organizationId: actor.organizationId, setupState: 'draft' } }),
    );
    this.logger.log(`File Search draft ${connector.id} (${config.protocol}) created in org ${actor.organizationId}`);
    return { id: connector.id, name, config };
  }

  /** Changes the source settings (wizard Back, or Edit on the connector page). */
  async updateSource(actor: Actor, id: string, body: { name?: string; config?: unknown; secrets?: unknown }) {
    this.assertAdmin(actor);
    const c = await this.loadConnector(actor, id);
    const current = (c.config as any)?.fileSearch;
    const config = this.parse({ ...current, ...(body.config as object) }, body.name ?? c.name);
    const secrets = { ...this.secretsOf(c.authConfig), ...pickSecrets(body.secrets) };
    await this.prisma.connector.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name.trim().slice(0, 120) } : {}),
        baseUrl: displayAddress(config),
        config: { ...(c.config as object), fileSearch: config } as any,
        authType: Object.keys(secrets).length ? 'BASIC_AUTH' : 'NONE',
        authConfig: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets), this.encryptionKey) : null,
      },
    });
    return { id, config };
  }

  /** Wizard step 3: queue a scan (dry run) in the worker. */
  async startScan(actor: Actor, id: string, body: { useAi?: boolean }) {
    this.assertAdmin(actor);
    await this.access.assertAllowed(actor.organizationId);
    await this.loadConnector(actor, id);
    const running = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.findFirst({ where: { connectorId: id, organizationId: actor.organizationId, status: { in: ['queued', 'running'] } } }),
    );
    if (running) return { id: running.id, status: running.status };
    const useAi = await this.aiAllowed(actor.organizationId, body.useAi === true);
    const scan = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.create({
        data: { organizationId: actor.organizationId, connectorId: id, status: 'queued', createdByUserId: actor.sub, progress: { useAi } as any },
      }),
    );
    await this.worker.kick(id);
    return { id: scan.id, status: scan.status };
  }

  private async aiAllowed(organizationId: string, requested: boolean): Promise<boolean> {
    if (!requested) return false;
    if (process.env.KG_LLM_ENABLED !== 'true' || !resolveLlmConfig()) return false;
    const p = await this.policy.get(organizationId);
    return p.aiDrafting;
  }

  async cancelScan(actor: Actor, id: string, scanId: string) {
    this.assertAdmin(actor);
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.updateMany({ where: { id: scanId, connectorId: id, organizationId: actor.organizationId, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', finishedAt: new Date() } }),
    );
    return { ok: true };
  }

  /** A scan with the budget for the connector's current selection. */
  async getScan(actor: Actor, id: string, scanId: string) {
    const c = await this.loadConnector(actor, id);
    const scan = await this.repo.withTenant(actor.organizationId, (tx) => tx.fileScan.findFirst({ where: { id: scanId, connectorId: id, organizationId: actor.organizationId } }));
    if (!scan) throw new NotFoundException('Scan not found.');
    const config = (c.config as any).fileSearch as FileSearchConfig;
    const tree = scan.tree as { root?: unknown; listing?: CompactListing } | null;
    const budget = tree?.listing ? await this.budget(actor.organizationId, id, tree.listing, config) : null;
    return {
      id: scan.id,
      status: scan.status,
      progress: scan.progress,
      error: scan.error,
      truncated: scan.truncated,
      tree: tree?.root ?? null,
      types: scan.types,
      totals: scan.totals,
      suggestions: scan.suggestions,
      description: scan.description,
      samples: Array.isArray(scan.samples) ? (scan.samples as Array<{ path: string }>).map((s) => s.path) : [],
      selection: selectionOf(config),
      budget,
      createdAt: scan.createdAt.toISOString(),
      finishedAt: scan.finishedAt?.toISOString() ?? null,
    };
  }

  private async budget(organizationId: string, connectorId: string, listing: CompactListing, config: FileSearchConfig) {
    const a = await this.access.resolve(organizationId);
    if (!a.allowed) return null;
    const e = estimate(listing, config, a.quota.maxFileBytes);
    const others = await this.usage(organizationId, connectorId);
    const q = checkQuota(e, a.quota.maxFiles, a.quota.maxSourceBytes, { files: others.files, bytes: others.bytes });
    return {
      ...e,
      maxFiles: a.quota.maxFiles,
      maxBytes: a.quota.maxSourceBytes,
      maxFileBytes: a.quota.maxFileBytes,
      usedByOtherConnectors: { files: others.files, bytes: others.bytes },
      fits: q.fits,
      over: q.over,
      plan: a.plan,
      next: q.fits ? null : nextPlan(a.plan, this.cloud),
    };
  }

  /** Wizard step 3: the admin ticks folders, types, age; returns the new budget. */
  async setSelection(actor: Actor, id: string, sel: Selection & { scanId?: string }) {
    this.assertAdmin(actor);
    const c = await this.loadConnector(actor, id);
    const config = applySelection((c.config as any).fileSearch as FileSearchConfig, {
      excludeFolders: Array.isArray(sel.excludeFolders) ? sel.excludeFolders.filter((f) => typeof f === 'string') : [],
      extensions: Array.isArray(sel.extensions) ? sel.extensions.filter((e) => typeof e === 'string') : undefined,
      maxAgeYears: typeof sel.maxAgeYears === 'number' ? sel.maxAgeYears : undefined,
    });
    const parsed = this.parse(config, c.name);
    await this.prisma.connector.update({ where: { id }, data: { config: { ...(c.config as object), fileSearch: parsed } as any } });
    let budget = null;
    const scan = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.findFirst({ where: { connectorId: id, organizationId: actor.organizationId, status: 'done', ...(sel.scanId ? { id: sel.scanId } : {}) }, orderBy: { createdAt: 'desc' } }),
    );
    const listing = (scan?.tree as { listing?: CompactListing } | null)?.listing;
    if (listing) budget = await this.budget(actor.organizationId, id, listing, parsed);
    // Selection changed on an active connector: a paused sync may fit now.
    const src = await this.repo.withTenant(actor.organizationId, (tx) => tx.fileSource.findUnique({ where: { connectorId: id } }));
    if (src && src.setupState === 'paused_quota') {
      await this.repo.withTenant(actor.organizationId, (tx) => tx.fileSource.update({ where: { connectorId: id }, data: { nextSyncAt: new Date() } }));
      await this.worker.kick(id);
    }
    return { selection: selectionOf(parsed), budget };
  }

  /** Regenerate the description of a finished scan (AI on/off). */
  async redescribe(actor: Actor, id: string, scanId: string, body: { useAi?: boolean }) {
    this.assertAdmin(actor);
    const useAi = await this.aiAllowed(actor.organizationId, body.useAi === true);
    const n = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.updateMany({
        where: { id: scanId, connectorId: id, organizationId: actor.organizationId, status: 'done' },
        data: { status: 'describing', description: undefined, progress: { useAi, phase: 'describing' } as any },
      }),
    );
    if (!n.count) throw new NotFoundException('Scan not found or not finished.');
    await this.worker.kick(id);
    return { id: scanId, status: 'describing' };
  }

  /** Wizard step 5: tools, servers, schedule; the first sync starts. */
  async activate(
    actor: Actor,
    id: string,
    body: { instructions?: string; summary?: string; toolPrefix?: string; syncIntervalMinutes?: number; mcpServerIds?: string[] },
  ) {
    this.assertAdmin(actor);
    const a = await this.access.assertAllowed(actor.organizationId);
    const c = await this.loadConnector(actor, id);
    let config = (c.config as any).fileSearch as FileSearchConfig;
    if (body.toolPrefix && /^[a-z][a-z0-9_]{1,30}$/.test(body.toolPrefix)) config = { ...config, toolPrefix: body.toolPrefix };

    const scan = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileScan.findFirst({ where: { connectorId: id, organizationId: actor.organizationId, status: 'done' }, orderBy: { createdAt: 'desc' } }),
    );
    const listing = (scan?.tree as { listing?: CompactListing } | null)?.listing;
    if (!listing) throw new ConflictException('Scan the folder before activating.');
    const budget = await this.budget(actor.organizationId, id, listing, config);
    if (budget && !budget.fits) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'file_quota',
        over: budget.over,
        next: budget.next,
        message: 'The selection is larger than your plan. Untick folders or file types, or upgrade.',
      });
    }

    const summary = (body.summary ?? '').trim().slice(0, 300) || null;
    const instructions = (body.instructions ?? '').trim().slice(0, 20_000) || null;
    const interval = clampInterval(body.syncIntervalMinutes, a.quota);

    // Tools: replace any earlier set (re-activation after Edit).
    await this.prisma.mcpTool.deleteMany({ where: { connectorId: id } });
    for (const tool of buildFileSearchBuiltinTools({ prefix: config.toolPrefix, displayName: c.name, summary })) {
      try {
        await this.prisma.mcpTool.create({
          data: {
            connectorId: id,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            isEnabled: tool.enabled !== false,
          },
        });
      } catch (err: any) {
        if (err.code !== 'P2002') throw err;
        throw new ConflictException(`A tool named ${tool.name} already exists in this workspace. Choose another tool prefix.`);
      }
    }
    await this.prisma.connector.update({
      where: { id },
      data: { isActive: true, instructions, config: { ...(c.config as object), fileSearch: config } as any },
    });
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.upsert({
        where: { connectorId: id },
        create: { connectorId: id, organizationId: actor.organizationId, setupState: 'active', summary, syncIntervalMinutes: interval, nextSyncAt: new Date() },
        update: { setupState: 'active', summary, syncIntervalMinutes: interval, nextSyncAt: new Date(), pausedAt: null, pausedReason: null },
      }),
    );
    const servers = Array.isArray(body.mcpServerIds) ? body.mcpServerIds.filter((s) => typeof s === 'string').slice(0, 50) : [];
    if (servers.length) {
      const owned = await this.prisma.mcpServerConfig.findMany({ where: { id: { in: servers }, organizationId: actor.organizationId }, select: { id: true } });
      for (const s of owned) {
        await this.prisma.mcpServerConnector.upsert({
          where: { mcpServerId_connectorId: { mcpServerId: s.id, connectorId: id } },
          create: { mcpServerId: s.id, connectorId: id },
          update: {},
        });
      }
    }
    await this.mcpServer.reloadConnectorTools(id);
    await this.worker.kick(id);
    this.logger.log(`File Search connector ${id} activated (interval ${interval} min)`);
    return { id, state: 'active', syncIntervalMinutes: interval };
  }

  /** Overview for the Files tab. */
  async overview(actor: Actor, id: string) {
    const c = await this.loadConnector(actor, id);
    const scope = { organizationId: actor.organizationId, connectorId: id };
    const [status, access, lastScan, usage] = await Promise.all([
      this.query.status(scope),
      this.access.resolve(actor.organizationId),
      this.repo.withTenant(actor.organizationId, (tx) =>
        tx.fileScan.findFirst({ where: { connectorId: id, organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, createdAt: true } }),
      ),
      this.usage(actor.organizationId),
    ]);
    const src = await this.repo.withTenant(actor.organizationId, (tx) => tx.fileSource.findUnique({ where: { connectorId: id } }));
    const config = (c.config as any).fileSearch as FileSearchConfig;
    return {
      connector: { id: c.id, name: c.name, isActive: c.isActive, instructions: c.instructions, address: c.baseUrl },
      config: { ...config },
      hasSecrets: !!c.authConfig,
      status,
      instructionsDraft: src?.instructionsDraft ?? null,
      manualSyncsToday: src?.manualSyncDay === new Date().toISOString().slice(0, 10) ? src.manualSyncCount : 0,
      lastScan: lastScan ? { id: lastScan.id, status: lastScan.status, createdAt: lastScan.createdAt.toISOString() } : null,
      access: access.allowed
        ? { allowed: true, plan: access.plan, quota: access.quota, next: nextPlan(access.plan, this.cloud) }
        : { allowed: false, reason: access.reason, message: access.message, trialAvailable: access.trialAvailable, keyRequired: access.keyRequired },
      usage,
    };
  }

  async tree(actor: Actor, id: string) {
    await this.loadConnector(actor, id);
    return this.query.tree({ organizationId: actor.organizationId, connectorId: id }, 4);
  }

  async problems(actor: Actor, id: string, page?: { page?: number; pageSize?: number }) {
    await this.loadConnector(actor, id);
    return this.query.problems({ organizationId: actor.organizationId, connectorId: id }, page);
  }

  /** "Sync now": rate-limited per plan, the worker picks it up within seconds. */
  async syncNow(actor: Actor, id: string) {
    if (actor.role === 'VIEWER') throw new ForbiddenException('Viewers cannot start a sync.');
    const a = await this.access.assertAllowed(actor.organizationId);
    await this.loadConnector(actor, id);
    const today = new Date().toISOString().slice(0, 10);
    const src = await this.repo.withTenant(actor.organizationId, (tx) => tx.fileSource.findUnique({ where: { connectorId: id } }));
    if (!src || src.setupState === 'draft') throw new ConflictException('Finish the setup first.');
    if (src.setupState === 'syncing') return { ok: true, state: 'syncing' };
    const used = src.manualSyncDay === today ? src.manualSyncCount : 0;
    if (a.quota.manualSyncsPerDay != null && used >= a.quota.manualSyncsPerDay) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'file_quota',
        limit: 'manual_syncs',
        max: a.quota.manualSyncsPerDay,
        next: nextPlan(a.plan, this.cloud),
        message: `Your plan includes ${a.quota.manualSyncsPerDay} manual sync${a.quota.manualSyncsPerDay === 1 ? '' : 's'} per day. The automatic sync runs as scheduled.`,
      });
    }
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.update({
        where: { connectorId: id },
        data: {
          nextSyncAt: new Date(),
          manualSyncDay: today,
          manualSyncCount: used + 1,
          ...(isPausedState(src.setupState) && src.setupState !== 'paused_licence' ? { setupState: 'active', pausedAt: null, pausedReason: null } : {}),
        },
      }),
    );
    await this.worker.kick(id);
    return { ok: true, state: 'queued', manualSyncsToday: used + 1 };
  }

  async pause(actor: Actor, id: string) {
    this.assertAdmin(actor);
    await this.loadConnector(actor, id);
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.update({ where: { connectorId: id }, data: { setupState: 'paused_admin', pausedAt: new Date(), pausedReason: 'Paused by an administrator.' } }),
    );
    return { ok: true };
  }

  /** Resume: rechecks quota and licence on the next tick. */
  async resume(actor: Actor, id: string) {
    this.assertAdmin(actor);
    await this.access.assertAllowed(actor.organizationId);
    await this.loadConnector(actor, id);
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.update({ where: { connectorId: id }, data: { setupState: 'active', pausedAt: null, pausedReason: null, nextSyncAt: new Date() } }),
    );
    await this.worker.kick(id);
    return { ok: true };
  }

  async setSchedule(actor: Actor, id: string, body: { syncIntervalMinutes?: number }) {
    this.assertAdmin(actor);
    const a = await this.access.assertAllowed(actor.organizationId);
    await this.loadConnector(actor, id);
    const interval = clampInterval(body.syncIntervalMinutes, a.quota);
    await this.repo.withTenant(actor.organizationId, (tx) => tx.fileSource.update({ where: { connectorId: id }, data: { syncIntervalMinutes: interval } }));
    return { syncIntervalMinutes: interval };
  }

  /**
   * Saves the description (instructions + one-line summary) and refreshes the
   * tool descriptions. Built-in tools added in a later release (view_page) are
   * created here too, so saving the description brings an older connector up
   * to date without activating it again.
   */
  async setDescription(actor: Actor, id: string, body: { instructions?: string; summary?: string }) {
    this.assertAdmin(actor);
    const c = await this.loadConnector(actor, id);
    const summary = (body.summary ?? '').trim().slice(0, 300) || null;
    const instructions = (body.instructions ?? '').trim().slice(0, 20_000) || null;
    await this.prisma.connector.update({ where: { id }, data: { instructions } });
    await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSource.update({ where: { connectorId: id }, data: { summary, instructionsDraft: null } }),
    );
    const config = (c.config as any).fileSearch as FileSearchConfig;
    for (const t of buildFileSearchBuiltinTools({ prefix: config.toolPrefix, displayName: c.name, summary })) {
      const updated = await this.prisma.mcpTool.updateMany({ where: { connectorId: id, name: t.name }, data: { description: t.description, ...(t.endpointMapping.method === 'static' ? { endpointMapping: t.endpointMapping as any } : {}) } });
      if (updated.count === 0) {
        await this.prisma.mcpTool.create({
          data: { connectorId: id, name: t.name, description: t.description, parameters: t.parameters as any, endpointMapping: t.endpointMapping as any, isEnabled: t.enabled !== false },
        });
      }
    }
    if (c.isActive) await this.mcpServer.reloadConnectorTools(id);
    return { ok: true };
  }

  async getPolicy(actor: Actor) {
    const a = await this.access.resolve(actor.organizationId);
    return { policy: await this.policy.get(actor.organizationId), editable: a.allowed && a.quota.policy };
  }

  async setPolicy(actor: Actor, body: Record<string, unknown>) {
    this.assertAdmin(actor);
    const a = await this.access.assertAllowed(actor.organizationId);
    if (!a.quota.policy) {
      throw new ForbiddenException({ statusCode: 403, code: 'edition_required', message: 'Workspace policies for File Search are available with AnythingMCP Enterprise.' });
    }
    return { policy: await this.policy.set(actor.organizationId, body as any) };
  }

  async getAccessRules(actor: Actor, id: string) {
    await this.loadConnector(actor, id);
    const a = await this.access.resolve(actor.organizationId);
    const rules = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileAccessRule.findMany({ where: { connectorId: id, organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } }),
    );
    const roles = await this.prisma.role.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, name: true } });
    return { editable: a.allowed && a.quota.folderRules, roles, rules: rules.map((r) => ({ id: r.id, roleId: r.roleId, pattern: r.pattern, effect: r.effect })) };
  }

  async setAccessRules(actor: Actor, id: string, body: { rules?: Array<{ roleId: string; pattern: string; effect: string }> }) {
    this.assertAdmin(actor);
    const a = await this.access.assertAllowed(actor.organizationId);
    if (!a.quota.folderRules) {
      throw new ForbiddenException({ statusCode: 403, code: 'edition_required', message: 'Folder permissions by role are available with AnythingMCP Enterprise.' });
    }
    await this.loadConnector(actor, id);
    const roleIds = new Set((await this.prisma.role.findMany({ where: { organizationId: actor.organizationId }, select: { id: true } })).map((r) => r.id));
    const rules = (body.rules ?? [])
      .filter((r) => r && roleIds.has(r.roleId) && typeof r.pattern === 'string' && r.pattern.trim())
      .slice(0, 500)
      .map((r) => ({
        organizationId: actor.organizationId,
        connectorId: id,
        roleId: r.roleId,
        pattern: trimSlashes(r.pattern.trim().slice(0, 1024)).replace(/\/\*\*$/, '').slice(0, 512),
        effect: r.effect === 'deny' ? 'deny' : 'allow',
      }));
    await this.repo.withTenant(actor.organizationId, async (tx) => {
      await tx.fileAccessRule.deleteMany({ where: { connectorId: id, organizationId: actor.organizationId } });
      if (rules.length) await tx.fileAccessRule.createMany({ data: rules });
    });
    return this.getAccessRules(actor, id);
  }

  /** Runs of the connector, newest first. */
  async runs(actor: Actor, id: string) {
    await this.loadConnector(actor, id);
    const rows = await this.repo.withTenant(actor.organizationId, (tx) =>
      tx.fileSyncRun.findMany({ where: { connectorId: id, organizationId: actor.organizationId }, orderBy: { startedAt: 'desc' }, take: 30 }),
    );
    return rows.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, counters: r.counters, error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null }));
  }
}
