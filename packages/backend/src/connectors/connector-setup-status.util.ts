import { getAdapter } from '../adapters/catalog';
import { interpolateDeep, interpolateString } from '../common/env-interpolation.util';
import { CALLER_CONTEXT_PREFIX } from '../common/caller-context.util';
import { findUnresolvedPlaceholders } from '../common/unresolved-placeholders.util';

/**
 * Whether a connector can serve calls yet.
 *
 * - `ready`: every variable it references has a value, and an OAuth connector
 *   that needs a browser authorization has one.
 * - `needs_input`: a variable is still empty (a credential, a tenant, an
 *   address). Every call would fail before reaching the API.
 * - `needs_authorization`: the client settings are there but nobody has
 *   completed "Authorize with Provider" yet.
 *
 * Connectors that are not ready are not listed on MCP: a model that sees their
 * tools calls them and gets an error the user cannot fix from the chat.
 */
export type SetupStatus = 'ready' | 'needs_input' | 'needs_authorization';

export interface SetupState {
  status: SetupStatus;
  /** Variables without a value, when status is needs_input. */
  missing: string[];
}

export interface SetupStatusInput {
  authType: string;
  /** Decrypted auth config: object, or the JSON string the registry keeps. */
  authConfig?: unknown;
  baseUrl?: string | null;
  headers?: unknown;
  envVars?: unknown;
  config?: unknown;
}

/** Auth config fields that an authorization fills in, not the user. */
const TOKEN_FIELDS = new Set(['accessToken', 'refreshToken', 'expiresAt', 'expiresIn']);

function parseAuthConfig(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined && v !== null && String(v) !== '') out[k] = String(v);
  }
  return out;
}

function hasRealValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  return text !== '' && findUnresolvedPlaceholders(text).length === 0;
}

/** The authorization URL a browser OAuth flow would use, row first, then the catalog. */
function browserAuthorizationUrl(
  authConfig: Record<string, unknown>,
  config: unknown,
): string | undefined {
  if (authConfig.authorizationUrl) return String(authConfig.authorizationUrl);
  const slug = (config as { adapterSlug?: unknown } | null)?.adapterSlug;
  if (typeof slug !== 'string') return undefined;
  const catalog = getAdapter(slug)?.connector.authConfig as
    | Record<string, unknown>
    | undefined;
  return catalog?.authorizationUrl ? String(catalog.authorizationUrl) : undefined;
}

export function computeSetupState(input: SetupStatusInput): SetupState {
  const envVars = asStringMap(input.envVars);
  const options = { reservedPrefix: CALLER_CONTEXT_PREFIX };
  const authConfig = interpolateDeep(parseAuthConfig(input.authConfig), envVars, options);
  const isBrowserOAuth =
    input.authType === 'OAUTH2' &&
    String(authConfig.grant ?? '') !== 'client_credentials' &&
    !!browserAuthorizationUrl(authConfig, input.config);

  // Tokens of a browser OAuth connector are written by the authorization; a
  // placeholder there means "not authorized yet", not "fill in this field".
  const checkedAuth = isBrowserOAuth
    ? Object.fromEntries(Object.entries(authConfig).filter(([k]) => !TOKEN_FIELDS.has(k)))
    : authConfig;

  const missing = findUnresolvedPlaceholders({
    baseUrl: input.baseUrl ? interpolateString(input.baseUrl, envVars, options) : undefined,
    headers: input.headers ? interpolateDeep(input.headers, envVars, options) : undefined,
    authConfig: checkedAuth,
  })
    .filter((name) => !name.startsWith(CALLER_CONTEXT_PREFIX))
    .sort();
  if (missing.length > 0) return { status: 'needs_input', missing };

  if (isBrowserOAuth && !hasRealValue(authConfig.refreshToken) && !hasRealValue(authConfig.accessToken)) {
    return { status: 'needs_authorization', missing: [] };
  }
  return { status: 'ready', missing: [] };
}
