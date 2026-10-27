/**
 * The key a connector credential is known by in the token engines.
 *
 * The engines key everything about a credential on one string: the token
 * cache, the refresh mutex and its database lock, the memo of a refused
 * refresh token, and where a renewed token is stored. For a connector's own
 * credential that string is the connector id. A user's own sign-in to a
 * connector whose credentials are per user (`credentialScope` USER) gets a key
 * of its own, `<connectorId>:user:<userId>`, so two users of one connector
 * never share a cached token or a lock, and one user's refused refresh token
 * blocks only that user.
 *
 * Ids are cuids, which contain no colon, so the key parses back unambiguously.
 */
const USER_KEY_SEPARATOR = ':user:';

export interface CredentialKeyParts {
  connectorId: string;
  /** Set when the key names one user's own credential. */
  userId?: string;
}

export function userCredentialKey(connectorId: string, userId: string): string {
  return `${connectorId}${USER_KEY_SEPARATOR}${userId}`;
}

export function parseCredentialKey(key: string): CredentialKeyParts {
  const at = key.indexOf(USER_KEY_SEPARATOR);
  if (at <= 0) return { connectorId: key };
  const userId = key.slice(at + USER_KEY_SEPARATOR.length);
  return userId ? { connectorId: key.slice(0, at), userId } : { connectorId: key };
}
