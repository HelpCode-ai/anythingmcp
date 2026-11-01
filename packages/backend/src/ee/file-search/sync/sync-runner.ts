// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma.service';
import { FileSearchRepository } from '../../../file-search/file-search.repository';
import { FileSearchAccessService } from '../../../file-search/file-search-access.service';
import { buildFilter, checkQuota } from '../../../file-search/file-search-selection';
import { nextPlan } from '../../../file-search/file-search-quotas';
import { TEXT_EXTENSIONS, extOf, type FileSearchConfig } from '../../../file-search/file-search.types';
import { ExtractorClient, ExtractorUnavailableError } from '../extractor.client';
import { isCloud, openSource, type ConnectorRow } from '../source-context';
import type { SourceSession } from '../sources/source.types';
import { readAll, walk } from './walk';
import { PauseNotifier } from './notifier';

/**
 * One sync of one source (#1383).
 *
 *   1. Licence check → paused_licence.
 *   2. Walk with the connector's selection; compare (size, mtime, etag) with
 *      the index: new, changed, unchanged, gone.
 *   3. Quota check on the whole selection BEFORE downloading anything: over
 *      the plan → paused_quota, the index stays as it was.
 *   4. Remove what is gone; queue new and changed files.
 *   5. Process the queue in slices (25 files or 3 minutes): download, skip
 *      identical content by SHA-256, extract, replace the chunks. Then hand
 *      the lease back so other workspaces get their turn; the next run
 *      continues the queue without walking again.
 */

export const MAX_ATTEMPTS = 3;
const SLICE_FILES = 25;
const SLICE_MS = 3 * 60_000;
const WALK_MS = 15 * 60_000;
const MAX_ENTRIES = 200_000;
const CHUNK_MAX = 8_000;

export interface RunOutcome {
  status: 'succeeded' | 'partial' | 'paused' | 'failed' | 'skipped';
  /** More files are queued: run again soon. */
  more: boolean;
}

interface Counters {
  listed: number;
  new: number;
  changed: number;
  unchanged: number;
  deleted: number;
  extracted: number;
  identical: number;
  failed: number;
  skippedSize: number;
  nameOnly: number;
  bytes: number;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Splits extracted pages into chunks small enough for good snippets. */
export function toChunks(pages: Array<{ page: number | null; text: string }>): Array<{ page: number | null; content: string }> {
  const out: Array<{ page: number | null; content: string }> = [];
  for (const p of pages) {
    const text = (p.text ?? '').split('\u0000').join('').trim();
    if (!text) continue;
    if (text.length <= CHUNK_MAX) {
      out.push({ page: p.page, content: text });
      continue;
    }
    let rest = text;
    while (rest.length > CHUNK_MAX) {
      let cut = rest.lastIndexOf('\n', CHUNK_MAX);
      if (cut < CHUNK_MAX / 2) cut = rest.lastIndexOf(' ', CHUNK_MAX);
      if (cut < CHUNK_MAX / 2) cut = CHUNK_MAX;
      out.push({ page: p.page, content: rest.slice(0, cut).trim() });
      rest = rest.slice(cut);
    }
    if (rest.trim()) out.push({ page: p.page, content: rest.trim() });
  }
  return out;
}

export class SyncRunner {
  private readonly logger = new Logger(SyncRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly access: FileSearchAccessService,
    private readonly extractor: ExtractorClient,
    private readonly notifier: PauseNotifier,
    private readonly backPressure: () => Promise<void>,
    private readonly workerId: string,
  ) {}

  async run(connectorId: string, trigger: string): Promise<RunOutcome> {
    const connector = (await this.prisma.connector.findUnique({ where: { id: connectorId } })) as (ConnectorRow & { type: string }) | null;
    if (!connector || !connector.isActive) return { status: 'skipped', more: false };
    const orgId = connector.organizationId;
    const source = await this.repo.withTenant(orgId, (tx) => tx.fileSource.findUnique({ where: { connectorId } }));
    if (!source || source.setupState === 'draft' || source.setupState === 'paused_admin') return { status: 'skipped', more: false };

    // 1. Licence
    this.access.invalidate(orgId);
    const access = await this.access.resolve(orgId);
    if (!access.allowed) {
      await this.pause(orgId, connectorId, 'paused_licence', `${access.message}`, connector.name, null);
      return { status: 'paused', more: false };
    }
    const quota = access.quota;
    if (source.setupState === 'paused_licence') {
      await this.repo.withTenant(orgId, (tx) => tx.fileSource.update({ where: { connectorId }, data: { setupState: 'active', pausedAt: null, pausedReason: null, pauseNotifiedAt: null } }));
    }

    const stats = (source.stats as Record<string, any>) ?? {};
    const pendingCount = await this.repo.withTenant(orgId, (tx) => tx.fileEntry.count({ where: { connectorId, organizationId: orgId, status: 'pending' } }));
    // Only the next slice of an unfinished sync skips the walk. A scheduled or
    // manual sync, a resume or a changed selection always lists the folder
    // again, so the quota check sees the current content.
    const continuing = stats.continuePending === true && pendingCount > 0 && source.setupState === 'syncing';

    // A continuation slice reopens the sync it belongs to, so the history shows one row per sync.
    const previous = continuing
      ? await this.repo.withTenant(orgId, (tx) =>
          tx.fileSyncRun.findFirst({ where: { connectorId, organizationId: orgId, status: 'partial' }, orderBy: { startedAt: 'desc' } }),
        )
      : null;
    const run = previous
      ? await this.repo.withTenant(orgId, (tx) =>
          tx.fileSyncRun.update({ where: { id: previous.id }, data: { status: 'running', workerId: this.workerId, finishedAt: null } }),
        )
      : await this.repo.withTenant(orgId, (tx) =>
          tx.fileSyncRun.create({ data: { organizationId: orgId, connectorId, trigger: continuing ? 'resume' : trigger, status: 'running', workerId: this.workerId } }),
        );
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileSource.update({ where: { connectorId }, data: { setupState: source.setupState === 'paused_quota' ? 'paused_quota' : 'syncing', lastRunId: run.id } }),
    );
    const counters: Counters = { listed: 0, new: 0, changed: 0, unchanged: 0, deleted: 0, extracted: 0, identical: 0, failed: 0, skippedSize: 0, nameOnly: 0, bytes: 0 };
    // Continue the counts of the reopened sync.
    if (previous?.counters && typeof previous.counters === 'object') {
      for (const [k, v] of Object.entries(previous.counters as Record<string, unknown>)) {
        if (k in counters && typeof v === 'number') (counters as unknown as Record<string, number>)[k] = v;
      }
    }

    let session: SourceSession | null = null;
    let config: FileSearchConfig;
    try {
      const opened = await openSource(connector);
      session = opened.session;
      // OCR of scanned pages is an Enterprise feature: the setting is ignored on other plans.
      config = { ...opened.config, ocr: !!opened.config.ocr && quota.ocr };
    } catch (err) {
      const msg = (err as Error).message;
      await this.finishRun(orgId, run.id, 'failed', counters, msg);
      const failures = (stats.consecutiveFailures ?? 0) + 1;
      await this.repo.withTenant(orgId, (tx) =>
        tx.fileSource.update({
          where: { connectorId },
          data: {
            setupState: failures >= 3 ? 'paused_error' : source.setupState === 'paused_quota' ? 'paused_quota' : 'active',
            pausedReason: failures >= 3 ? `The server could not be reached three times in a row: ${msg}` : source.pausedReason,
            pausedAt: failures >= 3 ? new Date() : source.pausedAt,
            nextSyncAt: new Date(Date.now() + Math.min(failures * 30, 6 * 60) * 60_000),
            stats: { ...stats, consecutiveFailures: failures, lastError: msg, continuePending: false },
          },
        }),
      );
      if (failures >= 3) await this.notifier.notify(orgId, connectorId, connector.name, `Syncing stopped after three failed connection attempts: ${msg}`);
      return { status: 'failed', more: false };
    }

    try {
      if (!continuing) {
        // 2. Walk
        const existing = new Map<string, { id: string; size: bigint; mtime: Date | null; etag: string | null; status: string }>();
        const rows = await this.repo.withTenant(orgId, (tx) =>
          tx.fileEntry.findMany({ where: { connectorId, organizationId: orgId }, select: { id: true, path: true, size: true, mtime: true, etag: true, status: true } }),
        );
        for (const r of rows) existing.set(r.path, r);
        const seen = new Map<string, { size: number; mtime: Date | null; etag?: string; kind: 'new' | 'changed' | 'same' }>();
        const filter = buildFilter(config);
        const summary = await walk(session, {
          filter,
          maxEntries: MAX_ENTRIES,
          maxDepth: config.maxDepth,
          deadline: Date.now() + WALK_MS,
          onFile: (e) => {
            const prev = existing.get(e.path);
            let kind: 'new' | 'changed' | 'same' = 'new';
            if (prev) {
              const sameEtag = e.etag && prev.etag ? e.etag === prev.etag : null;
              const sameStat = Number(prev.size) === e.size && (prev.mtime?.getTime() ?? 0) === (e.mtime?.getTime() ?? 0);
              kind = (sameEtag ?? sameStat) && prev.status !== 'failed' ? 'same' : 'changed';
            }
            seen.set(e.path, { size: e.size, mtime: e.mtime, etag: e.etag, kind });
          },
        });
        if (summary.truncated === 'time') this.logger.warn(`walk of ${connectorId} hit the time limit`);
        counters.listed = seen.size;

        // 3. Quota on the whole selection, before any download.
        let selBytes = 0;
        for (const v of seen.values()) selBytes += v.size;
        const others = await this.repo.withTenant(orgId, (tx) =>
          tx.fileEntry.aggregate({ where: { organizationId: orgId, connectorId: { not: connectorId } }, _count: true, _sum: { size: true } }),
        );
        const q = checkQuota({ files: seen.size, bytes: selBytes }, quota.maxFiles, isCloud() ? quota.maxSourceBytes : null, {
          files: others._count,
          bytes: Number(others._sum.size ?? 0),
        });
        const newStats = { ...stats, selectedFiles: seen.size, selectedBytes: selBytes, lastWalkAt: new Date().toISOString(), consecutiveFailures: 0, lastError: null };
        if (!q.fits) {
          const over = q.over[0];
          const indexedAt = source.lastSuccessAt ? source.lastSuccessAt.toISOString().slice(0, 10) : null;
          const what = over.limit === 'files' ? `${over.used.toLocaleString('en')} files` : `${(over.used / 1048576).toFixed(0)} MB`;
          const max = over.limit === 'files' ? `${over.max.toLocaleString('en')} files` : `${(over.max / 1048576).toFixed(0)} MB`;
          const next = nextPlan(access.plan, isCloud());
          const reason =
            `Sync paused: the selected folders now hold ${what}${q.over[0].used !== seen.size && over.limit === 'files' ? ' (all File Search connectors together)' : ''}; your plan includes ${max}.` +
            (indexedAt ? ` The AI still searches the files indexed on ${indexedAt}.` : '') +
            (next ? ` The ${next.plan} plan includes ${next.quota.maxFiles?.toLocaleString('en') ?? 'unlimited'} files.` : '');
          await this.repo.withTenant(orgId, (tx) => tx.fileSource.update({ where: { connectorId }, data: { stats: newStats } }));
          await this.finishRun(orgId, run.id, 'paused', counters, reason);
          await this.pause(orgId, connectorId, 'paused_quota', reason, connector.name, source.pauseNotifiedAt);
          return { status: 'paused', more: false };
        }
        if (source.setupState === 'paused_quota') {
          await this.repo.withTenant(orgId, (tx) =>
            tx.fileSource.update({ where: { connectorId }, data: { setupState: 'syncing', pausedAt: null, pausedReason: null, pauseNotifiedAt: null } }),
          );
        }

        // 4. Apply the listing: delete gone files, queue new and changed ones.
        const gone = [...existing.keys()].filter((p) => !seen.has(p));
        counters.deleted = gone.length;
        for (let i = 0; i < gone.length; i += 500) {
          const batch = gone.slice(i, i + 500);
          await this.repo.withTenant(orgId, (tx) => tx.fileEntry.deleteMany({ where: { connectorId, organizationId: orgId, path: { in: batch } } }));
        }
        const creates: any[] = [];
        for (const [path, v] of seen) {
          const name = path.split('/').pop() ?? path;
          const ext = extOf(name);
          const status = v.size > quota.maxFileBytes ? 'skipped_size' : !TEXT_EXTENSIONS.has(ext) ? 'name_only' : 'pending';
          if (v.kind === 'same') {
            counters.unchanged++;
            continue;
          }
          if (status === 'skipped_size') counters.skippedSize++;
          if (status === 'name_only') counters.nameOnly++;
          const data = {
            name,
            ext,
            dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
            size: BigInt(v.size),
            mtime: v.mtime,
            etag: v.etag ?? null,
            status,
            seenRunId: run.id,
          };
          if (v.kind === 'new') {
            counters.new++;
            creates.push({ organizationId: orgId, connectorId, path, ...data });
          } else {
            counters.changed++;
            await this.repo.withTenant(orgId, (tx) =>
              tx.fileEntry.update({ where: { connectorId_path: { connectorId, path } }, data: { ...data, attempts: 0, lastError: null } }),
            );
            if (status !== 'pending') await this.repo.withTenant(orgId, (tx) => tx.fileChunk.deleteMany({ where: { organizationId: orgId, entry: { connectorId, path } } }));
          }
        }
        for (let i = 0; i < creates.length; i += 500) {
          await this.repo.withTenant(orgId, (tx) => tx.fileEntry.createMany({ data: creates.slice(i, i + 500), skipDuplicates: true }));
        }
        await this.repo.withTenant(orgId, (tx) => tx.fileSource.update({ where: { connectorId }, data: { stats: newStats } }));
      }

      // 5. Process the queue in a slice.
      const sliceEnd = Date.now() + SLICE_MS;
      let processed = 0;
      while (processed < SLICE_FILES && Date.now() < sliceEnd) {
        const batch = await this.repo.withTenant(orgId, (tx) =>
          tx.fileEntry.findMany({
            where: { connectorId, organizationId: orgId, status: 'pending' },
            orderBy: [{ mtime: 'desc' }],
            take: Math.min(10, SLICE_FILES - processed),
            select: { id: true, path: true, name: true, size: true, sha256: true, attempts: true, textChars: true },
          }),
        );
        if (!batch.length) break;
        for (const e of batch) {
          await this.backPressure();
          await this.processOne(orgId, connectorId, session, config, quota.maxFileBytes, quota.maxTextChars, e, counters);
          processed++;
          if (counters.failed > 0 && counters.failed === processed && processed >= 5 && !(await this.extractor.health()).ok) {
            throw new ExtractorUnavailableError('The text extractor is not available.');
          }
        }
        const paused = await this.repo.withTenant(orgId, (tx) => tx.fileSource.findUnique({ where: { connectorId }, select: { setupState: true } }));
        if (paused?.setupState === 'paused_quota' || paused?.setupState === 'paused_admin') break;
      }
      await session.close();
      session = null;

      const remaining = await this.repo.withTenant(orgId, (tx) => tx.fileEntry.count({ where: { connectorId, organizationId: orgId, status: 'pending' } }));
      const stateNow = await this.repo.withTenant(orgId, (tx) => tx.fileSource.findUnique({ where: { connectorId }, select: { setupState: true } }));
      if (stateNow?.setupState === 'paused_quota') {
        await this.finishRun(orgId, run.id, 'paused', counters, 'Text quota reached.');
        return { status: 'paused', more: false };
      }
      await this.refreshStats(orgId, connectorId);
      if (remaining > 0) {
        await this.finishRun(orgId, run.id, 'partial', counters, null);
        await this.markContinuation(orgId, connectorId, true);
        await this.repo.withTenant(orgId, (tx) =>
          tx.fileSource.update({ where: { connectorId }, data: { setupState: stateNow?.setupState === 'paused_admin' ? 'paused_admin' : 'syncing', nextSyncAt: new Date() } }),
        );
        return { status: 'partial', more: true };
      }
      await this.finishRun(orgId, run.id, 'succeeded', counters, null);
      await this.markContinuation(orgId, connectorId, false);
      const jitter = Math.floor(Math.random() * Math.min(source.syncIntervalMinutes, 30)) * 60_000;
      await this.repo.withTenant(orgId, (tx) =>
        tx.fileSource.update({
          where: { connectorId },
          data: {
            setupState: stateNow?.setupState === 'paused_admin' ? 'paused_admin' : 'active',
            lastSuccessAt: new Date(),
            nextSyncAt: new Date(Date.now() + source.syncIntervalMinutes * 60_000 + jitter),
          },
        }),
      );
      return { status: 'succeeded', more: false };
    } catch (err) {
      await session?.close().catch(() => undefined);
      const msg = (err as Error).message;
      this.logger.warn(`sync ${connectorId} failed: ${msg}`);
      await this.finishRun(orgId, run.id, 'failed', counters, msg);
      await this.repo.withTenant(orgId, (tx) =>
        tx.fileSource.update({
          where: { connectorId },
          data: { setupState: 'active', nextSyncAt: new Date(Date.now() + (err instanceof ExtractorUnavailableError ? 5 : 30) * 60_000), stats: { ...stats, lastError: msg, continuePending: false } },
        }),
      );
      return { status: 'failed', more: false };
    }
  }

  private async processOne(
    orgId: string,
    connectorId: string,
    session: SourceSession,
    config: FileSearchConfig,
    maxFileBytes: number,
    maxTextChars: number | null,
    e: { id: string; path: string; name: string; size: bigint; sha256: string | null; attempts: number; textChars: number },
    counters: Counters,
  ): Promise<void> {
    let buf: Buffer;
    try {
      buf = await readAll(await session.open(e.path, maxFileBytes), maxFileBytes);
    } catch (err) {
      counters.failed++;
      await this.markFailed(orgId, e, `Download failed: ${(err as Error).message}`);
      return;
    }
    counters.bytes += buf.length;
    const hash = sha256(buf);
    if (hash === e.sha256) {
      counters.identical++;
      await this.repo.withTenant(orgId, (tx) => tx.fileEntry.update({ where: { id: e.id }, data: { status: 'indexed', size: BigInt(buf.length), attempts: 0, lastError: null } }));
      return;
    }
    const r = await this.extractor.extract(buf, e.name, { ocr: !!config.ocr });
    if (!r.ok) {
      const kind = r.error?.kind;
      if (kind === 'unsupported' || kind === 'empty') {
        await this.repo.withTenant(orgId, async (tx) => {
          await tx.fileChunk.deleteMany({ where: { entryId: e.id, organizationId: orgId } });
          await tx.fileEntry.update({ where: { id: e.id }, data: { status: 'name_only', sha256: hash, lastError: r.error?.message ?? null, textChars: 0, indexedAt: new Date() } });
        });
        counters.nameOnly++;
        return;
      }
      counters.failed++;
      // A password-protected file stays unreadable until it changes: no retries.
      await this.markFailed(orgId, kind === 'encrypted' ? { ...e, attempts: MAX_ATTEMPTS - 1 } : e, r.error?.message ?? 'The text could not be read.', hash);
      return;
    }
    const chunks = toChunks(r.pages);
    const chars = chunks.reduce((n, c) => n + c.content.length, 0);
    if (maxTextChars != null) {
      const total = await this.repo.withTenant(orgId, (tx) => tx.fileEntry.aggregate({ where: { organizationId: orgId }, _sum: { textChars: true } }));
      if ((total._sum.textChars ?? 0) - e.textChars + chars > maxTextChars) {
        await this.pause(
          orgId,
          connectorId,
          'paused_quota',
          `Sync paused: the indexed text reached your plan's limit of ${maxTextChars.toLocaleString('en')} characters. Untick folders or upgrade.`,
          undefined,
          null,
        );
        return;
      }
    }
    await this.repo.withTenant(orgId, async (tx) => {
      await tx.fileChunk.deleteMany({ where: { entryId: e.id, organizationId: orgId } });
      if (chunks.length) {
        await tx.fileChunk.createMany({
          data: chunks.map((c, i) => ({ organizationId: orgId, connectorId, entryId: e.id, page: c.page, ord: i, content: c.content })),
        });
      }
      await tx.fileEntry.update({
        where: { id: e.id },
        data: {
          status: chunks.length ? 'indexed' : 'name_only',
          sha256: hash,
          size: BigInt(buf.length),
          attempts: 0,
          lastError: r.truncated ? 'The text was cut at 2,000,000 characters.' : chunks.length ? null : 'No readable text (a scan without OCR?).',
          pageCount: r.meta?.pageCount ?? null,
          textChars: chars,
          indexedAt: new Date(),
        },
      });
    }, { timeoutMs: 60_000 });
    counters.extracted++;
  }

  private async markContinuation(orgId: string, connectorId: string, on: boolean) {
    const src = await this.repo.withTenant(orgId, (tx) => tx.fileSource.findUnique({ where: { connectorId }, select: { stats: true } }));
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileSource.update({ where: { connectorId }, data: { stats: { ...((src?.stats as object) ?? {}), continuePending: on } } }),
    );
  }

  private async markFailed(orgId: string, e: { id: string; attempts: number }, message: string, hash?: string) {
    const attempts = e.attempts + 1;
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileEntry.update({
        where: { id: e.id },
        data: {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'gave_up' : 'failed',
          lastError: attempts >= MAX_ATTEMPTS ? `${message} (gave up after ${attempts} attempts; found by name only until the file changes)` : message,
          ...(hash && attempts >= MAX_ATTEMPTS ? { sha256: hash } : {}),
        },
      }),
    );
  }

  /** Failed files are retried on the next run (not within the same slice). */
  private async requeueFailed(orgId: string, connectorId: string) {
    await this.repo.withTenant(orgId, (tx) => tx.fileEntry.updateMany({ where: { connectorId, organizationId: orgId, status: 'failed' }, data: { status: 'pending' } }));
  }

  private async finishRun(orgId: string, runId: string, status: string, counters: Counters, error: string | null) {
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileSyncRun.update({ where: { id: runId }, data: { status, counters: counters as any, error: error?.slice(0, 2000) ?? null, finishedAt: new Date() } }),
    );
    if (status === 'succeeded' || status === 'partial') {
      const run = await this.repo.withTenant(orgId, (tx) => tx.fileSyncRun.findUnique({ where: { id: runId }, select: { connectorId: true } }));
      if (run && status === 'succeeded') await this.requeueFailed(orgId, run.connectorId);
    }
  }

  async refreshStats(orgId: string, connectorId: string) {
    const rows = await this.repo.withTenant(orgId, (tx) =>
      tx.fileEntry.groupBy({ by: ['status'], where: { connectorId, organizationId: orgId }, _count: true, _sum: { size: true, textChars: true } }),
    );
    const byStatus: Record<string, number> = {};
    let files = 0;
    let bytes = 0;
    let textChars = 0;
    for (const r of rows) {
      byStatus[r.status] = r._count;
      files += r._count;
      bytes += Number(r._sum.size ?? 0);
      textChars += r._sum.textChars ?? 0;
    }
    const src = await this.repo.withTenant(orgId, (tx) => tx.fileSource.findUnique({ where: { connectorId }, select: { stats: true } }));
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileSource.update({ where: { connectorId }, data: { stats: { ...((src?.stats as object) ?? {}), files, bytes, textChars, byStatus } } }),
    );
  }

  private async pause(orgId: string, connectorId: string, state: 'paused_quota' | 'paused_licence', reason: string, connectorName: string | undefined, notifiedAt: Date | null) {
    await this.repo.withTenant(orgId, (tx) =>
      tx.fileSource.update({
        where: { connectorId },
        data: {
          setupState: state,
          pausedReason: reason,
          pausedAt: new Date(),
          // A paused source is listed again once a day to see whether it fits.
          nextSyncAt: new Date(Date.now() + 24 * 3600_000),
        },
      }),
    );
    if (!notifiedAt) {
      const name = connectorName ?? (await this.prisma.connector.findUnique({ where: { id: connectorId }, select: { name: true } }))?.name ?? 'File Search';
      const sent = await this.notifier.notify(orgId, connectorId, name, reason);
      if (sent) await this.repo.withTenant(orgId, (tx) => tx.fileSource.update({ where: { connectorId }, data: { pauseNotifiedAt: new Date() } }));
    }
  }
}
