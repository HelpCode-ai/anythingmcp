import { ScimError } from './scim.errors';
import { SCIM_ENTERPRISE_USER_SCHEMA, SCIM_PATCH_SCHEMA } from './scim.schemas';

/**
 * Tolerant readers for what Entra actually sends.
 *
 * Pure functions, no DI, no DTO classes: the global ValidationPipe runs with
 * `forbidNonWhitelisted`, and Entra's payloads carry `schemas`, `meta`, the
 * enterprise extension URN and whatever else an admin mapped. A class-based
 * DTO would 400 real traffic on the first unexpected key.
 */

export type ScimFilter = {
  attr: 'userName' | 'externalId' | 'id' | 'displayName' | 'emails.value';
  value: string;
};

const FILTER_ATTRS: Record<string, ScimFilter['attr']> = {
  username: 'userName',
  externalid: 'externalId',
  id: 'id',
  displayname: 'displayName',
  'emails.value': 'emails.value',
  'emails[type eq "work"].value': 'emails.value',
};

/**
 * Only `<attr> eq "<value>"` is supported — the sole form Entra uses to look a
 * resource up. Anything else is `invalidFilter` rather than silently ignored,
 * because an ignored filter would return the whole list and Entra would treat
 * the first entry as the match.
 */
export function parseFilter(raw: string | undefined): ScimFilter | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const m = raw.trim().match(/^([A-Za-z.\[\]" =]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  if (!m) throw new ScimError(400, `Unsupported filter: ${raw}`, 'invalidFilter');
  const attr = FILTER_ATTRS[m[1].trim().toLowerCase()];
  if (!attr) throw new ScimError(400, `Unsupported filter attribute: ${m[1]}`, 'invalidFilter');
  return { attr, value: m[2].replace(/\\"/g, '"') };
}

export function parsePagination(q: Record<string, string | undefined>) {
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(1, Number.parseInt(q.count ?? '100', 10) || 100));
  return { startIndex, count };
}

export function parseExcluded(q: Record<string, string | undefined>): Set<string> {
  return new Set(
    (q.excludedAttributes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export type PatchOp = { op: 'add' | 'replace' | 'remove'; path?: string; value?: unknown };

/**
 * Normalises a PatchOp document:
 * - `op` is matched case-insensitively (Entra sends `Add`/`Replace`/`Remove`);
 * - a path-less add/replace whose value is an object is expanded to one op per
 *   attribute, with nested objects flattened to dotted paths and the
 *   enterprise URN kept as a prefix.
 */
export function parsePatch(body: unknown): PatchOp[] {
  if (!isRecord(body)) throw new ScimError(400, 'Request body must be an object', 'invalidSyntax');
  if (Array.isArray(body.schemas) && !body.schemas.includes(SCIM_PATCH_SCHEMA)) {
    throw new ScimError(400, `schemas must include ${SCIM_PATCH_SCHEMA}`, 'invalidSyntax');
  }
  const ops = body.Operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ScimError(400, 'Operations must be a non-empty array', 'invalidSyntax');
  }

  const out: PatchOp[] = [];
  for (const raw of ops) {
    if (!isRecord(raw)) throw new ScimError(400, 'Each operation must be an object', 'invalidSyntax');
    const op = String(raw.op ?? '').trim().toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new ScimError(400, `Unsupported op: ${String(raw.op)}`, 'invalidValue');
    }
    const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : undefined;

    if (!path && op !== 'remove' && isRecord(raw.value)) {
      for (const [k, v] of Object.entries(raw.value)) {
        if (k === SCIM_ENTERPRISE_USER_SCHEMA && isRecord(v)) {
          for (const [ek, ev] of Object.entries(v)) out.push({ op, path: `${k}:${ek}`, value: ev });
        } else if (isRecord(v) && !Array.isArray(v)) {
          for (const [nk, nv] of Object.entries(v)) out.push({ op, path: `${k}.${nk}`, value: nv });
        } else {
          out.push({ op, path: k, value: v });
        }
      }
      continue;
    }
    if (!path && op !== 'remove') {
      throw new ScimError(400, 'A path-less add/replace needs an object value', 'invalidValue');
    }
    out.push({ op, path, value: raw.value });
  }
  return out;
}

/** `true`/`false`, or the strings Entra sometimes sends (`"True"`, `"False"`). */
export function coerceActive(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  throw new ScimError(400, `active must be a boolean, got ${JSON.stringify(v)}`, 'invalidValue');
}

export interface ParsedUser {
  userName: string;
  externalId?: string;
  active: boolean;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  formattedName?: string;
  /** Lowercased. primary > type=work > first. */
  primaryEmail?: string;
}

export function readUser(body: unknown): ParsedUser {
  if (!isRecord(body)) throw new ScimError(400, 'Request body must be an object', 'invalidSyntax');
  const userName = typeof body.userName === 'string' ? body.userName.trim() : '';
  if (!userName) throw new ScimError(400, 'userName is required', 'invalidValue');
  const name = isRecord(body.name) ? body.name : {};
  return {
    userName,
    externalId: optString(body.externalId),
    active: body.active === undefined ? true : coerceActive(body.active),
    displayName: optString(body.displayName),
    givenName: optString(name.givenName),
    familyName: optString(name.familyName),
    formattedName: optString(name.formatted),
    primaryEmail: pickEmail(body.emails),
  };
}

export function pickEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const entries = emails.filter(isRecord).filter((e) => typeof e.value === 'string' && e.value.trim());
  const chosen =
    entries.find((e) => e.primary === true || e.primary === 'true') ??
    entries.find((e) => String(e.type ?? '').toLowerCase() === 'work') ??
    entries[0];
  return chosen ? String(chosen.value).trim().toLowerCase() : undefined;
}

/** A display name for the `users.name` column, from whatever Entra sent. */
export function displayNameOf(u: Pick<ParsedUser, 'displayName' | 'formattedName' | 'givenName' | 'familyName'>): string | null {
  const joined = [u.givenName, u.familyName].filter(Boolean).join(' ').trim();
  return u.displayName || u.formattedName || joined || null;
}

/** `members[value eq "<id>"]` → `<id>`. */
export function memberIdFromPath(path: string | undefined): string | null {
  const m = path?.match(/^members\[value\s+eq\s+"([^"]+)"\]$/i);
  return m ? m[1] : null;
}

export function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
