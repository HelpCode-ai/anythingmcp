/**
 * Learning from calls that failed and then worked: a failed call followed,
 * shortly after, by a successful call of the same tool by the same person
 * with different arguments. Only argument NAMES and the FORMAT of values are
 * kept (`12.10.2026` → `99.99.9999`), never the values, so the result can be
 * stored and shown without carrying personal data.
 */

/** A failed call is "fixed" by a success within this window. */
export const FIX_WINDOW_MS = 10 * 60 * 1000;
/** A pattern becomes a proposal once seen this many times. */
export const FIX_MIN_OCCURRENCES = 2;

export interface CallRow {
  toolId: string;
  userId: string | null;
  status: string;
  input: unknown;
  error: string | null;
  createdAt: Date;
}

export interface ArgChange {
  key: string;
  before: string;
  after: string;
}

export interface FixPattern {
  toolId: string;
  /** Stable key of the change (tool + argument names + formats). */
  signature: string;
  changes: ArgChange[];
  occurrences: number;
  users: number;
  /** The most recent error text (the caller redacts it). */
  error: string | null;
}

/**
 * The format of a value, without the value: digits → 9, letters → a, other
 * characters kept, for short strings; a type and length otherwise.
 */
export function shapeOf(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (Array.isArray(value)) return `list(${value.length ? shapeOf(value[0]) : 'empty'})`;
  if (typeof value === 'object') return `object{${Object.keys(value as object).sort().slice(0, 6).join(',')}}`;
  const s = String(value);
  if (s.length === 0) return 'empty text';
  if (s.length > 24) return `text(${s.length > 200 ? '200+' : s.length} chars)`;
  return `"${s.replace(/[0-9]/g, '9').replace(/\p{L}/gu, 'a')}"`;
}

/** Top-level arguments whose format changed between two calls. */
export function diffArgs(before: unknown, after: unknown): ArgChange[] {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !k.startsWith('_')).sort();
  const changes: ArgChange[] = [];
  for (const key of keys) {
    const sa = shapeOf(a[key]);
    const sb = shapeOf(b[key]);
    if (sa !== sb) changes.push({ key, before: sa, after: sb });
  }
  return changes;
}

/**
 * Patterns of failed-then-fixed calls. `rows` must be sorted by user, tool and
 * time. A failure counts once, with the first success that follows it in the
 * window; pairs whose arguments keep the same formats (a retry, or a fix in
 * the values only) say nothing about formats and are skipped.
 */
export function findFixPatterns(rows: CallRow[], minOccurrences = FIX_MIN_OCCURRENCES): FixPattern[] {
  const byKey = new Map<string, { pattern: FixPattern; users: Set<string> }>();
  for (let i = 0; i < rows.length - 1; i++) {
    const failed = rows[i];
    if (failed.status === 'SUCCESS' || !failed.userId) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next.userId !== failed.userId || next.toolId !== failed.toolId) break;
      if (next.createdAt.getTime() - failed.createdAt.getTime() > FIX_WINDOW_MS) break;
      if (next.status !== 'SUCCESS') continue;
      const changes = diffArgs(failed.input, next.input);
      if (changes.length && changes.length <= 4) {
        const signature = `${failed.toolId}|${changes.map((c) => `${c.key}:${c.before}>${c.after}`).join('|')}`;
        const hit = byKey.get(signature) ?? {
          pattern: { toolId: failed.toolId, signature, changes, occurrences: 0, users: 0, error: null },
          users: new Set<string>(),
        };
        hit.pattern.occurrences++;
        hit.pattern.error = failed.error ?? hit.pattern.error;
        hit.users.add(failed.userId);
        byKey.set(signature, hit);
      }
      break;
    }
  }
  return [...byKey.values()]
    .map(({ pattern, users }) => ({ ...pattern, users: users.size }))
    .filter((p) => p.occurrences >= minOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
