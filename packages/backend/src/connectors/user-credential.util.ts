import { isMachineGrant } from './oauth-grant.util';

/**
 * Per-user credentials (`Connector.credentialScope` USER, Enterprise).
 *
 * The connector keeps the OAuth client (client id and secret, token and
 * authorization URLs, scopes, the dynamically registered client); each user's
 * `UserConnectorCredential` row keeps only the tokens the provider issued to
 * that user. A call carries the two merged, and never the connector's own
 * tokens: a token left on the connector from before the switch, or from an
 * admin's own authorization, would show every user what that one account can
 * see, which is exactly what per-user credentials exist to prevent.
 */

/** The authConfig fields a user's sign-in supplies; everything else is the connector's. */
export const USER_TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'expiresAt',
  'expiresIn',
  'authorizedAt',
  'lastRefreshedAt',
] as const;

const TOKEN_FIELD_SET: ReadonlySet<string> = new Set(USER_TOKEN_FIELDS);

/** The connector's authConfig without any token: the client settings only. */
export function withoutUserTokens(authConfig: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(authConfig).filter(([k]) => !TOKEN_FIELD_SET.has(k)));
}

/** The token fields of an authConfig, for storing as a user's own. */
export function pickUserTokens(authConfig: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(authConfig).filter(([k, v]) => TOKEN_FIELD_SET.has(k) && v !== undefined),
  );
}

/** What a call for one user carries: the connector's client, the user's tokens. */
export function mergeUserCredential(
  connectorAuthConfig: Record<string, unknown> | undefined,
  userTokens: Record<string, unknown>,
): Record<string, unknown> {
  return { ...withoutUserTokens(connectorAuthConfig ?? {}), ...pickUserTokens(userTokens) };
}

/**
 * Connector types whose engines send an OAuth2 token through OAuth2TokenService
 * (OData goes through the REST engine). The SOAP and database engines have no
 * OAuth2 at all, so a per-user sign-in would never reach them.
 */
const OAUTH2_CONNECTOR_TYPES: ReadonlySet<string> = new Set(['REST', 'GRAPHQL', 'MCP', 'ODATA']);

/**
 * Whether a connector can take per-user credentials: an OAuth2 connector that
 * users authorize in the browser. A machine grant (client_credentials,
 * password) has no user to sign in, and a pasted key or password would mean
 * storing every user's secret, so neither qualifies.
 */
export function supportsUserCredentials(
  connectorType: string,
  authType: string,
  authConfig: Record<string, unknown> | undefined,
): boolean {
  return (
    OAUTH2_CONNECTOR_TYPES.has(connectorType) &&
    authType === 'OAUTH2' &&
    !isMachineGrant(authConfig?.grant)
  );
}
