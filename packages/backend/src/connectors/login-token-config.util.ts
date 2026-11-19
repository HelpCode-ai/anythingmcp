import { BadRequestException } from '@nestjs/common';
import { isSecretValue, maskHeaders, secretContext } from './connector-secrets.util';
import { describeInvalidHeaderNames, invalidConnectorHeaderNames } from '../common/http-header-name.util';

/**
 * The Login → Token (LOGIN_TOKEN) settings the connector editor shows and
 * changes, read from and merged into the encrypted authConfig.
 *
 * Same convention as the OAuth settings: secrets are never sent back. The
 * username and password come back as `hasUsername` / `hasPassword` only; a
 * login header that holds a stored secret comes back empty and is named in
 * `maskedLoginHeaders` (an empty value sent back keeps it); a login body that
 * carries a literal secret is not returned at all (`loginBodyHidden`).
 *
 * Every other authConfig field (headerName, headerTemplate, extraHeaders,
 * tokenSource, expiryJsonPath, passwordHashing …) is left as stored by a
 * save: the editor does not manage them, and a merge keeps them.
 */
export interface PublicLoginTokenConfig {
  loginUrl: string;
  loginMethod: string;
  /** The structured login body, or a string body, unless it is hidden. */
  loginBody?: unknown;
  /** True when a body is stored but carries a literal secret. */
  loginBodyHidden: boolean;
  /** A raw loginBodyTemplate is stored (the editor keeps it unless a body is typed). */
  hasLoginBodyTemplate: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
  /** '' = the whole response body; a list shows as its paths. */
  tokenJsonPath: string | string[];
  tokenSource: 'body' | 'cookie' | 'header';
  tokenTTLSeconds?: number;
  refreshOn401: boolean;
  loginHeaders: Record<string, string>;
  maskedLoginHeaders: string[];
}

/** Keys whose literal string value in a login body is a credential. */
const SECRET_BODY_KEY = /secret|passw|token|key|credential|private|signature|assertion|authorization|cookie|session|jwt|bearer|pin|otp/i;

/** A value that is only placeholders (`${password}`, `{{API_KEY}}`) and fixed text around them. */
function isReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^{}]+\}\}/.test(value);
}

/**
 * Whether a stored login body holds a literal credential: a string under a
 * credential-like key that is not a placeholder, or a value that is a
 * credential by its shape (a PEM key, `Bearer …`, a URL with a password).
 */
export function loginBodyHasLiteralSecret(body: unknown, key = ''): boolean {
  if (typeof body === 'string') {
    if (!body) return false;
    if (isSecretValue(body)) return true;
    if (key && SECRET_BODY_KEY.test(key) && !isReference(body)) return true;
    // A string body as a whole (XML, form): any credential-like name with a
    // literal value next to it is enough to hide it.
    if (!key && /(?:password|secret|token|api[_-]?key)\s*[=:>]\s*(?!\$\{|\{\{)[^\s&<"]{4,}/i.test(body)) return true;
    return false;
  }
  if (Array.isArray(body)) return body.some((item) => loginBodyHasLiteralSecret(item, key));
  if (body && typeof body === 'object') {
    return Object.entries(body as Record<string, unknown>).some(([k, v]) => loginBodyHasLiteralSecret(v, k));
  }
  return false;
}

/** The token path(s) as the editor shows them: '' for the whole body. */
function editableTokenPath(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string');
  if (typeof value !== 'string') return '';
  return value.trim() === '.' ? '' : value;
}

/** A login header is masked when its name or value marks a credential and it is not a `{{VAR}}` reference. */
function maskLoginHeaders(headers: unknown, connector: { config?: unknown; headers?: unknown }) {
  const ctx = secretContext(connector);
  const { headers: values, maskedHeaders } = maskHeaders(headers, ctx);
  return { loginHeaders: values ?? {}, maskedLoginHeaders: maskedHeaders };
}

export function toPublicLoginTokenConfig(
  cfg: Record<string, unknown>,
  connector: { config?: unknown; headers?: unknown } = {},
): PublicLoginTokenConfig {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const body = cfg.loginBody;
  const hidden = body !== undefined && loginBodyHasLiteralSecret(body);
  const tokenSource = cfg.tokenSource === 'cookie' || cfg.tokenSource === 'header' ? cfg.tokenSource : 'body';
  const ttl = typeof cfg.tokenTTLSeconds === 'number' && Number.isFinite(cfg.tokenTTLSeconds) ? cfg.tokenTTLSeconds : undefined;
  return {
    loginUrl: str(cfg.loginUrl),
    loginMethod: str(cfg.loginMethod).toUpperCase() || 'POST',
    ...(body !== undefined && !hidden ? { loginBody: body } : {}),
    loginBodyHidden: hidden,
    hasLoginBodyTemplate: typeof cfg.loginBodyTemplate === 'string' && cfg.loginBodyTemplate !== '',
    hasUsername: typeof cfg.username === 'string' && cfg.username !== '',
    hasPassword: typeof cfg.password === 'string' && cfg.password !== '',
    tokenJsonPath: editableTokenPath(cfg.tokenJsonPath),
    tokenSource,
    ...(ttl !== undefined ? { tokenTTLSeconds: ttl } : {}),
    refreshOn401: cfg.refreshOn401 !== false,
    ...maskLoginHeaders(cfg.loginHeaders, connector),
  };
}

/** The editable fields, as the PATCH route receives them. `undefined` = keep. */
export interface LoginTokenConfigPatch {
  loginUrl?: string;
  loginMethod?: string;
  /** A JSON value or string; null removes it. */
  loginBody?: unknown;
  /** Empty or null removes it. */
  username?: string | null;
  /** Empty or null removes it. */
  password?: string | null;
  /** '' (or '.') = the whole response body; a list is tried in order. */
  tokenJsonPath?: string | string[];
  /** null removes it (the 30-day default applies). */
  tokenTTLSeconds?: number | null;
  refreshOn401?: boolean;
  /**
   * The complete set of login headers: a name left out is removed. A masked
   * header sent back with an empty value keeps its stored value. null
   * removes them all.
   */
  loginHeaders?: Record<string, unknown> | null;
}

const LOGIN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);

/**
 * The authConfig after a patch of the editable fields: every other field kept
 * as stored, a removed field dropped. Throws BadRequestException for a value
 * the login could not use. Pure: the caller stores the result.
 */
export function mergeLoginTokenConfig(
  existing: Record<string, unknown>,
  patch: LoginTokenConfigPatch,
  connector: { config?: unknown; headers?: unknown } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const drop = (key: string) => {
    delete out[key];
  };

  if (patch.loginUrl !== undefined) {
    const url = String(patch.loginUrl).trim();
    if (!url) throw new BadRequestException('The login URL cannot be empty.');
    out.loginUrl = url;
  }
  if (patch.loginMethod !== undefined) {
    const method = String(patch.loginMethod).trim().toUpperCase() || 'POST';
    if (!LOGIN_METHODS.has(method)) {
      throw new BadRequestException('The login method must be GET, POST, PUT or PATCH.');
    }
    out.loginMethod = method;
  }
  if (patch.loginBody !== undefined) {
    if (patch.loginBody === null) drop('loginBody');
    else {
      out.loginBody = patch.loginBody;
      // A typed body replaces a raw template, which would otherwise be ignored.
      drop('loginBodyTemplate');
    }
  }
  for (const key of ['username', 'password'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === '') drop(key);
    else out[key] = value;
  }
  if (patch.tokenJsonPath !== undefined) {
    const paths = (Array.isArray(patch.tokenJsonPath) ? patch.tokenJsonPath : [patch.tokenJsonPath]).map((p) =>
      typeof p === 'string' ? p.trim() : p,
    );
    if (paths.some((p) => typeof p !== 'string')) {
      throw new BadRequestException('tokenJsonPath must be a path or a list of paths.');
    }
    const kept = (paths as string[]).filter((p) => p !== '' && p !== '.');
    // '' and '.' both mean the whole body; stored as no path at all.
    if (kept.length === 0) drop('tokenJsonPath');
    else out.tokenJsonPath = kept.length === 1 ? kept[0] : kept;
  }
  if (patch.tokenTTLSeconds !== undefined) {
    if (patch.tokenTTLSeconds === null) drop('tokenTTLSeconds');
    else {
      const ttl = Number(patch.tokenTTLSeconds);
      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new BadRequestException('tokenTTLSeconds must be a positive number of seconds.');
      }
      out.tokenTTLSeconds = ttl;
    }
  }
  if (patch.refreshOn401 !== undefined) out.refreshOn401 = patch.refreshOn401 === true;
  if (patch.loginHeaders !== undefined) {
    if (patch.loginHeaders === null) drop('loginHeaders');
    else out.loginHeaders = mergeLoginHeaders(existing.loginHeaders, patch.loginHeaders, connector);
    if (out.loginHeaders && Object.keys(out.loginHeaders as object).length === 0) drop('loginHeaders');
  }
  return out;
}

/**
 * The login headers after an edit made against the masked view: a header the
 * view masked and that comes back empty keeps its stored value; names left
 * out are removed; names must be valid HTTP header names.
 */
function mergeLoginHeaders(
  stored: unknown,
  sent: Record<string, unknown>,
  connector: { config?: unknown; headers?: unknown },
): Record<string, string> {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
    throw new BadRequestException('loginHeaders must be an object of header names and values.');
  }
  const previous = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const { maskedLoginHeaders } = maskLoginHeaders(previous, connector);
  const masked = new Set(maskedLoginHeaders);
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(sent)) {
    const name = rawName.trim();
    if (!name) continue;
    if (rawValue !== null && rawValue !== undefined && typeof rawValue !== 'string') {
      throw new BadRequestException(`The value of login header "${name}" must be a string.`);
    }
    const value = typeof rawValue === 'string' ? rawValue : '';
    out[name] = value === '' && masked.has(name) ? String(previous[name] ?? '') : value;
  }
  const invalid = invalidConnectorHeaderNames(out);
  if (invalid.length > 0) throw new BadRequestException(describeInvalidHeaderNames(invalid));
  return out;
}
