import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface SchemaSliceOptions {
  /** Single type name to retrieve (returns the full block definition). */
  type?: string;
  /** Case-insensitive substring matched against type and field names. */
  search?: string;
  /** Return the entire SDL — typically too large for an agent's context. */
  full?: boolean;
}

/**
 * Fetches a GraphQL SDL schema from a remote URL, caches it server-side, and
 * returns task-sized slices of it on demand.
 *
 * Why slices: Sorare's SDL is ~800 KB / ~200K tokens — too large to pass through
 * an MCP agent's context window on every call. Agents typically need only the
 * Query/Mutation roots plus 2–5 specific type definitions to compose a query.
 *
 * The service handles three modes:
 *   - default          → Query + Mutation + Subscription blocks + a flat list of all type names
 *   - { type: "X" }    → just the block defining type X (a few KB)
 *   - { search: "foo" }→ all types/fields whose names match (case-insensitive substring)
 *   - { full: true }   → the entire SDL (advanced; large)
 */
@Injectable()
export class GraphqlSchemaService {
  private readonly logger = new Logger(GraphqlSchemaService.name);
  private cache = new Map<string, { sdl: string; fetchedAt: number }>();

  async getSlice(
    url: string,
    opts: SchemaSliceOptions = {},
  ): Promise<string> {
    const sdl = await this.fetchSchema(url);
    if (opts.full) return sdl;
    if (opts.type && opts.type.trim()) return this.extractType(sdl, opts.type.trim());
    if (opts.search && opts.search.trim()) return this.search(sdl, opts.search.trim());
    return this.summary(sdl);
  }

  private async fetchSchema(url: string): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < DEFAULT_CACHE_TTL_MS) {
      return cached.sdl;
    }
    await assertSafeOutboundUrl(url);
    this.logger.debug(`GraphQL schema cache miss, fetching: ${url}`);
    const res = await axios.get<string>(url, {
      timeout: 30000,
      responseType: 'text',
      transformResponse: (v: unknown) => String(v),
    });
    const sdl = String(res.data);
    this.cache.set(url, { sdl, fetchedAt: Date.now() });
    return sdl;
  }

  /**
   * Return the block of SDL that defines a named type. Walks the file line by
   * line so we don't need a full GraphQL parser dependency — works for `type`,
   * `interface`, `input`, `enum` (brace-delimited) plus `union`, `scalar`,
   * `directive` (single-line). Includes the preceding `"""…"""` docblock when
   * present so the agent gets the human-readable description too.
   */
  private extractType(sdl: string, typeName: string): string {
    const lines = sdl.split('\n');
    const blockHead = new RegExp(
      `^(?:type|interface|input|enum)\\s+${escapeRegex(typeName)}(?:\\s+implements\\b[^{]*)?(?:\\s+@\\w+\\([^)]*\\))*\\s*\\{`,
    );
    const singleLine = new RegExp(
      `^(?:union\\s+${escapeRegex(typeName)}\\b|scalar\\s+${escapeRegex(typeName)}\\b|directive\\s+@${escapeRegex(typeName)}\\b)`,
    );

    for (let i = 0; i < lines.length; i++) {
      if (singleLine.test(lines[i])) {
        return this.withDocblock(lines, i, i);
      }
      if (blockHead.test(lines[i])) {
        // Walk forward to find the matching closing brace.
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
          }
          if (depth === 0 && j > i) {
            return this.withDocblock(lines, i, j);
          }
        }
      }
    }
    return `# Type "${typeName}" not found in schema. Try search:"…" or full:true.`;
  }

  /**
   * Prepend the """…""" docblock immediately above the start line, if any.
   */
  private withDocblock(lines: string[], start: number, end: number): string {
    let docStart = start;
    // Walk backwards over a contiguous block of `"""` / doc text.
    if (start > 0 && lines[start - 1].trimEnd().endsWith('"""')) {
      // Single-line `"""…"""` or multi-line ending here.
      // Walk back to find the opening `"""`.
      for (let k = start - 1; k >= 0; k--) {
        if (lines[k].trimStart().startsWith('"""')) {
          // If this line both opens and closes (single line), stop here.
          const t = lines[k].trim();
          if (k !== start - 1 && t.startsWith('"""') && t !== '"""') {
            docStart = k;
            break;
          }
          if (k === start - 1 && t.startsWith('"""') && t.endsWith('"""') && t.length > 6) {
            docStart = k;
            break;
          }
          // Multi-line: this is the opening line.
          if (k !== start - 1) {
            docStart = k;
            break;
          }
        }
      }
    }
    return lines.slice(docStart, end + 1).join('\n');
  }

  /**
   * Return a compact summary: Query / Mutation / Subscription blocks + a flat
   * list of every named top-level type. The agent uses this to figure out which
   * type to drill into next via `type: "…"`.
   */
  private summary(sdl: string): string {
    const parts: string[] = ['# Schema summary'];
    for (const root of ['Query', 'Mutation', 'Subscription']) {
      const block = this.extractType(sdl, root);
      if (!block.startsWith('# Type')) parts.push(block);
    }

    const typeNames = new Set<string>();
    for (const m of sdl.matchAll(
      /^(?:type|interface|input|enum|union|scalar)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    )) {
      typeNames.add(m[1]);
    }
    const list = Array.from(typeNames).sort();
    parts.push(
      `# ${list.length} types available. Re-call with type:"TypeName" to retrieve a specific definition.`,
      list.join(', '),
    );
    return parts.join('\n\n');
  }

  /**
   * Find every type whose name OR a field name contains the search term.
   * Returns matched type blocks joined; capped to avoid token blow-up.
   */
  private search(sdl: string, term: string): string {
    const needle = term.toLowerCase();
    const lines = sdl.split('\n');
    const matchedTypes = new Set<string>();

    let currentType: string | null = null;
    let depth = 0;
    for (const line of lines) {
      const head = line.match(
        /^(?:type|interface|input|enum|union|scalar|directive\s+@)\s*([A-Za-z_][A-Za-z0-9_]*)/,
      );
      if (head && depth === 0) {
        currentType = head[1];
        if (currentType.toLowerCase().includes(needle)) matchedTypes.add(currentType);
      }
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (currentType && depth > 0) {
        const fieldMatch = line.match(/^\s+([a-z_][A-Za-z0-9_]*)\s*(\(|:)/);
        if (fieldMatch && fieldMatch[1].toLowerCase().includes(needle)) {
          matchedTypes.add(currentType);
        }
      }
    }

    if (matchedTypes.size === 0) {
      return `# No types or fields matched "${term}".`;
    }

    const MAX_TYPES = 12;
    const matched = Array.from(matchedTypes);
    const slice = matched.slice(0, MAX_TYPES);
    const blocks = slice.map((t) => this.extractType(sdl, t));
    const header = `# ${matched.length} types matched "${term}"${
      matched.length > MAX_TYPES
        ? ` (showing first ${MAX_TYPES}; refine the search to see more)`
        : ''
    }: ${matched.join(', ')}`;
    return [header, ...blocks].join('\n\n');
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
