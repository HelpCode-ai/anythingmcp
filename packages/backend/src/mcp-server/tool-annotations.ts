/**
 * MCP tool annotations (spec: ToolAnnotations).
 *
 * Annotations are *hints* that let an agent reason about a tool before calling
 * it — most importantly `readOnlyHint`, which tells the agent "this one cannot
 * change anything, probe it freely". They are advisory by design: the spec is
 * explicit that clients must not make trust decisions based on them, so nothing
 * here is a security control (real enforcement stays in roles/tool access).
 *
 * We derive them from signals we already hold per tool — the HTTP verb for
 * REST, query/mutation for GraphQL, the connector's readOnly flag and the SQL
 * text for databases — and let an explicit value override the derivation.
 *
 * Derivation is deliberately CONSERVATIVE about `readOnlyHint`: we only claim
 * read-only when the protocol says so (GET, GraphQL query, SELECT, …). Wrongly
 * claiming read-only would invite an agent to call a mutating tool freely,
 * whereas wrongly omitting it only makes the agent more careful. Name-based
 * guessing is therefore used to *soften* `destructiveHint`, never to assert
 * read-only — the classic `POST /search` case is handled by the per-tool
 * override instead of a guess.
 */

export interface ToolAnnotations {
  /** Human-readable title for display. */
  title?: string;
  /** True = the tool does not modify its environment. Spec default: false. */
  readOnlyHint?: boolean;
  /**
   * True = may perform destructive updates; false = additive only.
   * Spec default: true. Meaningful only when readOnlyHint is false.
   */
  destructiveHint?: boolean;
  /**
   * True = repeated identical calls have no additional effect.
   * Spec default: false. Meaningful only when readOnlyHint is false.
   */
  idempotentHint?: boolean;
  /** True = interacts with an "open world" of external entities. Spec default: true. */
  openWorldHint?: boolean;
}

/** Minimal tool shape needed to derive annotations (works for both MCP surfaces). */
export interface AnnotationSource {
  name: string;
  connectorType: string;
  endpointMapping?: { method?: string; path?: string } | null;
  /** connector-level settings; `readOnly` is set for DATABASE connectors */
  connectorConfig?: { config?: Record<string, unknown> | null } | null;
  /**
   * Explicit annotations that win over the derived ones: either a user override
   * or, for MCP-proxy tools, the annotations reported by the upstream server.
   */
  annotations?: unknown;
}

const ANNOTATION_KEYS = [
  'title',
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

// Verbs that only ever read. OPTIONS/HEAD included for completeness.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Write verbs → [destructive, idempotent]. POST is additive by convention
// (create/append); PUT/DELETE replace-or-remove and are idempotent; PATCH
// mutates in place without that guarantee.
const WRITE_METHODS: Record<string, { destructive: boolean; idempotent: boolean }> = {
  POST: { destructive: false, idempotent: false },
  PUT: { destructive: true, idempotent: true },
  PATCH: { destructive: true, idempotent: false },
  DELETE: { destructive: true, idempotent: true },
};

// Name fragments that mark a write as merely additive rather than destructive.
const ADDITIVE_NAME_HINTS = [
  'create',
  'add',
  'insert',
  'new',
  'append',
  'upload',
  'submit',
  'send',
  'register',
  'invite',
  'start',
  'open',
];

// Name fragments that mark a write as destructive (removes or overwrites data).
const DESTRUCTIVE_NAME_HINTS = [
  'delete',
  'remove',
  'drop',
  'purge',
  'destroy',
  'truncate',
  'revoke',
  'cancel',
  'archive',
  'deactivate',
  'disable',
  'reset',
  'clear',
  'overwrite',
  'replace',
];

// SQL keywords that mean the statement writes. Checked as whole words anywhere
// in the statement so a CTE ending in an INSERT is not mistaken for a read.
const SQL_WRITE_RE =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|upsert|grant|revoke|call|do)\b/i;
const SQL_READ_START_RE = /^\s*(with|select|show|explain|describe|desc|pragma|table|values)\b/i;

/** `get_customer_orders` / `getCustomerOrders` → `Get customer orders`. */
function humanizeName(name: string): string {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function nameSuggestsDestructive(name: string): boolean | undefined {
  const lower = name.toLowerCase();
  if (DESTRUCTIVE_NAME_HINTS.some((h) => lower.includes(h))) return true;
  if (ADDITIVE_NAME_HINTS.some((h) => lower.includes(h))) return false;
  return undefined;
}

/** Read-only verdict for a SQL/Mongo statement, or undefined when unclear. */
function sqlIsReadOnly(statement: string | undefined): boolean | undefined {
  if (!statement || typeof statement !== 'string') return undefined;
  // Strip line and block comments so `-- delete stuff` can't flip the verdict.
  const sql = statement
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (SQL_WRITE_RE.test(sql)) return false;
  if (SQL_READ_START_RE.test(sql)) return true;
  return undefined;
}

/** Keep only known annotation keys with well-typed values. */
function sanitize(raw: unknown): ToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: ToolAnnotations = {};
  for (const key of ANNOTATION_KEYS) {
    const value = src[key];
    if (key === 'title') {
      if (typeof value === 'string' && value.trim()) out.title = value.trim();
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Derive annotations from what the connector already tells us. Returns only the
 * hints we can actually justify — an omitted hint means "spec default", which
 * is the safe reading in every case.
 */
function derive(tool: AnnotationSource): ToolAnnotations {
  const type = (tool.connectorType || '').toUpperCase();
  const rawMethod = tool.endpointMapping?.method;
  const method = typeof rawMethod === 'string' ? rawMethod.trim() : '';
  const annotations: ToolAnnotations = { title: humanizeName(tool.name) };

  // A database or a static payload is a closed domain; everything else talks
  // to an external system we cannot bound.
  const closedWorld = type === 'DATABASE';
  annotations.openWorldHint = !closedWorld;

  let readOnly: boolean | undefined;
  let destructive: boolean | undefined;
  let idempotent: boolean | undefined;

  switch (type) {
    case 'REST':
    case 'WEBHOOK': {
      const verb = method.toUpperCase();
      if (READ_METHODS.has(verb)) {
        readOnly = true;
      } else if (WRITE_METHODS[verb]) {
        readOnly = false;
        const byVerb = WRITE_METHODS[verb];
        // The verb sets the baseline; an unambiguous name can correct it
        // (e.g. `delete_user` exposed as POST is destructive, not additive).
        destructive = nameSuggestsDestructive(tool.name) ?? byVerb.destructive;
        idempotent = byVerb.idempotent;
      }
      break;
    }

    case 'GRAPHQL': {
      const op = method.toLowerCase();
      if (op === 'query') {
        readOnly = true;
      } else if (op === 'mutation' || op === 'subscription') {
        readOnly = false;
        destructive = nameSuggestsDestructive(tool.name);
        idempotent = false;
      }
      break;
    }

    case 'DATABASE': {
      // `static` returns a canned payload — it cannot touch anything.
      if (method === 'static') {
        readOnly = true;
        break;
      }
      if (method === 'mongo_schema') {
        readOnly = true;
        break;
      }
      // A read-only connector cannot write regardless of the statement.
      const connectorReadOnly = tool.connectorConfig?.config?.readOnly;
      if (connectorReadOnly === true) {
        readOnly = true;
        break;
      }
      const byStatement = sqlIsReadOnly(tool.endpointMapping?.path);
      if (byStatement !== undefined) {
        readOnly = byStatement;
        if (!byStatement) {
          destructive = nameSuggestsDestructive(tool.name);
          idempotent = false;
        }
      }
      break;
    }

    case 'SOAP':
    case 'MCP':
    default: {
      // SOAP operation names and remote MCP tool names carry no verb
      // semantics. Never assert read-only here; at most flag a write we can
      // name with confidence, so agents still get the destructive signal.
      const byName = nameSuggestsDestructive(tool.name);
      if (byName === true) {
        readOnly = false;
        destructive = true;
      }
      break;
    }
  }

  if (readOnly !== undefined) annotations.readOnlyHint = readOnly;
  // destructive/idempotent are meaningful only for writes — emitting them
  // alongside readOnlyHint:true would be noise the spec tells clients to ignore.
  if (readOnly === false) {
    if (destructive !== undefined) annotations.destructiveHint = destructive;
    if (idempotent !== undefined) annotations.idempotentHint = idempotent;
  }

  return annotations;
}

/**
 * Annotations to advertise for a tool: derived from the connector, with any
 * explicit annotations (user override, or upstream MCP server) layered on top.
 */
export function deriveToolAnnotations(tool: AnnotationSource): ToolAnnotations {
  const explicit = sanitize(tool.annotations);
  const derived = derive(tool);
  if (!explicit) return derived;
  const merged = { ...derived, ...explicit };
  // An override that flips the tool to read-only must not leave stale
  // write-only hints behind.
  if (merged.readOnlyHint === true) {
    delete merged.destructiveHint;
    delete merged.idempotentHint;
  }
  return merged;
}

/** Stable string form, so a change in annotations invalidates a session's tool set. */
export function annotationsSignature(annotations: ToolAnnotations): string {
  return ANNOTATION_KEYS.filter((k) => annotations[k] !== undefined)
    .map((k) => `${k}=${String(annotations[k])}`)
    .join('|');
}

/** Validate a user-supplied override, rejecting unknown keys and bad types. */
export function parseAnnotationsOverride(raw: unknown): ToolAnnotations | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('annotations must be an object');
  }
  const src = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(src).filter(
    (k) => !(ANNOTATION_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown annotation keys: ${unknownKeys.join(', ')}. Allowed: ${ANNOTATION_KEYS.join(', ')}`,
    );
  }
  for (const key of ANNOTATION_KEYS) {
    if (src[key] === undefined || src[key] === null) continue;
    if (key === 'title') {
      if (typeof src[key] !== 'string') throw new Error('title must be a string');
    } else if (typeof src[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`);
    }
  }
  return sanitize(src) ?? null;
}
