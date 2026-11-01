import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { FileSearchRepository, type FileTx } from './file-search.repository';

/**
 * The read side of File Search (#1384): the SQL behind the MCP tools. Runs
 * in the backend that answers MCP calls, so every query is bounded (row
 * limits, statement_timeout) and only reads the index; nothing here talks
 * to a customer's server.
 */

/** Folder scope of a caller: the connector, optionally narrowed by Enterprise folder rules. */
export interface FileScope {
  organizationId: string;
  connectorId: string;
  /** Folder prefixes the caller may see (relative, no leading slash). Empty = everything. */
  allow?: string[];
  /** Folder prefixes the caller may not see. Deny wins. */
  deny?: string[];
}

export interface SearchParams {
  query: string;
  path?: string;
  extensions?: string[];
  modifiedAfter?: string;
  modifiedBefore?: string;
  sort?: 'relevance' | 'newest';
  limit?: number;
}

const STATEMENT_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 400;

export function relPath(p: string | undefined): string {
  return (p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function toDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
}

/** SQL fragment restricting `alias.path` to the caller's scope and an optional folder. */
export function scopeSql(alias: string, scope: FileScope, folder?: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(alias)}.organization_id = ${scope.organizationId}`,
    Prisma.sql`${Prisma.raw(alias)}.connector_id = ${scope.connectorId}`,
  ];
  const f = relPath(folder);
  if (f) parts.push(Prisma.sql`(${Prisma.raw(alias)}.path LIKE ${likeEscape(f) + '/%'})`);
  const allow = (scope.allow ?? []).map(relPath).filter(Boolean);
  if (allow.length) {
    parts.push(
      Prisma.sql`(${Prisma.join(
        allow.map((a) => Prisma.sql`(${Prisma.raw(alias)}.path LIKE ${likeEscape(a) + '/%'} OR ${Prisma.raw(alias)}.path = ${a})`),
        ' OR ',
      )})`,
    );
  }
  for (const d of (scope.deny ?? []).map(relPath).filter(Boolean)) {
    parts.push(Prisma.sql`NOT (${Prisma.raw(alias)}.path LIKE ${likeEscape(d) + '/%'} OR ${Prisma.raw(alias)}.path = ${d})`);
  }
  return Prisma.join(parts, ' AND ');
}

function entryFilters(alias: string, p: { extensions?: string[]; modifiedAfter?: string; modifiedBefore?: string }): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  const exts = (p.extensions ?? [])
    .map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
    .filter((e) => /^\.[a-z0-9]{1,8}$/.test(e));
  if (exts.length) parts.push(Prisma.sql`${Prisma.raw(alias)}.ext IN (${Prisma.join(exts)})`);
  const after = toDate(p.modifiedAfter);
  if (after) parts.push(Prisma.sql`${Prisma.raw(alias)}.mtime >= ${after}`);
  const before = toDate(p.modifiedBefore);
  if (before) parts.push(Prisma.sql`${Prisma.raw(alias)}.mtime < ${before}`);
  return Prisma.join(parts, ' AND ');
}

@Injectable()
export class FileSearchQueryService {
  constructor(private readonly repo: FileSearchRepository) {}

  private run<T>(scope: FileScope, fn: (tx: FileTx) => Promise<T>): Promise<T> {
    return this.repo.withTenant(scope.organizationId, fn, { timeoutMs: STATEMENT_TIMEOUT_MS });
  }

  /** Full-text search, grouped by file: the best page per file and the other matching pages. */
  async search(scope: FileScope, p: SearchParams) {
    const query = (p.query ?? '').trim().slice(0, 500);
    if (!query) return { query, total: 0, files: [], note: 'Pass a query.' };
    const limit = Math.min(Math.max(p.limit ?? 10, 1), 50);
    return this.run(scope, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT c.id, c.entry_id, c.page, ts_rank_cd(c.search_vector, q.tsq) AS rank,
               e.path, e.name, e.ext, e.size, e.mtime, e.page_count
        FROM file_chunks c
        JOIN file_entries e ON e.id = c.entry_id,
             websearch_to_tsquery('simple', ${query}) AS q(tsq)
        WHERE ${scopeSql('c', scope)} AND ${scopeSql('e', scope, p.path)} AND ${entryFilters('e', p)}
          AND c.search_vector @@ q.tsq
        ORDER BY rank DESC
        LIMIT ${MAX_CANDIDATES}`);

      const byFile = new Map<string, { best: Record<string, unknown>; pages: Set<number>; hits: number; score: number }>();
      for (const r of rows) {
        const key = r.entry_id as string;
        const f = byFile.get(key);
        if (!f) byFile.set(key, { best: r, pages: new Set(r.page != null ? [num(r.page)] : []), hits: 1, score: num(r.rank) });
        else {
          f.hits++;
          f.score += num(r.rank) * 0.25;
          if (r.page != null) f.pages.add(num(r.page));
        }
      }
      let files = [...byFile.values()];
      files.sort((a, b) =>
        p.sort === 'newest'
          ? new Date((b.best.mtime as Date) ?? 0).getTime() - new Date((a.best.mtime as Date) ?? 0).getTime()
          : b.score - a.score,
      );
      const total = files.length;
      files = files.slice(0, limit);

      const chunkIds = files.map((f) => f.best.id as bigint);
      const snippets = new Map<string, string>();
      if (chunkIds.length) {
        const hl = await tx.$queryRaw<Array<{ id: bigint; snippet: string }>>(Prisma.sql`
          SELECT c.id, ts_headline('simple', c.content, websearch_to_tsquery('simple', ${query}),
                 'MaxFragments=2, MaxWords=28, MinWords=8, FragmentDelimiter=" … ", StartSel=«, StopSel=»') AS snippet
          FROM file_chunks c
          WHERE c.organization_id = ${scope.organizationId} AND c.id IN (${Prisma.join(chunkIds)})`);
        for (const h of hl) snippets.set(String(h.id), h.snippet.replace(/\s+/g, ' ').trim());
      }

      // Files whose name matches but whose text does not (scans, name-only types).
      const words = query.replace(/["()]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !/^(or|and|-.*)$/i.test(w)).slice(0, 6);
      let nameMatches: Array<Record<string, unknown>> = [];
      if (words.length) {
        nameMatches = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT e.path, e.size, e.mtime, e.status
          FROM file_entries e
          WHERE ${scopeSql('e', scope, p.path)} AND ${entryFilters('e', p)}
            AND ${Prisma.join(words.map((w) => Prisma.sql`e.path ILIKE ${'%' + likeEscape(w) + '%'}`), ' AND ')}
          ORDER BY e.mtime DESC NULLS LAST
          LIMIT 10`);
      }
      const inResults = new Set(files.map((f) => f.best.path as string));
      return {
        query,
        total,
        files: files.map((f) => ({
          path: f.best.path,
          modified: f.best.mtime ? (f.best.mtime as Date).toISOString() : null,
          size: num(f.best.size),
          page: f.best.page != null ? num(f.best.page) : null,
          otherPages: [...f.pages].filter((x) => x !== num(f.best.page)).sort((a, b) => a - b).slice(0, 15),
          pageCount: f.best.page_count != null ? num(f.best.page_count) : null,
          snippet: snippets.get(String(f.best.id)) ?? '',
        })),
        nameMatches: nameMatches
          .filter((n) => !inResults.has(n.path as string))
          .map((n) => ({ path: n.path, modified: n.mtime ? (n.mtime as Date).toISOString() : null, size: num(n.size), indexed: n.status === 'indexed' })),
      };
    });
  }

  /** Find files by name (words, typo-tolerant) or glob. */
  async find(
    scope: FileScope,
    p: { name?: string; glob?: string; path?: string; extensions?: string[]; modifiedAfter?: string; modifiedBefore?: string; sort?: 'relevance' | 'newest'; limit?: number },
  ) {
    const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
    const name = (p.name ?? '').trim().slice(0, 200);
    return this.run(scope, async (tx) => {
      if (p.glob) {
        const { default: picomatch } = await import('picomatch');
        const isMatch = picomatch(p.glob, { nocase: true, dot: false, basename: !p.glob.includes('/') });
        const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT e.path, e.size, e.mtime, e.status FROM file_entries e
          WHERE ${scopeSql('e', scope, p.path)} AND ${entryFilters('e', p)}
          ORDER BY e.mtime DESC NULLS LAST LIMIT 20000`);
        const hits = rows.filter((r) => isMatch(r.path as string));
        return { total: hits.length, files: hits.slice(0, limit).map(formatFile) };
      }
      if (!name) {
        const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT e.path, e.size, e.mtime, e.status FROM file_entries e
          WHERE ${scopeSql('e', scope, p.path)} AND ${entryFilters('e', p)}
          ORDER BY e.mtime DESC NULLS LAST LIMIT ${limit}`);
        return { total: rows.length, files: rows.map(formatFile) };
      }
      const words = name.split(/\s+/).filter(Boolean).slice(0, 8);
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT e.path, e.size, e.mtime, e.status,
               GREATEST(word_similarity(${name.toLowerCase()}, lower(e.path)), similarity(lower(e.name), ${name.toLowerCase()})) AS score
        FROM file_entries e
        WHERE ${scopeSql('e', scope, p.path)} AND ${entryFilters('e', p)}
          AND ((${Prisma.join(words.map((w) => Prisma.sql`e.path ILIKE ${'%' + likeEscape(w) + '%'}`), ' AND ')})
               OR ${name.toLowerCase()} <% lower(e.path))
        ORDER BY ${p.sort === 'newest' ? Prisma.sql`e.mtime DESC NULLS LAST` : Prisma.sql`score DESC, e.mtime DESC NULLS LAST`}
        LIMIT ${limit}`);
      return { total: rows.length, files: rows.map(formatFile) };
    });
  }

  /** One folder: subfolders with file counts, files with size and date. */
  async list(scope: FileScope, p: { path?: string; limit?: number }) {
    const folder = relPath(p.path);
    const limit = Math.min(Math.max(p.limit ?? 200, 1), 500);
    return this.run(scope, async (tx) => {
      const prefixLen = folder ? folder.length + 1 : 0;
      const sub = await tx.$queryRaw<Array<{ child: string; files: bigint; bytes: bigint; newest: Date | null }>>(Prisma.sql`
        SELECT split_part(substr(e.dir, ${prefixLen + 1}), '/', 1) AS child, count(*) AS files, sum(e.size) AS bytes, max(e.mtime) AS newest
        FROM file_entries e
        WHERE ${scopeSql('e', scope)} AND ${folder ? Prisma.sql`e.dir LIKE ${likeEscape(folder) + '/%'}` : Prisma.sql`e.dir <> ''`}
        GROUP BY 1 ORDER BY 1 LIMIT 500`);
      const files = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT e.path, e.size, e.mtime, e.status FROM file_entries e
        WHERE ${scopeSql('e', scope)} AND e.dir = ${folder}
        ORDER BY e.name LIMIT ${limit}`);
      const visible = sub.filter((s) => s.child);
      return {
        path: folder || '/',
        folders: visible.map((s) => ({
          name: s.child,
          path: folder ? `${folder}/${s.child}` : s.child,
          files: num(s.files),
          bytes: num(s.bytes),
          newest: s.newest ? s.newest.toISOString() : null,
        })),
        files: files.map(formatFile),
        truncated: files.length >= limit,
      };
    });
  }

  /** Text of one file, by pages or by character window. */
  async read(scope: FileScope, p: { path: string; pages?: string; offset?: number; maxChars?: number }) {
    const path = relPath(p.path);
    const maxChars = Math.min(Math.max(p.maxChars ?? 20_000, 500), 100_000);
    return this.run(scope, async (tx) => {
      const [entry] = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT e.id, e.path, e.size, e.mtime, e.status, e.page_count, e.last_error, e.text_chars FROM file_entries e
        WHERE ${scopeSql('e', scope)} AND e.path = ${path} LIMIT 1`);
      if (!entry) return { path, found: false, note: 'No such file in the index. Use find or list to get the exact path.' };
      if (entry.status !== 'indexed') {
        return {
          path,
          found: true,
          indexed: false,
          status: entry.status,
          note:
            entry.status === 'name_only'
              ? 'This file type has no readable text. Use get_file to give the file to the user.'
              : entry.status === 'skipped_size'
                ? 'The file is larger than the plan allows for indexing. Use get_file to give it to the user.'
                : `The text could not be read${entry.last_error ? `: ${String(entry.last_error).replace(/\.+$/, '')}` : ''}.`,
        };
      }
      const wanted = parsePages(p.pages);
      const chunks = await tx.$queryRaw<Array<{ page: number | null; ord: number; content: string }>>(Prisma.sql`
        SELECT c.page, c.ord, c.content FROM file_chunks c
        WHERE c.organization_id = ${scope.organizationId} AND c.entry_id = ${entry.id as string}
          ${wanted ? Prisma.sql`AND c.page IN (${Prisma.join(wanted)})` : Prisma.empty}
        ORDER BY c.ord`);
      let text = chunks.map((c) => (c.page != null ? `--- page ${c.page} ---\n${c.content}` : c.content)).join('\n\n');
      const offset = wanted ? 0 : Math.max(0, Math.floor(p.offset ?? 0));
      const total = text.length;
      text = text.slice(offset, offset + maxChars);
      const end = offset + text.length;
      return {
        path,
        found: true,
        indexed: true,
        modified: entry.mtime ? (entry.mtime as Date).toISOString() : null,
        pageCount: entry.page_count != null ? num(entry.page_count) : null,
        pages: wanted ?? undefined,
        offset,
        totalChars: total,
        truncated: end < total,
        nextOffset: end < total ? end : null,
        text,
      };
    });
  }

  /** Exact search (literal or regex) with two lines of context. */
  async grep(scope: FileScope, p: { pattern: string; regex?: boolean; caseSensitive?: boolean; path?: string; maxHits?: number }) {
    const pattern = (p.pattern ?? '').slice(0, 300);
    if (!pattern) return { hits: [], note: 'Pass a pattern.' };
    const maxHits = Math.min(Math.max(p.maxHits ?? 50, 1), 200);
    let re: RegExp;
    try {
      re = p.regex
        ? new RegExp(pattern, p.caseSensitive ? 'g' : 'gi')
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), p.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return { hits: [], note: `Invalid regular expression: ${(err as Error).message}` };
    }
    return this.run(scope, async (tx) => {
      const cond = p.regex
        ? p.caseSensitive
          ? Prisma.sql`c.content ~ ${pattern}`
          : Prisma.sql`c.content ~* ${pattern}`
        : p.caseSensitive
          ? Prisma.sql`c.content LIKE ${'%' + likeEscape(pattern) + '%'}`
          : Prisma.sql`c.content ILIKE ${'%' + likeEscape(pattern) + '%'}`;
      const rows = await tx.$queryRaw<Array<{ path: string; page: number | null; content: string; mtime: Date | null }>>(Prisma.sql`
        SELECT e.path, c.page, c.content, e.mtime
        FROM file_chunks c JOIN file_entries e ON e.id = c.entry_id
        WHERE ${scopeSql('c', scope)} AND ${scopeSql('e', scope, p.path)} AND ${cond}
        ORDER BY e.mtime DESC NULLS LAST, c.ord
        LIMIT 500`);
      const hits: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const lines = r.content.split('\n');
        for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          hits.push({
            path: r.path,
            page: r.page,
            modified: r.mtime ? r.mtime.toISOString() : null,
            line: lines[i].slice(0, 1000),
            before: lines.slice(Math.max(0, i - 2), i).map((l) => l.slice(0, 300)),
            after: lines.slice(i + 1, i + 3).map((l) => l.slice(0, 300)),
          });
        }
        if (hits.length >= maxHits) break;
      }
      return { pattern, hits, truncated: hits.length >= maxHits };
    });
  }

  /** One entry by exact path, within the caller's scope (get_file, share_file). */
  async entry(scope: FileScope, path: string): Promise<{ path: string; size: number; status: string } | null> {
    const rel = relPath(path);
    if (!rel) return null;
    return this.run(scope, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ path: string; size: bigint; status: string }>>(Prisma.sql`
        SELECT e.path, e.size, e.status FROM file_entries e WHERE ${scopeSql('e', scope)} AND e.path = ${rel} LIMIT 1`);
      return row ? { path: row.path, size: num(row.size), status: row.status } : null;
    });
  }

  /** Status for the `_status` tool and the Files tab. */
  async status(scope: FileScope) {
    return this.run(scope, async (tx) => {
      const source = await tx.fileSource.findFirst({ where: { connectorId: scope.connectorId, organizationId: scope.organizationId } });
      const runs = await tx.fileSyncRun.findMany({
        where: { connectorId: scope.connectorId, organizationId: scope.organizationId },
        orderBy: { startedAt: 'desc' },
        take: 5,
      });
      const counts = await tx.$queryRaw<Array<{ status: string; n: bigint; bytes: bigint; chars: bigint }>>(Prisma.sql`
        SELECT e.status, count(*) AS n, coalesce(sum(e.size),0) AS bytes, coalesce(sum(e.text_chars),0) AS chars
        FROM file_entries e WHERE ${scopeSql('e', scope)} GROUP BY e.status`);
      const byStatus: Record<string, number> = {};
      let files = 0;
      let bytes = 0;
      let chars = 0;
      for (const c of counts) {
        byStatus[c.status] = num(c.n);
        files += num(c.n);
        bytes += num(c.bytes);
        chars += num(c.chars);
      }
      return {
        state: source?.setupState ?? 'draft',
        pausedReason: source?.pausedReason ?? null,
        pausedAt: source?.pausedAt?.toISOString() ?? null,
        summary: source?.summary ?? null,
        lastSuccessAt: source?.lastSuccessAt?.toISOString() ?? null,
        nextSyncAt: source?.nextSyncAt?.toISOString() ?? null,
        syncIntervalMinutes: source?.syncIntervalMinutes ?? null,
        files,
        bytes,
        textChars: chars,
        byStatus,
        runs: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
          counters: r.counters,
          error: r.error,
        })),
      };
    });
  }

  /** Files that failed or were skipped, for the Files tab. */
  async problems(scope: FileScope, limit = 50) {
    return this.run(scope, (tx) =>
      tx.fileEntry.findMany({
        where: { organizationId: scope.organizationId, connectorId: scope.connectorId, OR: [{ status: { in: ['failed', 'gave_up', 'skipped_size'] } }, { attempts: { gt: 0 } }] },
        select: { path: true, status: true, lastError: true, size: true, attempts: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(limit, 200),
      }),
    ).then((rows) => rows.map((r) => ({ ...r, size: num(r.size), updatedAt: r.updatedAt.toISOString() })));
  }

  /** Folder tree of the index (Files tab), aggregated to `depth` levels. */
  async tree(scope: FileScope, depth = 3) {
    return this.run(scope, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ dir: string; files: bigint; bytes: bigint }>>(Prisma.sql`
        SELECT e.dir, count(*) AS files, coalesce(sum(e.size),0) AS bytes FROM file_entries e
        WHERE ${scopeSql('e', scope)} GROUP BY e.dir LIMIT 20000`);
      return aggregateTree(rows.map((r) => ({ dir: r.dir, files: num(r.files), bytes: num(r.bytes) })), depth);
    });
  }
}

function formatFile(r: Record<string, unknown>) {
  return {
    path: r.path,
    size: num(r.size),
    modified: r.mtime ? (r.mtime as Date).toISOString() : null,
    indexed: r.status === 'indexed',
    ...(r.status !== 'indexed' ? { status: r.status } : {}),
  };
}

/** "1-3,7" → [1,2,3,7] (max 50 pages); undefined when not given or invalid. */
export function parsePages(spec: string | undefined): number[] | undefined {
  if (!spec || typeof spec !== 'string') return undefined;
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && out.size < 50; i++) if (i >= 1) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : undefined;
}

export interface TreeNode {
  name: string;
  path: string;
  files: number;
  bytes: number;
  children: TreeNode[];
}

/** Builds a folder tree (counts include subfolders) from per-directory totals. */
export function aggregateTree(rows: Array<{ dir: string; files: number; bytes: number }>, depth: number): TreeNode {
  const root: TreeNode = { name: '', path: '', files: 0, bytes: 0, children: [] };
  for (const r of rows) {
    root.files += r.files;
    root.bytes += r.bytes;
    const parts = r.dir ? r.dir.split('/') : [];
    let node = root;
    for (let i = 0; i < Math.min(parts.length, depth); i++) {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path, files: 0, bytes: 0, children: [] };
        node.children.push(child);
      }
      child.files += r.files;
      child.bytes += r.bytes;
      node = child;
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}
