/**
 * "Did you mean" for an Odoo field that does not exist.
 *
 * WHY. Field names change between Odoo versions (`tax_id` became `tax_ids`,
 * `product_uom` became `product_uom_id`, `groups_id` became `group_ids`) and
 * with the installed apps, and a model writes the name it knows. In the week
 * of 8-15 Nov 2026 a third of all failed Odoo calls were such a name: 1,047
 * calls in 152 workspaces. The hint so far told the assistant to list the
 * model's fields first, which costs one more call (several hundred fields)
 * before the retry. The pipeline now asks Odoo for that list itself and names
 * the few fields that are close to the one asked for.
 *
 * Everything here is pure; the pipeline (dynamic-mcp-tools.ts) does the one
 * `fields_get` call, with the connector's own credentials, and caches it.
 */

/** What Odoo said does not exist. */
export interface OdooInvalidField {
  field: string;
  /** The model Odoo named. Absent in some messages: the caller's `model` argument then. */
  model?: string;
}

export interface OdooField {
  name: string;
  /** The field's label in the Odoo UI (`string`). */
  label?: string;
  type?: string;
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const MODEL = '[a-z_][a-z0-9_]*(?:\\.[a-z0-9_]+)+';

/**
 * The field and model of an "Invalid field" refusal, in the wordings Odoo
 * uses: `Invalid field 'x' on 'model'` (JSON-2), `Invalid field 'x' on model
 * 'model'` (JSON-RPC) and `Invalid field model.x in leaf (...)` (a domain).
 */
export function parseOdooInvalidField(text: string): OdooInvalidField | undefined {
  if (!text) return undefined;
  const quoted = new RegExp(`Invalid field '(${NAME})' (?:on|in)(?: model)? '(${MODEL})'`).exec(text);
  if (quoted) return { field: quoted[1], model: quoted[2] };
  const leaf = new RegExp(`Invalid field (${MODEL})\\.(${NAME}) in leaf`).exec(text);
  if (leaf) return { field: leaf[2], model: leaf[1] };
  const bare = new RegExp(`Invalid field '(${NAME})'`).exec(text);
  if (bare) return { field: bare[1] };
  return undefined;
}

/** A technical model name, safe to put in a request path or body. */
export function isOdooModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && new RegExp(`^${MODEL}$`).test(value);
}

/**
 * The fields of a `fields_get` answer. JSON-2 returns the map itself; JSON-RPC
 * wraps it in `result`. Anything else yields an empty list.
 */
export function odooFieldsFromFieldsGet(body: unknown): OdooField[] {
  let map: unknown = body;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const wrapped = (map as { result?: unknown }).result;
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) && 'jsonrpc' in (map as object)) {
      map = wrapped;
    }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const fields: OdooField[] = [];
  for (const [name, info] of Object.entries(map as Record<string, unknown>)) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    const { string: label, type } = info as { string?: unknown; type?: unknown };
    fields.push({
      name,
      ...(typeof label === 'string' && label ? { label } : {}),
      ...(typeof type === 'string' && type ? { type } : {}),
    });
  }
  return fields;
}

/** `tax_ids` and `taxes_id` both become [`tax`]: the words of a name, without plural and relation endings. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'id' && w !== 'ids')
    .map((w) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/** Levenshtein distance, capped: names here are short. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(up + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = up;
    }
  }
  return prev[b.length];
}

/** 0..1: how close a field of the model is to the name that was asked for. */
function closeness(wanted: string, field: OdooField): number {
  const name = field.name.toLowerCase();
  const spelling = 1 - distance(wanted, name) / Math.max(wanted.length, name.length);

  const wantedWords = words(wanted);
  const nameWords = words(name);
  const shared = wantedWords.filter((w) => nameWords.includes(w)).length;
  const sameWords =
    wantedWords.length && nameWords.length ? shared / Math.max(wantedWords.length, nameWords.length) : 0;

  // `product_uom` asked, `product_uom_id` exists (or the other way round).
  const prefix = name.startsWith(`${wanted}_`) || wanted.startsWith(`${name}_`) ? 0.85 : 0;

  // The label: `mobile` asked on a model whose `phone` is labelled "Mobile".
  const labelWords = words(field.label ?? '');
  const inLabel =
    wantedWords.length && wantedWords.every((w) => labelWords.includes(w)) ? 0.6 : 0;

  return Math.max(spelling, sameWords * 0.9, prefix, inLabel);
}

/** Below this a field is not worth naming: it would only invite another wrong guess. */
const MIN_CLOSENESS = 0.55;

/** The fields of the model closest to `wanted`, best first. */
export function rankOdooFieldSuggestions(wanted: string, fields: OdooField[], limit = 5): OdooField[] {
  const target = wanted.toLowerCase();
  return fields
    .filter((f) => f.name.toLowerCase() !== target)
    .map((field) => ({ field, score: closeness(target, field) }))
    .filter((c) => c.score >= MIN_CLOSENESS)
    .sort((a, b) => b.score - a.score || a.field.name.length - b.field.name.length || a.field.name.localeCompare(b.field.name))
    .slice(0, limit)
    .map((c) => c.field);
}

function describe(field: OdooField): string {
  const label = field.label && field.label.length <= 60 ? `"${field.label.replace(/["`]/g, '')}"` : undefined;
  const detail = [field.type, label].filter(Boolean).join(', ');
  return detail ? `\`${field.name}\` (${detail})` : `\`${field.name}\``;
}

/**
 * The hint for a field that does not exist, from the model's real fields.
 * `undefined` when the list is empty (the lookup told us nothing).
 */
export function odooFieldAdvice(wanted: string, model: string, fields: OdooField[]): string | undefined {
  if (fields.length === 0) return undefined;
  // Odoo refused a name the model does have: not a spelling problem, so do not suggest neighbours.
  if (fields.some((f) => f.name === wanted)) return undefined;
  const close = rankOdooFieldSuggestions(wanted, fields);
  const head = `\`${wanted}\` is not a field of ${model} in this Odoo database (field names change between Odoo versions and with the installed apps).`;
  if (close.length === 0) {
    return (
      `${head} None of its ${fields.length} fields has a similar name. Do not try another spelling: ` +
      'leave the field out, or call odoo_fields_get on the model and pick from what it returns.'
    );
  }
  return (
    `${head} Fields that do exist and are close: ${close.map(describe).join(', ')}. ` +
    'Call again with the one that fits what the user asked for, or without the field. ' +
    `odoo_fields_get lists all ${fields.length} fields of the model.`
  );
}
