// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import type { PathFilter } from '../../../file-search/file-search-selection';
import { isJunkName } from '../../../file-search/file-search.types';
import type { RemoteEntry, SourceSession } from '../sources/source.types';

/**
 * Breadth-first walk of a source (#1383). Bounded: entries, depth and time.
 * Folders a filter rejects are never listed; junk (NAS/OS housekeeping,
 * Office lock files) never shows up.
 */
export interface WalkOptions {
  filter?: PathFilter | null;
  maxEntries: number;
  maxDepth: number;
  deadline: number;
  isCancelled?: () => Promise<boolean>;
  onFile: (e: RemoteEntry) => void | Promise<void>;
  onDir?: (relDir: string, depth: number) => void | Promise<void>;
  onProgress?: (files: number, dirs: number) => void | Promise<void>;
}

export interface WalkSummary {
  files: number;
  dirs: number;
  truncated: false | 'entries' | 'time';
  cancelled: boolean;
  /** Folders that could not be listed (permission), relative paths. */
  unreadable: string[];
}

export async function walk(session: SourceSession, opts: WalkOptions): Promise<WalkSummary> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }];
  const out: WalkSummary = { files: 0, dirs: 0, truncated: false, cancelled: false, unreadable: [] };
  let lastProgress = 0;
  while (queue.length) {
    if (Date.now() > opts.deadline) {
      out.truncated = 'time';
      break;
    }
    if (out.dirs % 20 === 0 && opts.isCancelled && (await opts.isCancelled())) {
      out.cancelled = true;
      break;
    }
    const { dir, depth } = queue.shift()!;
    let entries: RemoteEntry[];
    try {
      entries = await session.list(dir);
    } catch (err) {
      if (!dir) throw err;
      out.unreadable.push(dir);
      continue;
    }
    out.dirs++;
    await opts.onDir?.(dir, depth);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isJunkName(e.name)) continue;
      if (e.isDir) {
        if (depth + 1 > opts.maxDepth) continue;
        if (opts.filter && !opts.filter.dir(e.path)) continue;
        queue.push({ dir: e.path, depth: depth + 1 });
        continue;
      }
      if (opts.filter && !opts.filter.file(e.path, e.mtime)) continue;
      out.files++;
      await opts.onFile(e);
      if (out.files >= opts.maxEntries) {
        out.truncated = 'entries';
        return out;
      }
    }
    if (opts.onProgress && out.files - lastProgress >= 500) {
      lastProgress = out.files;
      await opts.onProgress(out.files, out.dirs);
    }
  }
  return out;
}

/** Reads a whole stream into memory (files are capped by the plan before this). */
export async function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) throw new Error(`The file is larger than the allowed ${max} bytes.`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
