import { ODataEntityType } from './edmx.parser';

/**
 * Pure helpers for the OData engine: turning a service's JSON into plain rows,
 * building key predicates, and refusing service paths that could leave the
 * connector's host.
 */

/** V2 `/Date(1719792000000)/` or `/Date(1719792000000+0120)/` → ISO 8601. */
const V2_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

export function normalizeODataValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = V2_DATE.exec(value);
    if (m) {
      const ms = Number(m[1]);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeODataValue);
  if (value && typeof value === 'object') return normalizeODataRecord(value as Record<string, unknown>);
  return value;
}

/**
 * Drop protocol noise an agent does not need (`__metadata`, deferred
 * navigation stubs, `@odata.*` control information) and unwrap V2's
 * `{ results: [...] }` around expanded collections.
 */
export function normalizeODataRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === '__metadata') continue;
    if (k.startsWith('@odata.') || k.includes('@odata.')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if ('__deferred' in obj) continue;
      if (Array.isArray(obj.results) && Object.keys(obj).every((x) => x === 'results' || x === '__next' || x === '__count')) {
        out[k] = obj.results.map(normalizeODataValue);
        continue;
      }
    }
    out[k] = normalizeODataValue(v);
  }
  return out;
}

export interface ODataPage {
  rows: Record<string, unknown>[];
  count?: number;
  nextLink?: string;
}

/** Rows, total count and next link out of a V2 (`d`) or V4 (`value`) body. */
export function readODataPage(body: unknown): ODataPage {
  if (!body || typeof body !== 'object') return { rows: [] };
  const b = body as Record<string, any>;
  if (b.d !== undefined) {
    const d = b.d;
    if (Array.isArray(d)) return { rows: d.map((r) => normalizeODataRecord(r)) };
    if (Array.isArray(d?.results)) {
      return {
        rows: d.results.map((r: Record<string, unknown>) => normalizeODataRecord(r)),
        count: d.__count !== undefined ? Number(d.__count) : undefined,
        nextLink: typeof d.__next === 'string' ? d.__next : undefined,
      };
    }
    return { rows: [normalizeODataRecord(d)] };
  }
  if (Array.isArray(b.value)) {
    return {
      rows: b.value.map((r: Record<string, unknown>) => normalizeODataRecord(r)),
      count: b['@odata.count'] !== undefined ? Number(b['@odata.count']) : undefined,
      nextLink: typeof b['@odata.nextLink'] === 'string' ? b['@odata.nextLink'] : undefined,
    };
  }
  return { rows: [normalizeODataRecord(b)] };
}

/**
 * A service path the agent may address, relative to the connector's host:
 * `/sap/opu/odata/sap/API_BUSINESS_PARTNER`, `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2`.
 * Absolute URLs, protocol-relative `//host`, `..` segments, query strings and
 * fragments are refused, so a model can never point the connector's
 * credentials at another host.
 */
export function assertSafeServicePath(service: string): string {
  const s = service.trim();
  if (s === '') return '';
  if (!s.startsWith('/') || s.startsWith('//')) {
    throw new Error(`Service "${service}" must be a path starting with "/", as listed by the service catalog.`);
  }
  if (!/^[A-Za-z0-9_\-/;=.,~]+$/.test(s) || s.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`Service "${service}" is not a valid OData service path.`);
  }
  return s.replace(/\/+$/, '');
}

/** Glob match for the `services` allow-list (`*` any run of characters). */
export function serviceAllowed(service: string, allow?: unknown): boolean {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  const norm = (p: string) => p.trim().replace(/\/+$/, '').toLowerCase();
  const s = norm(service);
  return allow.some((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim()) return false;
    const re = new RegExp(
      '^' + norm(pattern).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return re.test(s);
  });
}

/** A single key value as an OData literal of the property's type. */
export function formatKeyLiteral(value: unknown, edmType: string, version: 'v2' | 'v4'): string {
  const v = String(value);
  switch (edmType) {
    case 'Edm.String':
      return `'${v.replace(/'/g, "''")}'`;
    case 'Edm.Guid':
      return version === 'v2' ? `guid'${v}'` : v;
    case 'Edm.DateTime':
      return `datetime'${v}'`;
    case 'Edm.DateTimeOffset':
      return version === 'v2' ? `datetimeoffset'${v}'` : v;
    case 'Edm.Int64':
      return version === 'v2' ? `${v}L` : v;
    case 'Edm.Decimal':
      return version === 'v2' ? `${v}M` : v;
    default:
      if (/^-?\d+(\.\d+)?$/.test(v)) return v;
      return `'${v.replace(/'/g, "''")}'`;
  }
}

/**
 * Key predicate for an entity: `('4711')` for a single key, or
 * `(SalesOrder='1',SalesOrderItem='10')` for a composite one. `key` may be a
 * plain value (single key), an object of key → value, or an already-written
 * predicate such as `SalesOrder='1',SalesOrderItem='10'`.
 */
export function buildKeyPredicate(
  key: unknown,
  type: ODataEntityType,
  version: 'v2' | 'v4',
): string {
  const typeOf = (name: string) => type.properties.find((p) => p.name === name)?.type ?? 'Edm.String';
  let values: Record<string, unknown>;
  if (key && typeof key === 'object' && !Array.isArray(key)) {
    values = key as Record<string, unknown>;
  } else {
    const raw = String(key ?? '').trim();
    if (raw.startsWith('{')) {
      try {
        values = JSON.parse(raw);
      } catch {
        throw new Error('key looks like JSON but does not parse.');
      }
    } else if (type.keys.length > 1 || looksLikePredicate(raw)) {
      // Pre-written predicate; validate the names, keep the literals as given.
      if (raw.length > 2000) throw new Error('key is too long.');
      const names = raw
        .split(',')
        .map((part) => part.slice(0, part.indexOf('=')).trim())
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      const unknown = names.filter((n) => !type.keys.includes(n));
      if (names.length === 0 || unknown.length) {
        throw new Error(
          `This entity has the key ${type.keys.join(', ')}; pass key as an object such as ` +
            `{${type.keys.map((k) => `"${k}": "…"`).join(', ')}}.`,
        );
      }
      if (/[()/?#]/.test(raw)) throw new Error('key must not contain ( ) / ? or #.');
      return `(${raw})`;
    } else {
      return `(${formatKeyLiteral(raw, typeOf(type.keys[0]), version)})`;
    }
  }
  const missing = type.keys.filter((k) => values[k] === undefined);
  if (missing.length) throw new Error(`key is missing ${missing.join(', ')}.`);
  if (type.keys.length === 1) {
    return `(${formatKeyLiteral(values[type.keys[0]], typeOf(type.keys[0]), version)})`;
  }
  return `(${type.keys.map((k) => `${k}=${formatKeyLiteral(values[k], typeOf(k), version)}`).join(',')})`;
}

/** `Name=…` at the start, checked without a backtracking regex. */
function looksLikePredicate(raw: string): boolean {
  const eq = raw.indexOf('=');
  return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.slice(0, eq).trim());
}

/** Closest names by edit distance, for "did you mean" hints. */
export function closest(name: string, candidates: string[], max = 3): string[] {
  const d = (a: string, b: string) => {
    a = a.toLowerCase();
    b = b.toLowerCase();
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  };
  return candidates
    .map((c) => ({ c, s: c.toLowerCase().includes(name.toLowerCase()) ? 0 : d(name, c) }))
    .sort((x, y) => x.s - y.s)
    .slice(0, max)
    .map((x) => x.c);
}
