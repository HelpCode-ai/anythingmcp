import picomatch from 'picomatch';
import { TEXT_EXTENSIONS, isJunkName, type FileSearchConfig } from './file-search.types';
import { trimSlashes } from './file-search-config';

/**
 * What gets indexed, and how much that is (#1385). Shared by the wizard API
 * (live budget bar) and the worker (walk filter and quota check), so the
 * number the admin sees is the number the sync enforces.
 */

/** The wizard's selection: folders unticked, types and age. */
export interface Selection {
  excludeFolders: string[];
  extensions?: string[];
  maxAgeYears?: number;
}

/** A compact listing stored on the scan: dirs and exts are dictionaries. */
export interface CompactListing {
  dirs: string[];
  exts: string[];
  /** [dirIndex, extIndex, sizeBytes, mtimeEpochDay, nameOnly(0|1)] */
  entries: Array<[number, number, number, number, number]>;
}

export interface Estimate {
  files: number;
  bytes: number;
  /** Files with readable text (the rest are found by name). */
  textFiles: number;
  nameOnly: number;
  /** Over the plan's per-file size: listed, never downloaded. */
  tooLarge: number;
}

export function folderGlob(folder: string): string {
  const f = trimSlashes(folder);
  return `${f}/**`;
}

/** Writes a selection into the connector settings (include/exclude/extensions/age). */
export function applySelection(config: FileSearchConfig, sel: Selection): FileSearchConfig {
  const folders = [...new Set(sel.excludeFolders.map((f) => trimSlashes(f)).filter(Boolean))].slice(0, 500);
  return {
    ...config,
    include: ['**/*'],
    exclude: folders.map(folderGlob),
    extensions: sel.extensions?.length ? sel.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()) : undefined,
    maxAgeYears: sel.maxAgeYears && sel.maxAgeYears > 0 ? Math.floor(sel.maxAgeYears) : undefined,
  };
}

/** Reads the selection back from the settings (folders from `<folder>/**` excludes). */
export function selectionOf(config: FileSearchConfig): Selection {
  return {
    excludeFolders: (config.exclude ?? []).filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3)),
    extensions: config.extensions,
    maxAgeYears: config.maxAgeYears,
  };
}

export interface PathFilter {
  /** Whether a folder (relative path) should be walked at all. */
  dir(relDir: string): boolean;
  /** Whether a file (relative path) belongs to the selection. */
  file(relPath: string, mtime: Date | null): boolean;
}

export function buildFilter(config: FileSearchConfig, now = new Date()): PathFilter {
  const opts = { dot: false, nocase: true };
  const include = picomatch(config.include?.length ? config.include : ['**/*'], opts);
  const exclude = config.exclude?.length ? picomatch(config.exclude, opts) : () => false;
  const excludedFolders = (config.exclude ?? []).filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3).toLowerCase());
  const exts = config.extensions?.length ? new Set(config.extensions) : null;
  const minTime = config.maxAgeYears ? now.getTime() - config.maxAgeYears * 365.25 * 86400_000 : null;
  return {
    dir(relDir) {
      if (!relDir) return true;
      const parts = relDir.split('/');
      if (parts.some(isJunkName)) return false;
      if (parts.length > config.maxDepth) return false;
      const lower = relDir.toLowerCase();
      return !excludedFolders.some((f) => lower === f || lower.startsWith(f + '/'));
    },
    file(relPath, mtime) {
      const name = relPath.split('/').pop() ?? '';
      if (isJunkName(name)) return false;
      if (!include(relPath) || exclude(relPath)) return false;
      if (exts) {
        const i = name.lastIndexOf('.');
        if (!exts.has(i > 0 ? name.slice(i).toLowerCase() : '')) return false;
      }
      if (minTime != null && mtime && mtime.getTime() < minTime) return false;
      return true;
    },
  };
}

/** Counts what a selection would index, from the scan's compact listing. */
export function estimate(listing: CompactListing, config: FileSearchConfig, maxFileBytes: number, now = new Date()): Estimate {
  const f = buildFilter(config, now);
  const dirOk = listing.dirs.map((d) => f.dir(d));
  const out: Estimate = { files: 0, bytes: 0, textFiles: 0, nameOnly: 0, tooLarge: 0 };
  for (const [di, ei, size, day, nameOnly] of listing.entries) {
    if (!dirOk[di]) continue;
    const dir = listing.dirs[di];
    const ext = listing.exts[ei];
    const rel = `${dir ? dir + '/' : ''}x${ext}`;
    if (!f.file(rel, new Date(day * 86400_000))) continue;
    out.files++;
    out.bytes += size;
    if (size > maxFileBytes) out.tooLarge++;
    else if (nameOnly || !TEXT_EXTENSIONS.has(ext)) out.nameOnly++;
    else out.textFiles++;
  }
  return out;
}

export interface QuotaCheck {
  fits: boolean;
  over: Array<{ limit: 'files' | 'bytes'; used: number; max: number }>;
}

export function checkQuota(e: Pick<Estimate, 'files' | 'bytes'>, maxFiles: number | null, maxBytes: number | null, alreadyUsed = { files: 0, bytes: 0 }): QuotaCheck {
  const over: QuotaCheck['over'] = [];
  if (maxFiles != null && e.files + alreadyUsed.files > maxFiles) over.push({ limit: 'files', used: e.files + alreadyUsed.files, max: maxFiles });
  if (maxBytes != null && e.bytes + alreadyUsed.bytes > maxBytes) over.push({ limit: 'bytes', used: e.bytes + alreadyUsed.bytes, max: maxBytes });
  return { fits: over.length === 0, over };
}
