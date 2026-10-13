/**
 * Grants that obtain a token from stored credentials alone, with no user at
 * the provider: `client_credentials` (the client's own id and secret) and
 * `password` (RFC 6749 §4.3, a username and password; Datto RMM issues its
 * 100-hour tokens this way, with no refresh token). A new token is simply
 * requested again when the old one expires or is refused.
 */
export function isMachineGrant(grant: unknown): boolean {
  return grant === 'client_credentials' || grant === 'password';
}

/**
 * Whether a token refused by the API (401) can be renewed without the user:
 * a stored refresh token, or a grant that asks for a new token by itself.
 */
export function canRenewToken(
  authConfig: Record<string, unknown> | undefined,
): authConfig is Record<string, unknown> {
  if (!authConfig?.tokenUrl) return false;
  return !!authConfig.refreshToken || isMachineGrant(authConfig.grant);
}
