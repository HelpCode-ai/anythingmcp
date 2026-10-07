import { interpolateString } from '../common/env-interpolation.util';
import { findUnresolvedPlaceholders } from '../common/unresolved-placeholders.util';
import { chooseTokenAuthMethod, type OAuthMetadata } from './mcp-oauth.service';

/**
 * How an MCP connector authorizes against a remote MCP server: the
 * `mcpOAuth` block of `connector.config`, set by a catalog adapter (and
 * copied into the row at install) or through the API.
 *
 * Every field is optional; without the block the flow behaves as it always
 * has, apart from the fixes documented in docs/connectors/mcp-bridge.md.
 */
export interface McpOAuthSettings {
  /**
   * - `auto` (default): a pre-registered client when `clientId` resolves to a
   *   value, else dynamic client registration (RFC 7591) when the server
   *   offers it, else the client stored in the connector's OAuth settings.
   * - `dcr`: always dynamic registration.
   * - `preregistered`: never dynamic registration, even when the server
   *   advertises it (Salesforce does, and refuses it for MCP).
   */
  registration?: 'auto' | 'dcr' | 'preregistered';
  /** Client of an app the user registered, usually `{{VAR}}` from env vars. */
  clientId?: string;
  clientSecret?: string;
  /**
   * The `scope` to request. An empty string sends no scope at all (Asana
   * asks for that). Absent: the scopes the server's protected-resource
   * document lists, else those of the authorization server.
   */
  scope?: string;
  /** Token endpoint auth: `none`, `client_secret_post`, `client_secret_basic`. */
  tokenAuthMethod?: string;
  /**
   * RFC 8707 `resource` parameter on authorize, token and refresh. Default:
   * sent when the server publishes a protected-resource document (MCP spec
   * 2025-06-18 and later), with the identifier from that document. `false`
   * never sends it, a string sends that value.
   */
  resource?: boolean | string;
}

/** A client obtained by dynamic registration, kept for the next authorization. */
export interface StoredDynamicClient {
  registrationEndpoint: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod: string;
  /** Unix seconds; absent when the secret does not expire. */
  clientSecretExpiresAt?: number;
  registeredAt: string;
}

/** Key of the stored dynamic client in the connector's (encrypted) authConfig. */
export const DYNAMIC_CLIENT_KEY = 'mcpOAuthClient';

const REGISTRATION_MODES = new Set(['auto', 'dcr', 'preregistered']);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** The block from the row's config, else from the catalog adapter's. */
export function readMcpOAuthSettings(
  rowConfig: unknown,
  catalogConfig?: unknown,
): McpOAuthSettings {
  const pick = (config: unknown): Record<string, unknown> | undefined => {
    const block = (config as { mcpOAuth?: unknown } | null | undefined)?.mcpOAuth;
    return block && typeof block === 'object' && !Array.isArray(block)
      ? (block as Record<string, unknown>)
      : undefined;
  };
  const raw = pick(rowConfig) ?? pick(catalogConfig) ?? {};
  const out: McpOAuthSettings = {};
  if (typeof raw.registration === 'string' && REGISTRATION_MODES.has(raw.registration)) {
    out.registration = raw.registration as McpOAuthSettings['registration'];
  }
  if (typeof raw.clientId === 'string') out.clientId = raw.clientId;
  if (typeof raw.clientSecret === 'string') out.clientSecret = raw.clientSecret;
  if (typeof raw.scope === 'string') out.scope = raw.scope;
  if (typeof raw.tokenAuthMethod === 'string') out.tokenAuthMethod = raw.tokenAuthMethod;
  if (typeof raw.resource === 'boolean' || typeof raw.resource === 'string') {
    out.resource = raw.resource;
  }
  return out;
}

export interface McpAuthorizeInput {
  metadata: OAuthMetadata;
  settings: McpOAuthSettings;
  /** The connector's stored authConfig with `{{VAR}}` already resolved. */
  authConfig: Record<string, unknown>;
  envVars: Record<string, string>;
  callbackUrl: string;
  /** The MCP endpoint the connector calls, the fallback resource identifier. */
  mcpUrl: string;
  /** Unix milliseconds (tests). */
  now?: number;
}

export type McpAuthorizePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /**
       * - `preregistered`: a client the user (or the catalog) supplied.
       * - `stored`: a client this server registered earlier, reused.
       * - `register`: register one now with `registerAuthMethod`.
       */
      client:
        | { source: 'preregistered' | 'stored'; clientId: string; clientSecret?: string; tokenAuthMethod?: string }
        | { source: 'register'; registrationEndpoint: string; registerAuthMethod: string };
      scope?: string;
      resource?: string;
    };

/** Resolve one `{{VAR}}` template; `missing` lists the variables without a value. */
function resolveTemplate(
  template: string | undefined,
  envVars: Record<string, string>,
): { value?: string; missing: string[] } {
  if (template === undefined) return { missing: [] };
  const names = findUnresolvedPlaceholders(template);
  const missing = names.filter((n) => !str(envVars[n]));
  if (missing.length > 0) return { missing };
  return { value: str(interpolateString(template, envVars)), missing: [] };
}

/**
 * Decide, from the discovered metadata and the connector's settings, which
 * client to authorize with and what to send. Pure: the caller registers,
 * persists and redirects.
 */
export function planMcpAuthorization(input: McpAuthorizeInput): McpAuthorizePlan {
  const { metadata, settings, authConfig, envVars, callbackUrl } = input;
  const mode = settings.registration ?? 'auto';

  const scope = chooseScope(metadata, settings, authConfig);
  const resource = chooseResource(metadata, settings, input.mcpUrl);
  const done = (client: Extract<McpAuthorizePlan, { ok: true }>['client']): McpAuthorizePlan => ({
    ok: true,
    client,
    ...(scope ? { scope } : {}),
    ...(resource ? { resource } : {}),
  });

  const preId = resolveTemplate(settings.clientId, envVars);
  const preSecret = resolveTemplate(settings.clientSecret, envVars);
  const missingVars = [...preId.missing, ...preSecret.missing];
  const tokenAuthMethod = settings.tokenAuthMethod ?? str(authConfig.tokenAuthMethod);
  const needOwnApp = (what: string) =>
    `${what} Register an OAuth app with the provider, use ${callbackUrl} as its redirect URI, then ` +
    (missingVars.length > 0
      ? `set ${missingVars.join(' and ')} in this connector's environment variables`
      : "enter its client ID and secret in this connector's OAuth settings") +
    ' and authorize again.';

  if (mode === 'preregistered' || (mode === 'auto' && preId.value)) {
    const clientId = preId.value ?? (settings.clientId === undefined ? str(authConfig.clientId) : undefined);
    if (!clientId) {
      return { ok: false, error: needOwnApp('This server needs a client registered in advance.') };
    }
    const clientSecret =
      settings.clientId !== undefined ? preSecret.value : str(authConfig.clientSecret);
    return done({
      source: 'preregistered',
      clientId,
      ...(clientSecret && tokenAuthMethod !== 'none' ? { clientSecret } : {}),
      ...(tokenAuthMethod ? { tokenAuthMethod } : {}),
    });
  }

  const registrationEndpoint = str(metadata.registration_endpoint);
  if (!registrationEndpoint) {
    if (mode === 'dcr') {
      return {
        ok: false,
        error: 'This server does not offer dynamic client registration (no registration_endpoint in its OAuth metadata).',
      };
    }
    // The historical fallback: the client stored in the OAuth settings.
    const clientId = str(authConfig.clientId);
    if (!clientId) {
      return {
        ok: false,
        error: needOwnApp('This server does not register clients automatically.'),
      };
    }
    const clientSecret = str(authConfig.clientSecret);
    return done({
      source: 'preregistered',
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(tokenAuthMethod ? { tokenAuthMethod } : {}),
    });
  }

  const stored = readStoredDynamicClient(authConfig);
  if (
    stored &&
    stored.registrationEndpoint === registrationEndpoint &&
    stored.redirectUri === callbackUrl &&
    !(stored.clientSecretExpiresAt && stored.clientSecretExpiresAt * 1000 <= (input.now ?? Date.now()) + 60_000)
  ) {
    return done({
      source: 'stored',
      clientId: stored.clientId,
      ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      tokenAuthMethod: stored.tokenAuthMethod,
    });
  }

  return done({
    source: 'register',
    registrationEndpoint,
    registerAuthMethod:
      settings.tokenAuthMethod ?? chooseTokenAuthMethod(metadata.token_endpoint_auth_methods_supported),
  });
}

export function readStoredDynamicClient(
  authConfig: Record<string, unknown>,
): StoredDynamicClient | undefined {
  const raw = authConfig[DYNAMIC_CLIENT_KEY] as Partial<StoredDynamicClient> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (!str(raw.clientId) || !str(raw.registrationEndpoint) || !str(raw.redirectUri)) return undefined;
  return raw as StoredDynamicClient;
}

/**
 * The scope to request: what the user typed in the OAuth settings, else the
 * adapter's (`''` = none), else what the protected resource asks for, else
 * the authorization server's list (the historical behaviour, kept for
 * servers without a protected-resource document). The resource's list comes
 * first because an authorization server shared by many APIs lists far more
 * than this one needs: Salesforce would be asked for ~35 scopes, Linear for
 * `admin`.
 */
function chooseScope(
  metadata: OAuthMetadata,
  settings: McpOAuthSettings,
  authConfig: Record<string, unknown>,
): string | undefined {
  const typed = str(authConfig.scopes);
  if (typed) return typed;
  if (settings.scope !== undefined) return str(settings.scope);
  const fromResource = metadata.protectedResource?.scopesSupported;
  if (fromResource && fromResource.length > 0) return fromResource.join(' ');
  return metadata.scopes_supported?.length ? metadata.scopes_supported.join(' ') : undefined;
}

function chooseResource(
  metadata: OAuthMetadata,
  settings: McpOAuthSettings,
  mcpUrl: string,
): string | undefined {
  const setting = settings.resource;
  if (setting === false) return undefined;
  if (typeof setting === 'string') return str(setting);
  const published = str(metadata.protectedResource?.resource);
  if (setting === true) return published ?? mcpUrl;
  return metadata.protectedResource ? (published ?? mcpUrl) : undefined;
}
