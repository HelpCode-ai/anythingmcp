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

// ── Per-user variables ─────────────────────────────────────────────────────
//
// A connector that is not a browser OAuth2 one has no token to give each user.
// Its credentials reach a call through connector variables (`{{NAME}}` in the
// address, the headers, the auth config, the tools), so there the unit of a
// per-user credential is the variable: `config.userVariables` names the ones
// every user supplies, each user's values live in their
// `UserConnectorCredential` row next to the token fields (`userVars`), and a
// call resolves placeholders from the connector's variables with the caller's
// own values over them.
//
// A variable named there never resolves from the connector's own value: the
// switch to per-user empties it, and `effectiveVariables` drops whatever is
// still stored. One user's key is never another user's fallback.

/** The `connector.config` key listing the variables each user supplies. */
export const USER_VARIABLES_CONFIG_KEY = 'userVariables';

/** The key of a user's own variable values inside their stored credential. */
export const USER_VARS_FIELD = 'userVars';

/** What a connector variable may be called. `amcp.*` is the caller context, never a variable. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** At most this many variables per user, and this long each. */
export const MAX_USER_VARIABLES = 20;
export const MAX_USER_VARIABLE_LENGTH = 8192;

/**
 * How users of a connector with `credentialScope` USER connect their own
 * account: through the provider's sign-in (`oauth`) or by entering their own
 * values of some variables (`variables`).
 */
export type UserCredentialMode = 'oauth' | 'variables';

/** The variables each user supplies, as stored on the connector. Empty for a browser OAuth2 connector. */
export function userVariableNames(config: unknown): string[] {
  const raw = (config as Record<string, unknown> | null | undefined)?.[USER_VARIABLES_CONFIG_KEY];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((n): n is string => typeof n === 'string' && VARIABLE_NAME.test(n)))].slice(
    0,
    MAX_USER_VARIABLES,
  );
}

export function isVariableName(name: unknown): name is string {
  return typeof name === 'string' && VARIABLE_NAME.test(name);
}

/**
 * Connector types whose calls always come from a caller and resolve variables
 * per call. DATABASE is left out for now: other code reads its stored
 * connection string directly (the credential repair at boot, the schema
 * tools), so a `{{VAR}}` left in it for each user is not safe yet.
 */
const VARIABLE_CONNECTOR_TYPES: ReadonlySet<string> = new Set(['REST', 'GRAPHQL', 'SOAP', 'ODATA', 'EMAIL', 'MCP']);

/**
 * Auth types that send what the variables hold with every call and keep
 * nothing of their own between calls. The others stay shared for now:
 * LOGIN_TOKEN, HMAC token providers and renewed bearer tokens store a session
 * per connector (`connector_auth_cache`), OAUTH1 and CERTIFICATE are not
 * entered as variables, and an OAuth2 machine grant renews from the
 * connector's own variables.
 */
const VARIABLE_AUTH_TYPES: ReadonlySet<string> = new Set([
  'NONE',
  'API_KEY',
  'QUERY_AUTH',
  'BEARER_TOKEN',
  'BASIC_AUTH',
  'WS_SECURITY',
  'CONNECTION_STRING',
]);

export interface UserCredentialModeInput {
  type: string;
  authType: string;
  /** Decrypted. */
  authConfig?: Record<string, unknown>;
  config?: unknown;
  /** True when the connector receives webhooks: those arrive without a caller. */
  webhookEnabled?: boolean;
  /** True when the bearer token is renewed in the background (bearer-token-renewal). */
  renewsBearerToken?: boolean;
}

export interface UserCredentialModeOptions {
  /** `USER_VARIABLE_CREDENTIALS`: off refuses the `variables` mode and changes nothing else. */
  variablesEnabled: boolean;
}

/**
 * Whether connectors may be switched to per-user variables on this server:
 * only with `USER_VARIABLE_CREDENTIALS=true`. Off (the default, on Cloud and
 * self-hosted alike, until the connect page and the dashboard have their
 * forms) only refuses new switches and new values: a connector already
 * switched keeps asking each caller for their own, since its own values are
 * gone and must not come back as a fallback.
 */
export function userVariableCredentialsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.USER_VARIABLE_CREDENTIALS ?? '').trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

/**
 * How a connector's users would connect their own account, or the reason it
 * can only be shared. The reason is a sentence for the administrator.
 */
export function userCredentialModeOf(
  connector: UserCredentialModeInput,
  options: UserCredentialModeOptions,
): { mode: UserCredentialMode } | { mode: null; reason: string } {
  if (supportsUserCredentials(connector.type, connector.authType, connector.authConfig)) {
    return { mode: 'oauth' };
  }
  if (!options.variablesEnabled) {
    return {
      mode: null,
      reason:
        'Per-user sign-in needs a REST, GraphQL, MCP or OData connector with OAuth2 that users ' +
        'authorize in the browser. API keys, passwords and client-credentials grants stay shared.',
    };
  }
  if (!VARIABLE_CONNECTOR_TYPES.has(connector.type)) {
    return {
      mode: null,
      reason:
        connector.type === 'DATABASE'
          ? 'Per-user credentials are not available for database connectors yet. Its credential stays shared.'
          : `A ${connector.type} connector works without a signed-in caller (it syncs or receives events ` +
            'in the background), so its credential stays shared.',
    };
  }
  if (connector.webhookEnabled) {
    return {
      mode: null,
      reason: 'This connector receives webhooks, which arrive without a signed-in user. Its credential stays shared.',
    };
  }
  if (!VARIABLE_AUTH_TYPES.has(connector.authType) || connector.renewsBearerToken) {
    return {
      mode: null,
      reason:
        `Per-user credentials are not available for this sign-in method yet (${connector.authType}). ` +
        'Its credential stays shared.',
    };
  }
  return { mode: 'variables' };
}

/**
 * The variables a call resolves placeholders with: the connector's own, minus
 * every per-user one, plus the caller's own values of those.
 */
export function effectiveVariables(
  connectorVars: Record<string, string> | null | undefined,
  names: readonly string[],
  userVars: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...(connectorVars ?? {}) };
  for (const name of names) {
    const own = userVars?.[name];
    if (typeof own === 'string' && own !== '') out[name] = own;
    else delete out[name];
  }
  return out;
}

/** The per-user variables a user has no value for. */
export function missingUserVariables(
  names: readonly string[],
  userVars: Record<string, string> | null | undefined,
): string[] {
  return names.filter((name) => typeof userVars?.[name] !== 'string' || userVars[name] === '');
}

/** A user's stored variable values, read from their decrypted credential. Only strings, only for `names`. */
export function pickUserVariables(
  credential: Record<string, unknown> | null | undefined,
  names: readonly string[],
): Record<string, string> {
  const raw = credential?.[USER_VARS_FIELD];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/**
 * The values a user typed, checked: every per-user variable, nothing else,
 * each a non-empty string of a sane length. Leading and trailing spaces are
 * dropped (a pasted key with a space was a refused login before). Returns the
 * cleaned values or the sentence to show.
 */
export function cleanUserVariables(
  names: readonly string[],
  input: unknown,
): { values: Record<string, string> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Send the values as an object of variable name and value.' };
  }
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    return { error: `Not a per-user variable of this connector: ${unknown.slice(0, 5).join(', ')}.` };
  }
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = given[name];
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return { error: `A value for ${name} is required.` };
    if (text.length > MAX_USER_VARIABLE_LENGTH) return { error: `The value of ${name} is too long.` };
    // A line break or another control character has no place in a key or a
    // password, and in a header or a URL it would start a second one.
    if (CONTROL_CHARACTER.test(text)) return { error: `The value of ${name} contains a line break or control character.` };
    values[name] = text;
  }
  return { values };
}
