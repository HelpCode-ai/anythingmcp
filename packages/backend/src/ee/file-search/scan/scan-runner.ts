// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma.service';
import { FileSearchRepository } from '../../../file-search/file-search.repository';
import { aggregateTree, type TreeNode } from '../../../file-search/file-search-query.service';
import { applySelection, selectionOf, type CompactListing } from '../../../file-search/file-search-selection';
import { TEXT_EXTENSIONS, extOf, isArchiveFolderName, type FileSearchConfig } from '../../../file-search/file-search.types';
import { ExtractorClient } from '../extractor.client';
import { describeByRules, type Description, type ScanFacts } from '../describe/rules';
import { describeWithAi } from '../describe/ai';
import { openSource, type ConnectorRow } from '../source-context';
import { readAll, walk } from '../sync/walk';

/**
 * A setup scan (#1385): lists the whole folder without indexing it, samples
 * up to 20 small documents and drafts the description. Nothing is written to
 * the index; the result lives on the file_scans row.
 */

const MAX_ENTRIES = 200_000;
const SCAN_TIME_MS = 2 * 60_000;
const SAMPLES = 20;
const SAMPLE_MAX_BYTES = 5 * 1024 * 1024;
const SAMPLE_CHARS = 2_000;

export interface ScanNode extends TreeNode {
  archive?: boolean;
}

export class ScanRunner {
  private readonly logger = new Logger(ScanRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly extractor: ExtractorClient,
  ) {}

  private async update(orgId: string, scanId: string, data: Record<string, unknown>) {
    await this.repo.withTenant(orgId, (tx) => tx.fileScan.update({ where: { id: scanId }, data: data as any }));
  }

  private async cancelled(orgId: string, scanId: string): Promise<boolean> {
    const s = await this.repo.withTenant(orgId, (tx) => tx.fileScan.findUnique({ where: { id: scanId }, select: { status: true } }));
    return s?.status === 'cancelled';
  }

  async run(scanId: string, organizationId: string): Promise<void> {
    const scan = await this.repo.withTenant(organizationId, (tx) => tx.fileScan.findUnique({ where: { id: scanId } }));
    if (!scan) return;
    const connector = (await this.prisma.connector.findUnique({ where: { id: scan.connectorId } })) as ConnectorRow | null;
    if (!connector) return;
    const useAi = !!(scan.progress as any)?.useAi;
    const started = Date.now();
    await this.update(organizationId, scanId, { status: 'running', progress: { phase: 'connecting', useAi } });

    let session;
    let config: FileSearchConfig;
    try {
      const opened = await openSource(connector);
      session = opened.session;
      config = opened.config;
    } catch (err) {
      await this.update(organizationId, scanId, { status: 'failed', error: (err as Error).message, finishedAt: new Date() });
      return;
    }

    const dirs: string[] = [];
    const dirIndex = new Map<string, number>();
    const exts: string[] = [];
    const extIndex = new Map<string, number>();
    const listing: CompactListing = { dirs, exts, entries: [] };
    const types: Record<string, { files: number; bytes: number }> = {};
    const perDir = new Map<string, { files: number; bytes: number }>();
    const candidates: Array<{ path: string; top: string; size: number; mtime: number }> = [];
    let oldest = Infinity;
    let newest = 0;
    let bytes = 0;
    let nameOnly = 0;
    const idx = (m: Map<string, number>, arr: string[], v: string) => {
      let i = m.get(v);
      if (i === undefined) {
        i = arr.length;
        arr.push(v);
        m.set(v, i);
      }
      return i;
    };

    try {
      const summary = await walk(session, {
        maxEntries: MAX_ENTRIES,
        maxDepth: config.maxDepth,
        deadline: started + SCAN_TIME_MS,
        isCancelled: () => this.cancelled(organizationId, scanId),
        onDir: (d) => {
          idx(dirIndex, dirs, d);
        },
        onFile: (e) => {
          const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
          const ext = extOf(e.name);
          const t = e.mtime?.getTime() ?? 0;
          const isText = TEXT_EXTENSIONS.has(ext);
          if (!isText) nameOnly++;
          listing.entries.push([idx(dirIndex, dirs, dir), idx(extIndex, exts, ext), e.size, Math.floor(t / 86400_000), isText ? 0 : 1]);
          types[ext] = { files: (types[ext]?.files ?? 0) + 1, bytes: (types[ext]?.bytes ?? 0) + e.size };
          const pd = perDir.get(dir) ?? { files: 0, bytes: 0 };
          pd.files++;
          pd.bytes += e.size;
          perDir.set(dir, pd);
          bytes += e.size;
          if (t) {
            oldest = Math.min(oldest, t);
            newest = Math.max(newest, t);
          }
          if (isText && e.size > 0 && e.size <= SAMPLE_MAX_BYTES) candidates.push({ path: e.path, top: e.path.split('/')[0], size: e.size, mtime: t });
        },
        onProgress: (files, d) => this.update(organizationId, scanId, { progress: { phase: 'listing', files, dirs: d, useAi } }),
      });
      if (summary.cancelled) {
        await session.close();
        return;
      }

      const root = aggregateTree([...perDir.entries()].map(([dir, v]) => ({ dir, ...v })), 4) as ScanNode;
      const archives: Array<{ path: string; files: number; reason: string }> = [];
      const mark = (n: ScanNode, depth: number) => {
        for (const c of n.children as ScanNode[]) {
          if (isArchiveFolderName(c.name)) {
            c.archive = true;
            archives.push({ path: c.path, files: c.files, reason: 'archive' });
          } else if (depth < 4) mark(c, depth + 1);
        }
      };
      mark(root, 1);

      // Samples: newest first, spread over the top-level folders.
      await this.update(organizationId, scanId, { progress: { phase: 'sampling', files: summary.files, dirs: summary.dirs, useAi } });
      const archivePrefixes = archives.map((a) => a.path + '/');
      const pool = candidates.filter((c) => !archivePrefixes.some((p) => c.path.startsWith(p))).sort((a, b) => b.mtime - a.mtime);
      const byTop = new Map<string, typeof pool>();
      for (const c of pool) byTop.set(c.top, [...(byTop.get(c.top) ?? []), c]);
      const picked: typeof pool = [];
      while (picked.length < SAMPLES && [...byTop.values()].some((l) => l.length)) {
        for (const l of byTop.values()) {
          const c = l.shift();
          if (c) picked.push(c);
          if (picked.length >= SAMPLES) break;
        }
      }
      const samples: Array<{ path: string; excerpt: string }> = [];
      if (this.extractor.configured) {
        for (const c of picked) {
          if (await this.cancelled(organizationId, scanId)) break;
          try {
            const buf = await readAll(await session.open(c.path, SAMPLE_MAX_BYTES), SAMPLE_MAX_BYTES);
            const r = await this.extractor.extract(buf, c.path.split('/').pop() ?? c.path, { maxChars: 20_000 });
            const text = r.pages.map((p) => p.text).join('\n').replace(/\s+\n/g, '\n').trim();
            if (text) samples.push({ path: c.path, excerpt: text.slice(0, SAMPLE_CHARS) });
          } catch (err) {
            this.logger.debug(`sample ${c.path}: ${(err as Error).message}`);
          }
        }
      }
      await session.close();

      const topFolders = root.children.map((c) => ({ name: c.name, files: c.files }));
      const subfolders = root.children.slice(0, 200).map((c) => ({ parent: c.name, names: c.children.map((g) => g.name) }));
      const totals = {
        files: summary.files,
        dirs: summary.dirs,
        bytes,
        oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
        newest: newest ? new Date(newest).toISOString() : null,
        nameOnly,
        textFiles: summary.files - nameOnly,
        unreadableFolders: summary.unreadable.slice(0, 50),
        durationMs: Date.now() - started,
      };

      // A first scan of a draft unticks the archive folders; the admin sees and can tick them again.
      const sel = selectionOf(config);
      if (!sel.excludeFolders.length && archives.length && !connector.isActive) {
        const next = applySelection(config, { ...sel, excludeFolders: archives.map((a) => a.path) });
        await this.prisma.connector.update({ where: { id: connector.id }, data: { config: { ...(connector.config as object), fileSearch: next } as any } });
        config = next;
      }

      // The description speaks about what will be indexed: archive folders unticked above are left out.
      const excludedNow = new Set(selectionOf(config).excludeFolders);
      const archiveFiles = archives.filter((a) => excludedNow.has(a.path)).reduce((n, a) => n + a.files, 0);
      const facts: ScanFacts = {
        displayName: connector.name,
        topFolders,
        subfolders,
        types,
        totals: { ...totals, files: totals.files - archiveFiles },
        samples,
        excludedArchives: selectionOf(config).excludeFolders,
        toolPrefix: config.toolPrefix,
      };
      await this.update(organizationId, scanId, { progress: { phase: 'describing', files: summary.files, dirs: summary.dirs, useAi } });
      const description: Description = useAi ? await describeWithAi(facts) : describeByRules(facts);
      await this.update(organizationId, scanId, {
        status: 'done',
        tree: { root, listing } as any,
        types,
        totals,
        samples,
        suggestions: { excludeFolders: archives, toolPrefix: config.toolPrefix, facts: { topFolders: topFolders.slice(0, 200), subfolders } },
        description,
        truncated: summary.truncated !== false,
        progress: { phase: 'done', files: summary.files, dirs: summary.dirs, useAi, truncated: summary.truncated },
        finishedAt: new Date(),
      });
      await this.repo.withTenant(organizationId, (tx) =>
        tx.fileSource.updateMany({ where: { connectorId: connector.id }, data: { instructionsDraft: description.instructions } }),
      );
      this.logger.log(`scan ${scanId}: ${summary.files} files, ${summary.dirs} folders, ${samples.length} samples, ${description.source} description in ${Date.now() - started} ms`);
    } catch (err) {
      await session?.close().catch(() => undefined);
      await this.update(organizationId, scanId, { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date() });
    }
  }

  /** Regenerates the description of a finished scan from its stored facts. */
  async redescribe(scanId: string, organizationId: string): Promise<void> {
    const scan = await this.repo.withTenant(organizationId, (tx) => tx.fileScan.findUnique({ where: { id: scanId } }));
    if (!scan) return;
    const connector = await this.prisma.connector.findUnique({ where: { id: scan.connectorId } });
    if (!connector) return;
    const useAi = !!(scan.progress as any)?.useAi;
    const s = (scan.suggestions as any) ?? {};
    const config = (connector.config as any).fileSearch as FileSearchConfig;
    const facts: ScanFacts = {
      displayName: connector.name,
      topFolders: s.facts?.topFolders ?? [],
      subfolders: s.facts?.subfolders ?? [],
      types: (scan.types as any) ?? {},
      totals: (scan.totals as any) ?? { files: 0, dirs: 0, bytes: 0, oldest: null, newest: null, nameOnly: 0 },
      samples: (scan.samples as any) ?? [],
      excludedArchives: selectionOf(config).excludeFolders,
      toolPrefix: config.toolPrefix,
    };
    const description = useAi ? await describeWithAi(facts) : describeByRules(facts);
    await this.update(organizationId, scanId, { status: 'done', description, progress: { phase: 'done', useAi } });
    await this.repo.withTenant(organizationId, (tx) =>
      tx.fileSource.updateMany({ where: { connectorId: connector.id }, data: { instructionsDraft: description.instructions } }),
    );
  }
}
