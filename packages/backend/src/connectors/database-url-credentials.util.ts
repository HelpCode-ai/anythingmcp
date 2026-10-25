/**
 * A DATABASE connector's connection string can carry its password
 * (`postgresql://app:s3cret@db.example.com:5432/shop`). `base_url` is stored
 * in plaintext and returned to every member who can open the connector, while
 * `auth_config` is encrypted and never returned. DatabaseEngine already puts
 * `authConfig.username` / `authConfig.password` back into the URL at call time
 * (pg, mysql, mongodb) or reads them directly (mssql, oracle, hana), so a
 * password typed into the URL can move there without changing how the
 * connector connects.
 */

/** What a DATABASE `baseUrl` shows in place of its password. */
export const URL_PASSWORD_MASK = '********';

function hasValue(v: unknown): boolean {
  return typeof v === 'string' ? v !== '' : v !== undefined && v !== null;
}

/**
 * Where the password sits in `scheme://user:password@host…`, found the same
 * way `isSecretValue` recognises a connection string with a password, so
 * everything the dashboard treats as secret is masked. Works on strings
 * `new URL` refuses, such as a multi-host MongoDB URL.
 */
function passwordSpan(value: string): { start: number; end: number } | null {
  const scheme = value.indexOf('://');
  if (scheme <= 0) return null;
  const authStart = scheme + 3;
  const rest = value.slice(authStart);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at <= 0) return null;
  const colon = authority.slice(0, at).indexOf(':');
  if (colon === -1 || colon === at - 1) return null;
  return { start: authStart + colon + 1, end: authStart + at };
}

/**
 * The URL with its password replaced by the mask. A `{{VAR}}` reference is
 * not a secret (its value lives in the encrypted variables) and stays
 * visible, as in headers.
 */
export function maskUrlPassword(value: string): string {
  const span = passwordSpan(value);
  if (!span) return value;
  const password = value.slice(span.start, span.end);
  if (password.includes('{{')) return value;
  return value.slice(0, span.start) + URL_PASSWORD_MASK + value.slice(span.end);
}

/**
 * Apply an edit made against the masked view: a URL sent back exactly as it
 * was shown keeps the stored one, password included.
 */
export function keepMaskedUrlPassword(incoming: string, stored: string): string {
  return incoming !== stored && incoming === maskUrlPassword(stored) ? stored : incoming;
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * Move `user:password@` out of a DATABASE connection string into the
 * connector's authConfig. Returns null, leaving the connector as it is, when:
 *
 * - authConfig already holds a username or password: which one the engine
 *   uses then differs by driver, so moving could change who connects;
 * - the string is not a URL `new URL` can parse (an ADO.NET string, a
 *   multi-host MongoDB URL): the engine could not splice the credentials
 *   back into it;
 * - there is no password, no username (the engine only splices a password
 *   together with a username), a `{{VAR}}` reference, or the mask itself
 *   (an export taken from the masked view).
 *
 * The rest of the string is kept byte for byte: only the userinfo and its `@`
 * are removed.
 */
export function moveUrlCredentials(
  baseUrl: string,
  authConfig: Record<string, unknown> | null | undefined,
): { baseUrl: string; authConfig: Record<string, unknown> } | null {
  if (hasValue(authConfig?.username) || hasValue(authConfig?.password)) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!url.username || !url.password) return null;
  const username = decode(url.username);
  const password = decode(url.password);
  if (!username || !password) return null;
  if (username.includes('{{') || password.includes('{{') || password === URL_PASSWORD_MASK) {
    return null;
  }

  // The userinfo ends at the last `@` before the path, query or fragment.
  const authStart = baseUrl.indexOf('://') + 3;
  const rest = baseUrl.slice(authStart);
  const stop = rest.search(/[/?#]/);
  const at = (stop === -1 ? rest : rest.slice(0, stop)).lastIndexOf('@');
  if (at <= 0) return null;
  const stripped = baseUrl.slice(0, authStart) + rest.slice(at + 1);

  // Only what was removed may differ: anything else means the string and the
  // parser disagree about where the userinfo ends, so leave it alone.
  url.username = '';
  url.password = '';
  try {
    if (new URL(stripped).href !== url.href) return null;
  } catch {
    return null;
  }
  return { baseUrl: stripped, authConfig: { ...(authConfig ?? {}), username, password } };
}
