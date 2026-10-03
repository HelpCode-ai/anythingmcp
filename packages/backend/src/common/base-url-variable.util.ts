import { BadRequestException } from '@nestjs/common';
import { HTTP_CONNECTOR_TYPES } from './url.util';

/**
 * A base URL that comes from a variable.
 *
 * Forty-odd catalog adapters build their address from a value the user types:
 * Substack is `{{SUBSTACK_PUBLICATION_URL}}`, Magento
 * `{{MAGENTO_BASE_URL}}/rest/default/V1`, and so on. Typed as
 * `yourname.substack.com` rather than `https://yourname.substack.com`, that
 * value used to be stored as the base URL verbatim, and every call then died in
 * the SSRF guard with "invalid URL 'yourname.substack.com/api/v1/posts'" — an
 * error that names neither the variable nor the missing `https://`.
 *
 * Two defences live here: {@link normalizeBaseUrlVariable} fixes or refuses the
 * value when it is saved (install form, environment-variable editor), and
 * {@link assertAbsoluteBaseUrl} explains the problem at call time for a
 * connector saved before that check existed.
 */

const LEADING_VAR = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const HTTP_SCHEME = /^https?:\/\//i;
// A host name with at least one dot (or a dotted IPv4 address), an optional
// port, and optionally a path/query. The dot separates labels, and is not in
// the label class, so the nested quantifier cannot backtrack.
const BARE_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?(?:[/?#]\S*)?$/;
// A single-label name such as `nextcloud:8080` or `localhost`.
const SINGLE_LABEL = /^[A-Za-z0-9-]+(?::\d{1,5})?(?:[/?#]\S*)?$/;
const EMAIL = /^[^\s@/]+@[^\s@/]+$/;

const GENERIC_EXAMPLE = 'https://example.com';

/**
 * The variable a base-URL template starts with — `{{MAGENTO_BASE_URL}}/rest`
 * gives `MAGENTO_BASE_URL` — or null when the template starts with a literal
 * scheme (`https://{{TENANT}}.weclapp.com`), where the variable is only a part
 * of the host and must not carry a scheme of its own.
 */
export function leadingBaseUrlVariable(
  template: string | null | undefined,
): string | null {
  if (typeof template !== 'string') return null;
  const match = LEADING_VAR.exec(template.trim());
  return match ? match[1] : null;
}

export type BaseUrlValueCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Decide what a value meant to be the start of a base URL should be stored as.
 *
 * - `https://…` / `http://…` that parses: kept as typed.
 * - A bare host with a domain (`yourname.substack.com`, `shop.example.com/de`,
 *   `10.0.0.5:8443`): `https://` is added — the one reading that works for
 *   every public API in the catalog.
 * - Anything else is refused with a reason, never echoed: the value may be a
 *   secret pasted into the wrong field.
 *
 * A single-label host (`nextcloud:8080`, `localhost`) is refused rather than
 * guessed: those are internal services, and whether they speak http or https
 * is exactly what cannot be guessed.
 */
export function checkBaseUrlValue(raw: string): BaseUrlValueCheck {
  const value = (raw ?? '').trim();
  if (!value) return { ok: false, reason: 'it is empty' };

  if (SCHEME.test(value)) {
    if (!HTTP_SCHEME.test(value)) {
      const scheme = value.slice(0, value.indexOf('://') + 3);
      return {
        ok: false,
        reason: `it starts with ${scheme}, and only https:// and http:// are supported`,
      };
    }
    return parses(value)
      ? { ok: true, value }
      : { ok: false, reason: 'it is not a valid web address' };
  }

  if (value.startsWith('//')) return checkBaseUrlValue(`https:${value}`);
  if (EMAIL.test(value)) {
    return { ok: false, reason: 'it looks like an e-mail address, not a web address' };
  }
  if (/\s/.test(value)) return { ok: false, reason: 'it contains spaces' };

  if (BARE_HOST.test(value) && parses(`https://${value}`)) {
    return { ok: true, value: `https://${value}` };
  }
  if (SINGLE_LABEL.test(value)) {
    return {
      ok: false,
      reason:
        'it has no https:// or http://, and for a server name without a domain ' +
        'there is no telling which of the two it needs — type it in full',
    };
  }
  return { ok: false, reason: 'it is not a web address' };
}

/**
 * Save-time: the value to store for a base-URL variable, or a 400 that names
 * the variable and says what is wrong.
 */
export function normalizeBaseUrlVariable(name: string, value: string): string {
  const check = checkBaseUrlValue(value);
  if (check.ok) return check.value;
  throw new BadRequestException(
    `${name} must be a full URL such as ${GENERIC_EXAMPLE} — ${check.reason}.`,
  );
}

/**
 * Clean up a tenant identifier for weclapp when a full hostname or URL was supplied.
 */
function normalizeWeclappTenant(raw: string): string {
  let val = (raw ?? '').trim();
  if (!val) return val;
  val = val.replace(/^https?:\/\//i, '');
  val = val.replace(/^[/?#].*$/, '');
  const slashIdx = val.indexOf('/');
  if (slashIdx !== -1) val = val.slice(0, slashIdx);
  const qIdx = val.indexOf('?');
  if (qIdx !== -1) val = val.slice(0, qIdx);
  const hashIdx = val.indexOf('#');
  if (hashIdx !== -1) val = val.slice(0, hashIdx);
  val = val.replace(/\.weclapp\.com$/i, '');
  return val;
}

/**
 * Apply {@link normalizeBaseUrlVariable} to the variable a base-URL template
 * starts with, when that variable is among `values`. Returns a new map; other
 * values are untouched. Non-HTTP connectors (DATABASE connection strings carry
 * their own scheme) are left alone.
 */
export function normalizeBaseUrlVariables(
  template: string | null | undefined,
  values: Record<string, string>,
  connectorType?: string,
): Record<string, string> {
  if (connectorType && !HTTP_CONNECTOR_TYPES.has(connectorType)) return values;
  let result = values;
  if (typeof values['WECLAPP_TENANT'] === 'string') {
    const cleaned = normalizeWeclappTenant(values['WECLAPP_TENANT']);
    if (cleaned !== values['WECLAPP_TENANT']) {
      result = { ...result, WECLAPP_TENANT: cleaned };
    }
  }
  const name = leadingBaseUrlVariable(template);
  if (!name || typeof result[name] !== 'string') return result;
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [
      k,
      k === name ? normalizeBaseUrlVariable(name, v) : v,
    ]),
  );
}

/**
 * Call-time: refuse a resolved base URL that is not an absolute http(s) URL,
 * with a message that names the variable it came from.
 *
 * Connectors installed before the save-time check can still carry
 * `yourname.substack.com` as their base URL. Without this, the SSRF guard
 * reports "invalid URL", warning reads like a blocked request.
 *
 * @param input.template The stored, un-interpolated base URL. When it starts
 *   with `{{VAR}}`, that is the variable to name. Catalog installs store the
 *   resolved URL instead, so the variable is then found as the environment
 *   variable whose value the URL starts with.
 */
export function assertAbsoluteBaseUrl(
  input: {
    baseUrl: string | null | undefined;
    connectorType?: string;
    template?: string | null;
    envVars?: Record<string, string> | null;
  },
  /** How to name the thing in the error, e.g. `the connector behind substack_list_posts`. */
  subject?: string,
): void {
  if (input.connectorType && !HTTP_CONNECTOR_TYPES.has(input.connectorType)) {
    return;
  }
  const baseUrl = (input.baseUrl ?? '').trim();
  if (HTTP_SCHEME.test(baseUrl) && parses(baseUrl)) return;

  const envVars = input.envVars ?? {};
  const name =
    leadingBaseUrlVariable(input.template) ?? variableBehind(baseUrl, envVars);
  const which = subject ?? 'this connector';

  if (name) {
    const current = typeof envVars[name] === 'string' ? envVars[name] : '';
    const check = checkBaseUrlValue(current);
    // A fixable value is a host name — safe to show, and the fastest way to
    // say what to type. An unfixable one is not echoed: it may be a secret.
    const example = check.ok
      ? `${check.value}, not "${current.trim()}"`
      : `${GENERIC_EXAMPLE} (${check.reason})`;
    throw new Error(
      `${name} must be a full URL such as ${example}. The request from ${which} ` +
        'was not sent, because without https:// the base URL is not an address ' +
        `it can be sent to. Open the connector, correct ${name} under ` +
        'Environment variables and save — a value without https:// gets it ' +
        'added when saved.',
    );
  }

  const check = checkBaseUrlValue(baseUrl);
  const example = check.ok ? `${check.value}, not "${baseUrl}"` : 'https://api.example.com';
  throw new Error(
    `The base URL of ${which} must be a full URL such as ${example}. The ` +
      'request was not sent. Open the connector and correct its base URL.',
  );
}

/** The environment variable whose (longest) value the base URL starts with. */
function variableBehind(
  baseUrl: string,
  envVars: Record<string, string>,
): string | null {
  let best: { name: string; length: number } | null = null;
  for (const [name, value] of Object.entries(envVars)) {
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (!v || !baseUrl.startsWith(v)) continue;
    if (!best || v.length > best.length) best = { name, length: v.length };
  }
  return best?.name ?? null;
}

function parses(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !!parsed.hostname;
  } catch {
    return false;
  }
}