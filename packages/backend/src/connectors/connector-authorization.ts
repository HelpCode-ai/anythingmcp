import type { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Connector } from '../generated/prisma/client';
import { decrypt } from '../common/crypto/encryption.util';
import { interpolateDeep, interpolateString } from '../common/env-interpolation.util';
import { urlForLog } from '../common/log-safe-url.util';
import { resolveMcpEndpointUrl } from '../common/url.util';
import { getAdapter } from '../adapters/catalog';
import type { ConnectorsService } from './connectors.service';
import { connectorSecretValues } from './connector-secrets.util';
import type { ClientAssertionSettings } from './engines/client-assertion.util';
import { tokenEndpointUserAgent } from './engines/oauth2-token.service';
import { mcpPathOf } from './mcp-connector-config.util';
import type { McpOAuthService, PendingOAuthFlow } from './mcp-oauth.service';
import {
  DYNAMIC_CLIENT_KEY,
  planMcpAuthorization,
  readMcpOAuthSettings,
  type StoredDynamicClient,
} from './mcp-oauth-settings';
import { resolveRestAuthorizeSettings } from './oauth-authorize-settings';

/** The redirect URI connector authorizations register at the provider. */
export function connectorOAuthCallbackUrl(config: Pick<ConfigService, 'get'>): string {
  const base = (config.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  return `${base}/api/mcp-oauth/callback`;
}

export interface StartAuthorizationDeps {
  connectorsService: Pick<ConnectorsService, 'updateAuthConfigMerge'>;
  mcpOAuthService: McpOAuthService;
  logger: Pick<Logger, 'log'>;
  encryptionKey: string;
  /** The OAuth redirect URI registered at the provider (SERVER_URL/api/mcp-oauth/callback). */
  callbackUrl: string;
}

export interface StartAuthorizationOptions {
  /** Who starts the flow: only this user may complete it. */
  userId: string;
  /** The tokens go to that user's own credential (credentialScope USER). */
  forUser?: boolean;
  /** Internal path the dashboard returns to afterwards. */
  returnTo?: string;
  /** Where the callback sends the browser (see PendingOAuthFlow.completeOn). */
  completeOn?: PendingOAuthFlow['completeOn'];
}

/**
 * Starts the browser authorization of an OAuth2 connector: picks the client
 * (for MCP connectors from discovery, a stored registration or a dynamic
 * registration now), stores the pending flow and builds the provider's
 * authorization URL. Shared by the dashboard (POST
 * /api/connectors/:id/oauth/authorize) and the connect page under /auth/connect,
 * which check who may start it before calling this. Returns `{ error }` for a
 * connector that is not set up for it; throws on a provider failure.
 */
export async function startConnectorAuthorization(
  deps: StartAuthorizationDeps,
  connector: Pick<Connector, 'id' | 'type' | 'baseUrl' | 'authConfig' | 'envVars' | 'config' | 'headers'>,
  opts: StartAuthorizationOptions,
): Promise<{ authorizationUrl: string; state: string } | { error: string }> {
  const callbackUrl = deps.callbackUrl;
  const authConfig = connector.authConfig
    ? JSON.parse(decrypt(connector.authConfig, deps.encryptionKey))
    : {};

  let clientId: string;
  let clientSecret: string | undefined;
  let authorizationEndpoint: string;
  let tokenEndpoint: string;
  let scope: string | undefined;
  let tokenAuthMethod: string | undefined = authConfig.tokenAuthMethod
    ? String(authConfig.tokenAuthMethod)
    : undefined;
  let clientAssertion: ClientAssertionSettings | undefined;
  // REST/GraphQL only: the auth config fields to write on success in place
  // of the historical "client settings as stored" (see PendingOAuthFlow).
  let persistAuthConfig: Record<string, unknown> | undefined;
  // MCP only: RFC 8707 resource indicator, and whether the client came
  // from dynamic registration.
  let resource: string | undefined;
  let dynamicClient = false;
  // PKCE (RFC 7636) is on unless a REST/GraphQL connector turned it off.
  // MCP authorization always requires it.
  let pkce = true;

  if (connector.type === 'MCP') {
    // MCP: discover OAuth metadata from the remote server, then pick the
    // client (pre-registered, registered earlier, or register now), the
    // scope and the resource indicator. See mcp-oauth-settings.ts.
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    const rowConfig = connector.config as Record<string, unknown> | null;
    const adapterSlug = (rowConfig as { adapterSlug?: string } | null)?.adapterSlug;
    const settings = readMcpOAuthSettings(
      rowConfig,
      adapterSlug ? getAdapter(adapterSlug)?.connector.config : undefined,
    );
    const baseUrl = interpolateString(connector.baseUrl, envVars);
    const metadata = await deps.mcpOAuthService.discoverMetadata(baseUrl);
    deps.logger.log(
      `OAuth metadata discovered from ${urlForLog(baseUrl, { secrets: connectorSecretValues(connector) })}: issuer=${metadata.issuer}`,
    );

    const plan = planMcpAuthorization({
      metadata,
      settings,
      // {{VAR}} in a client typed into the OAuth settings resolves from
      // the env vars at this point too, as it does for REST connectors.
      authConfig: interpolateDeep(authConfig, envVars),
      envVars,
      callbackUrl,
      mcpUrl: resolveMcpEndpointUrl(baseUrl, mcpPathOf(rowConfig)).toString(),
    });
    if (!plan.ok) return { error: plan.error };

    authorizationEndpoint = metadata.authorization_endpoint;
    tokenEndpoint = metadata.token_endpoint;
    scope = plan.scope;
    resource = plan.resource;

    if (plan.client.source === 'register') {
      const registration = await deps.mcpOAuthService.registerClient(
        plan.client.registrationEndpoint,
        callbackUrl,
        { tokenAuthMethod: plan.client.registerAuthMethod },
      );
      clientId = registration.clientId;
      clientSecret = registration.clientSecret;
      tokenAuthMethod = registration.tokenAuthMethod;
      dynamicClient = true;
      // Kept so the next "Authorize" reuses this client instead of
      // registering another one at the provider on every click.
      const stored: StoredDynamicClient = {
        registrationEndpoint: plan.client.registrationEndpoint,
        redirectUri: callbackUrl,
        clientId: registration.clientId,
        ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
        tokenAuthMethod: registration.tokenAuthMethod,
        ...(registration.clientSecretExpiresAt
          ? { clientSecretExpiresAt: registration.clientSecretExpiresAt }
          : {}),
        registeredAt: new Date().toISOString(),
      };
      await deps.connectorsService.updateAuthConfigMerge(connector.id, {
        [DYNAMIC_CLIENT_KEY]: stored,
      });
    } else {
      clientId = plan.client.clientId;
      clientSecret = plan.client.clientSecret;
      tokenAuthMethod = plan.client.tokenAuthMethod;
      dynamicClient = plan.client.source === 'stored';
    }
  } else {
    // REST/GraphQL: the stored authConfig, with {{VAR}} resolved from the
    // connector's env vars, and — for a catalog connector installed before
    // its adapter could be authorized in the browser — the catalog's
    // endpoints where the row has none.
    const adapterSlug = (connector.config as { adapterSlug?: string } | null)
      ?.adapterSlug;
    const catalogAdapter = adapterSlug ? getAdapter(adapterSlug) : undefined;
    const catalogAuth = catalogAdapter?.connector.authConfig;
    const settings = resolveRestAuthorizeSettings(
      authConfig,
      connector.envVars as Record<string, string> | null,
      catalogAuth,
      catalogAdapter?.previousOAuthScopes,
    );
    if (settings.missingVars.length > 0) {
      return {
        error:
          `Set ${settings.missingVars.join(' and ')} in this connector's ` +
          'environment variables first: the provider needs the client ' +
          'credentials of your app to authorize it.',
      };
    }
    clientId = settings.clientId;
    clientSecret = settings.clientSecret;
    authorizationEndpoint = settings.authorizationUrl;
    tokenEndpoint = settings.tokenUrl;
    scope = settings.scope;
    tokenAuthMethod = settings.tokenAuthMethod;
    clientAssertion = settings.clientAssertion;
    pkce = settings.pkce;
    // The client id/secret stay as stored (placeholders included, so a
    // later env var edit still reaches them); only what was taken from
    // the catalog is added.
    persistAuthConfig = settings.adopted;
  }

  if (!clientId) {
    return { error: 'No clientId configured for this connector' };
  }
  if (!authorizationEndpoint) {
    return { error: 'No authorization URL configured for this connector' };
  }

  // The code exchange identifies itself like the connector's API calls.
  const flowVars = (connector.envVars as Record<string, string> | null) ?? {};
  const userAgent = tokenEndpointUserAgent(
    interpolateDeep(authConfig, flowVars),
    interpolateDeep(connector.headers ?? undefined, flowVars),
  );

  // Generate the PKCE challenge, unless the connector turned PKCE off.
  const codeVerifier = pkce ? deps.mcpOAuthService.generateCodeVerifier() : undefined;
  const codeChallenge = codeVerifier
    ? deps.mcpOAuthService.generateCodeChallenge(codeVerifier)
    : undefined;
  const state = deps.mcpOAuthService.generateState();

  // Store pending flow
  await deps.mcpOAuthService.storePendingFlow(state, {
    ...(codeVerifier ? { codeVerifier } : {}),
    connectorId: connector.id,
    userId: opts.userId,
    redirectUri: callbackUrl,
    clientId,
    clientSecret,
    tokenUrl: tokenEndpoint,
    tokenAuthMethod,
    clientAssertion,
    persistAuthConfig,
    ...(userAgent ? { userAgent } : {}),
    ...(resource ? { resource } : {}),
    ...(dynamicClient ? { dynamicClient } : {}),
    ...(opts.forUser ? { forUser: true } : {}),
    ...(opts.completeOn ? { completeOn: opts.completeOn } : {}),
    createdAt: Date.now(),
  }, { returnTo: opts.returnTo });

  // Build authorization URL
  const authorizationUrl = deps.mcpOAuthService.buildAuthorizationUrl({
    authorizationEndpoint,
    clientId,
    redirectUri: callbackUrl,
    codeChallenge,
    state,
    scope,
    resource,
  });

  return { authorizationUrl, state };}
