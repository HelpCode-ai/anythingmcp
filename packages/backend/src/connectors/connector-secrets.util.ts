import { getAdapter } from '../adapters/catalog';

/**
 * Which connector environment variables and headers hold credentials, and how
 * they are withheld from API responses.
 *
 * Same convention as the OAuth2 and OAuth 1.0a settings: a stored secret is
 * never sent back. Its value comes back empty, its name is listed in
 * `maskedEnvVars` / `maskedHeaders` so the editor can show it as set, and an
 * empty value sent back on save keeps what is stored.
 *
 * There is no per-variable "secret" flag in the adapter catalog, so a value is
 * treated as secret when any of these says so (erring on the side of hiding):
 *   - its name contains a credential word (KEY, TOKEN, SECRET, PASSWORD, …);
 *   - the adapter (or the connector's own headers) uses it in a credential
 *     slot, such as `consumerKey` in authConfig or an `X-Api-Key` header;
 *   - the value itself carries a credential (a URL with a password, a PEM key,
 *     a `Bearer …` string).
 * Anything else (base URLs, account and shop IDs, regions) stays visible.
 */

/** Whole words (after splitting on `_`, `-`, `.` and camelCase) that mark a secret. */
const SECRET_WORDS = new Set([
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'KEY',
  'KEYS',
  'APIKEY',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'PASSPHRASE',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'AUTHORIZATION',
  'BEARER',
  'JWT',
  'SIGNATURE',
  'HMAC',
  'SALT',
  'COOKIE',
  'SESSION',
  'PIN',
  'OTP',
  'DSN',
  'WEBHOOK',
]);

/** Fragments that mark a secret wherever they occur in the squashed name. */
const SECRET_FRAGMENTS = [
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'TOKEN',
  'APIKEY',
  'ACCESSKEY',
  'PRIVATEKEY',
  'CREDENTIAL',
  'WEBHOOK',
];

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** True when the name alone says the value is a credential. */
export function isSecretName(name: string): boolean {
  const words = nameWords(name);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  const squashed = words.join('');
  return SECRET_FRAGMENTS.some((f) => squashed.includes(f));
}

/** True when the value itself carries a credential, whatever it is called. */
export function isSecretValue(value: string): boolean {
  if (value.includes('-----BEGIN')) return true;
  if (/^bearer\s/i.test(value)) return true;
  // scheme://user:password@host — a connection string with its password.
  const scheme = value.indexOf('://');
  if (scheme > 0) {
    const rest = value.slice(scheme + 3);
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf('@');
    if (at > 0) {
      const colon = authority.slice(0, at).indexOf(':');
      if (colon !== -1 && colon < at - 1) return true;
    }
  }
  return false;
}

/**
 * Keys whose value is a credential when it references a variable. A key ending
 * in Url/Uri/Endpoint/Path names where to send something (`tokenUrl`), not a
 * secret.
 */
const SECRET_SLOT = /secret|passw|token|key|credential|private|signature|assertion|authorization|cookie|session|jwt|bearer/i;
const NOT_A_SLOT = /(url|uri|endpoint|path)$/i;
const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

function collectSlotVars(node: unknown, key: string, out: Set<string>): void {
  if (typeof node === 'string') {
    if (!SECRET_SLOT.test(key) || NOT_A_SLOT.test(key)) return;
    for (const match of node.matchAll(VAR_PATTERN)) out.add(match[1].trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSlotVars(item, key, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectSlotVars(v, k, out);
  }
}

const slotCache = new Map<string, Set<string>>();

/** Variables an adapter feeds into a credential slot (authConfig, headers, query). */
function adapterSecretSlots(slug: string): Set<string> {
  const cached = slotCache.get(slug);
  if (cached) return cached;
  const out = new Set<string>();
  const adapter = getAdapter(slug);
  if (adapter) {
    collectSlotVars(adapter.connector.authConfig, 'authConfig', out);
    collectSlotVars(adapter.connector.headers, 'headers', out);
    for (const tool of adapter.tools) {
      const em = tool.endpointMapping as Record<string, unknown> | undefined;
      collectSlotVars(em?.queryParams, 'queryParams', out);
      collectSlotVars(em?.headers, 'headers', out);
      collectSlotVars(em?.bodyMapping, 'bodyMapping', out);
    }
    // A renamed variable is as secret under its old name (IS24_CLIENT_ID held
    // what IS24_CONSUMER_KEY holds now).
    for (const [current, previous] of Object.entries(adapter.envVarAliases ?? {})) {
      if (out.has(current) || isSecretName(current)) {
        for (const name of previous) out.add(name);
      }
    }
  }
  slotCache.set(slug, out);
  return out;
}

export interface SecretContext {
  /** Variable names used in a credential slot by the adapter or the connector. */
  slotVars: Set<string>;
  /** Header names whose stored value came from a secret variable (adapter template). */
  secretHeaders: Set<string>;
}

type ConnectorLike = {
  config?: unknown;
  headers?: unknown;
};

/** What the adapter and the connector's own templates say about its secrets. */
export function secretContext(connector: ConnectorLike): SecretContext {
  const slug = (connector.config as { adapterSlug?: unknown } | null)?.adapterSlug;
  const slotVars = new Set<string>(
    typeof slug === 'string' ? adapterSecretSlots(slug) : [],
  );
  // A hand-built connector keeps `{{VAR}}` in its headers.
  collectSlotVars(connector.headers, 'headers', slotVars);

  const secretHeaders = new Set<string>();
  const adapter = typeof slug === 'string' ? getAdapter(slug) : null;
  const templateHeaders = adapter?.connector.headers ?? {};
  for (const [name, template] of Object.entries(templateHeaders)) {
    for (const match of String(template).matchAll(VAR_PATTERN)) {
      const variable = match[1].trim();
      if (slotVars.has(variable) || isSecretName(variable)) {
        secretHeaders.add(name.toLowerCase());
      }
    }
  }
  return { slotVars, secretHeaders };
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** A stored env var whose value is withheld from responses. */
export function isMaskedEnvVar(
  name: string,
  value: unknown,
  ctx: SecretContext,
): boolean {
  const v = asString(value);
  if (!v) return false;
  return isSecretName(name) || ctx.slotVars.has(name) || isSecretValue(v);
}

/** A stored header whose value is withheld from responses. */
export function isMaskedHeader(
  name: string,
  value: unknown,
  ctx: SecretContext,
): boolean {
  const v = asString(value);
  if (!v) return false;
  // `Bearer {{API_TOKEN}}` only names the variable; the variable's value is
  // what is withheld, and the reference is what the user needs to see.
  if (v.includes('{{')) return false;
  return (
    isSecretName(name) ||
    ctx.secretHeaders.has(name.toLowerCase()) ||
    isSecretValue(v)
  );
}

function maskMap(
  map: unknown,
  isMasked: (name: string, value: unknown) => boolean,
): { values: Record<string, string> | null; masked: string[] } {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return { values: (map as null) ?? null, masked: [] };
  }
  const masked: string[] = [];
  const values = Object.fromEntries(
    Object.entries(map as Record<string, unknown>).map(([name, value]) => {
      if (isMasked(name, value)) {
        masked.push(name);
        return [name, ''];
      }
      return [name, value as string];
    }),
  );
  return { values, masked };
}

export function maskEnvVars(
  envVars: unknown,
  ctx: SecretContext,
): { envVars: Record<string, string> | null; maskedEnvVars: string[] } {
  const { values, masked } = maskMap(envVars, (n, v) => isMaskedEnvVar(n, v, ctx));
  return { envVars: values, maskedEnvVars: masked };
}

export function maskHeaders(
  headers: unknown,
  ctx: SecretContext,
): { headers: Record<string, string> | null; maskedHeaders: string[] } {
  const { values, masked } = maskMap(headers, (n, v) => isMaskedHeader(n, v, ctx));
  return { headers: values, maskedHeaders: masked };
}

/**
 * The connector as the browser may see it: stored secrets in env vars and
 * headers come back empty and are named in `maskedEnvVars` / `maskedHeaders`.
 * authConfig only ever leaves as the stored ciphertext; anything else (a
 * decrypted object handed in by mistake) is dropped.
 */
export function toPublicConnector<
  T extends ConnectorLike & { envVars?: unknown; authConfig?: unknown },
>(connector: T): T & { maskedEnvVars: string[]; maskedHeaders: string[] } {
  const ctx = secretContext(connector);
  const env = maskEnvVars(connector.envVars, ctx);
  const hdr = maskHeaders(connector.headers, ctx);
  const out = {
    ...connector,
    envVars: env.envVars,
    headers: hdr.headers,
    maskedEnvVars: env.maskedEnvVars,
    maskedHeaders: hdr.maskedHeaders,
  };
  if (out.authConfig !== undefined && out.authConfig !== null && typeof out.authConfig !== 'string') {
    delete out.authConfig;
  }
  return out;
}

/**
 * Apply an edit made against a masked view: a secret sent back empty keeps its
 * stored value. A name left out is still removed, and a non-secret value
 * sent empty is stored empty, exactly as before.
 */
function keepMaskedValues(
  incoming: Record<string, string>,
  stored: unknown,
  isMasked: (name: string, value: unknown) => boolean,
): Record<string, string> {
  const current =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([name, value]) => {
      const previous = Object.prototype.hasOwnProperty.call(current, name)
        ? current[name]
        : undefined;
      if (
        (value === '' || value === null || value === undefined) &&
        isMasked(name, previous)
      ) {
        return [name, asString(previous)];
      }
      return [name, value];
    }),
  );
}

export function mergeMaskedEnvVars(
  incoming: Record<string, string>,
  stored: unknown,
  ctx: SecretContext,
): Record<string, string> {
  return keepMaskedValues(incoming, stored, (n, v) => isMaskedEnvVar(n, v, ctx));
}

export function mergeMaskedHeaders(
  incoming: Record<string, string>,
  stored: unknown,
  ctx: SecretContext,
): Record<string, string> {
  return keepMaskedValues(incoming, stored, (n, v) => isMaskedHeader(n, v, ctx));
}
