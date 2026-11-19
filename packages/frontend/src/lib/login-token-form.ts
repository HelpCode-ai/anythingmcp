/**
 * Helpers shared by the new-connector and connector-detail forms for the
 * Login → Token (LOGIN_TOKEN) settings.
 */

/** What the token path field means: '' = the whole response body. */
export type LoginTokenPath = string | string[];

/**
 * The token path as typed: empty (or ".") means the whole response body is
 * the token; several paths separated by commas are tried in order.
 */
export function tokenPathFromInput(text: string): LoginTokenPath {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] === '.' ? '' : parts[0];
  return parts;
}

/** The stored token path(s) as the field shows them. */
export function tokenPathToInput(value: LoginTokenPath | undefined | null): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value !== 'string') return '';
  return value.trim() === '.' ? '' : value;
}

/**
 * Which credential the login uses but nobody provided, or null. Without a
 * login body the engine sends username and password as the body, so both
 * are needed; otherwise only what the body and the login headers reference
 * (`${username}`, `${password}` or `${passwordHashed}`).
 */
export function missingLoginCredential(opts: {
  /** The login body text (as typed) and the login header values. */
  texts: string[];
  /** Whether the login has a body at all (typed, or stored and hidden). */
  hasBody: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
}): 'username' | 'password' | null {
  const text = opts.texts.join('\n');
  const needsUsername = !opts.hasBody || text.includes('${username}');
  const needsPassword = !opts.hasBody || text.includes('${password}') || text.includes('${passwordHashed}');
  if (needsUsername && !opts.hasUsername) return 'username';
  if (needsPassword && !opts.hasPassword) return 'password';
  return null;
}
