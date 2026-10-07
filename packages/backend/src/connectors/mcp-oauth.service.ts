import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { isIP } from 'net';
import { PrismaService } from '../common/prisma.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../common/ssrf.util';
import {
  clientAssertionParams,
  isPrivateKeyJwt,
  type ClientAssertionSettings,
} from './engines/client-assertion.util';
import { outboundAxiosOptions } from '../common/outbound-http';

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  /**
   * Set when the server published an RFC 9728 protected-resource document:
   * its `resource` identifier (what an RFC 8707 `resource` parameter must
   * carry) and the scopes it says a client needs. Not part of the
   * authorization server's own document.
   */
  protectedResource?: { resource?: string; scopesSupported?: string[] };
}

export interface PendingOAuthFlow {
  codeVerifier: string;
  connectorId: string;
  userId: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  /**
   * How the client authenticates at the token endpoint:
   *  - undefined / 'post' → client_id + client_secret in the request body
   *    (RFC 6749 client_secret_post) — the historical default.
   *  - 'basic'            → HTTP Basic Authorization header
   *    (client_secret_basic). Required by providers like DATEV that reject
   *    body credentials with 401 invalid_client.
   *  - 'private_key_jwt' → a JWT signed with the client's private key
   *    (RFC 7523), built from `clientAssertion` at exchange time.
   */
  tokenAuthMethod?: string;
  /** Signing settings for private_key_jwt (resolved; held in memory only). */
  clientAssertion?: ClientAssertionSettings;
  /**
   * The auth config fields the callback writes next to the issued tokens.
   * Unset (MCP connectors, whose client may come from dynamic registration),
   * the callback writes the client settings above, as it always has. REST and
   * GraphQL connectors set it: their client settings are already stored — as
   * typed, placeholders included, while the values above are resolved — so
   * only what the flow took from the catalog is added.
   */
  persistAuthConfig?: Record<string, unknown>;
  /**
   * The User-Agent the connector's API calls carry, sent on the code exchange
   * as well (see tokenEndpointUserAgent). Unset leaves the default.
   */
  userAgent?: string;
  /**
   * RFC 8707 resource indicator of the MCP server, sent with the code
   * exchange and stored for the refreshes. MCP connectors only.
   */
  resource?: string;
  /**
   * The client came from dynamic registration (MCP connectors): when the
   * token endpoint refuses it, the stored registration is dropped so the
   * next authorization registers a fresh one.
   */
  dynamicClient?: boolean;
  createdAt: number;
}

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  /**
   * Pending flows when no database is wired (unit tests). In the application
   * they live in `connector_oauth_attempts`, see storePendingFlow.
   */
  private memoryFlows = new Map<string, { flow: PendingOAuthFlow; returnTo?: string; expiresAt: number }>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Discover the OAuth metadata of a remote MCP server.
   *
   * An MCP server hosted under a path (Snowflake's managed servers,
   * AnythingMCP's own `/mcp/<serverId>` endpoints, …) publishes its metadata
   * at a *path-inserted* well-known URL: RFC 8414 §3.1 and RFC 9728 §3 put the
   * resource path after the well-known suffix, not before it. Looking only at
   * `<origin>/.well-known/oauth-authorization-server` — which is all this used
   * to do — therefore misses every such server (#501).
   *
   * Candidates are tried in order, first usable document wins, and the
   * origin-level URL stays last so nothing that works today regresses.
   */
  async discoverMetadata(baseUrl: string): Promise<OAuthMetadata> {
    const base = new URL(baseUrl);
    const actualOrigin = base.origin;
    const resourcePath = base.pathname.replace(/\/+$/, '');

    const candidates: Array<{ url: string; protectedResource: boolean }> = [];
    if (resourcePath) {
      candidates.push(
        // RFC 9728 — what current MCP clients look for first.
        {
          url: `${actualOrigin}/.well-known/oauth-protected-resource${resourcePath}`,
          protectedResource: true,
        },
        {
          url: `${actualOrigin}/.well-known/oauth-authorization-server${resourcePath}`,
          protectedResource: false,
        },
        {
          url: `${actualOrigin}/.well-known/openid-configuration${resourcePath}`,
          protectedResource: false,
        },
      );
    }
    // A server at the root of its host (Stripe, Apify) publishes its
    // protected-resource document there, and so may a path-hosted one whose
    // path-inserted URL is missing. Checked before the origin-level
    // authorization-server document, which is what older servers have.
    candidates.push(
      {
        url: `${actualOrigin}/.well-known/oauth-protected-resource`,
        protectedResource: true,
      },
      {
        url: `${actualOrigin}/.well-known/oauth-authorization-server`,
        protectedResource: false,
      },
    );

    const failures: string[] = [];

    for (const candidate of candidates) {
      let document: any;
      try {
        document = await this.fetchJson(candidate.url);
      } catch (err: any) {
        failures.push(`${candidate.url}: ${err.message}`);
        continue;
      }

      // A protected-resource document does not carry the endpoints itself; it
      // points at one or more authorization servers, which may legitimately
      // live on another origin.
      if (candidate.protectedResource) {
        const issuer = document?.authorization_servers?.[0];
        if (!issuer) {
          failures.push(`${candidate.url}: no authorization_servers entry`);
          continue;
        }
        try {
          const metadata = await this.fetchAuthorizationServerMetadata(issuer);
          this.logger.debug(
            `OAuth metadata for ${baseUrl} discovered via protected-resource document at ${candidate.url} (issuer ${issuer})`,
          );
          // No rebasing here: the resource explicitly named an external
          // authorization server, so its origin is intentional.
          return {
            ...metadata,
            protectedResource: {
              resource:
                typeof document.resource === 'string' ? document.resource : undefined,
              scopesSupported: Array.isArray(document.scopes_supported)
                ? document.scopes_supported.filter(
                    (v: unknown): v is string => typeof v === 'string',
                  )
                : undefined,
            },
          };
        } catch (err: any) {
          failures.push(`${issuer}: ${err.message}`);
          continue;
        }
      }

      if (!document?.authorization_endpoint || !document?.token_endpoint) {
        failures.push(`${candidate.url}: missing authorization/token endpoint`);
        continue;
      }

      this.logger.debug(
        `OAuth metadata for ${baseUrl} discovered at ${candidate.url}`,
      );
      return this.rebaseUnreachableEndpoints(document as OAuthMetadata, base);
    }

    throw new Error(
      `Could not discover OAuth metadata for ${baseUrl}. Tried: ${failures.join('; ')}`,
    );
  }

  /**
   * Fetch RFC 8414 metadata for an issuer, honouring path-insertion for
   * issuers that carry a path, then falling back to the OpenID Connect
   * discovery document.
   */
  private async fetchAuthorizationServerMetadata(
    issuer: string,
  ): Promise<OAuthMetadata> {
    const parsed = new URL(issuer);
    const issuerPath = parsed.pathname.replace(/\/+$/, '');

    const urls = [
      `${parsed.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${parsed.origin}/.well-known/openid-configuration${issuerPath}`,
      `${parsed.origin}${issuerPath}/.well-known/openid-configuration`,
    ];

    const failures: string[] = [];
    for (const url of urls) {
      try {
        const document = await this.fetchJson(url);
        if (document?.authorization_endpoint && document?.token_endpoint) {
          return document as OAuthMetadata;
        }
        failures.push(`${url}: missing authorization/token endpoint`);
      } catch (err: any) {
        failures.push(`${url}: ${err.message}`);
      }
    }

    throw new Error(`no usable metadata (${failures.join('; ')})`);
  }

  private async fetchJson(url: string): Promise<any> {
    await assertSafeOutboundUrl(url);
    const response = await axios.get(url, {
      timeout: 10000,
      ...outboundAxiosOptions(),
    });
    return response.data;
  }

  /**
   * Pull endpoints that cannot be reached from here back onto the MCP
   * server's origin.
   *
   * This exists for a self-hosted server whose public address is not what
   * it advertises: an MCP server behind a proxy with OAUTH_SERVER_URL left
   * at `http://localhost:4000` publishes endpoints nobody outside that
   * machine can open, while the same paths answer on the address we reached
   * it at.
   *
   * It used to rewrite *every* endpoint on another origin, which broke the
   * servers whose authorization server legitimately lives elsewhere and is
   * published at the origin level: Stripe (`access.stripe.com`), Apify
   * (`console.apify.com`), Slack (`slack.com`). Users were sent to
   * `https://mcp.stripe.com/mcp/oauth2/authorize`, which does not exist. Now
   * only an endpoint on a loopback, private or single-label host is moved,
   * and only when the MCP server itself is not on one (a local test setup
   * with the two on different local ports is left alone). Everything else
   * is taken as published: the token and registration requests go through
   * the SSRF guard like any other outbound call, and the authorization
   * endpoint, which only the user's browser opens, must be http(s) (see
   * buildAuthorizationUrl).
   */
  private rebaseUnreachableEndpoints(
    metadata: OAuthMetadata,
    mcpUrl: URL,
  ): OAuthMetadata {
    if (isLocalOnlyHost(mcpUrl.hostname)) return metadata;
    const actualOrigin = mcpUrl.origin;
    const rebase = (endpoint: string): string => {
      try {
        const parsed = new URL(endpoint);
        if (parsed.origin !== actualOrigin && isLocalOnlyHost(parsed.hostname)) {
          this.logger.warn(
            `Rebasing OAuth endpoint from ${parsed.origin} → ${actualOrigin} (${parsed.pathname}): the server advertises a host that is not reachable from here`,
          );
          return `${actualOrigin}${parsed.pathname}${parsed.search}`;
        }
        return endpoint;
      } catch {
        return endpoint;
      }
    };

    metadata.issuer = rebase(metadata.issuer);
    metadata.authorization_endpoint = rebase(metadata.authorization_endpoint);
    metadata.token_endpoint = rebase(metadata.token_endpoint);
    if (metadata.registration_endpoint) {
      metadata.registration_endpoint = rebase(metadata.registration_endpoint);
    }

    return metadata;
  }

  /**
   * Register as an OAuth client via RFC 7591 Dynamic Client Registration.
   *
   * `tokenAuthMethod` is how the client will authenticate at the token
   * endpoint (see chooseTokenAuthMethod): Stripe, Bright Data and Firecrawl
   * only take public clients (`none`), and asking them for
   * `client_secret_post` may be refused. What the server grants wins over
   * what was asked for.
   */
  async registerClient(
    registrationEndpoint: string,
    callbackUrl: string,
    opts: { tokenAuthMethod?: string; scope?: string } = {},
  ): Promise<RegisteredClient> {
    this.logger.debug(
      `Registering OAuth client at ${registrationEndpoint}`,
    );
    const requested = opts.tokenAuthMethod || 'client_secret_post';

    await assertSafeOutboundUrl(registrationEndpoint);
    const response = await axios.post(
      registrationEndpoint,
      {
        client_name: 'AnythingMCP Bridge',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: requested,
        ...(opts.scope ? { scope: opts.scope } : {}),
      },
      { timeout: 10000, ...outboundAxiosOptions() },
    );

    const clientId = response.data?.client_id;
    if (!clientId) {
      throw new Error(
        'Dynamic client registration failed: server did not return a client_id',
      );
    }
    const granted =
      typeof response.data.token_endpoint_auth_method === 'string'
        ? response.data.token_endpoint_auth_method
        : requested;
    const expiresAt = Number(response.data.client_secret_expires_at);

    return {
      clientId,
      // A public client has no secret to send, even if one came back.
      clientSecret: granted === 'none' ? undefined : response.data.client_secret,
      tokenAuthMethod: granted,
      ...(Number.isFinite(expiresAt) && expiresAt > 0
        ? { clientSecretExpiresAt: expiresAt }
        : {}),
    };
  }

  /**
   * Build the authorization URL with PKCE S256 challenge.
   */
  buildAuthorizationUrl(params: {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    scope?: string;
    /** RFC 8707 resource indicator (MCP servers). */
    resource?: string;
  }): string {
    const url = new URL(params.authorizationEndpoint);
    // The browser is sent here, and the address may come from a remote
    // server's metadata: nothing but a web page (no javascript:, data:, …).
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(
        `The authorization endpoint ${url.protocol}// is not a web address`,
      );
    }
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', params.state);
    if (params.scope) {
      url.searchParams.set('scope', params.scope);
    }
    if (params.resource) {
      url.searchParams.set('resource', params.resource);
    }
    return url.toString();
  }

  /**
   * Exchange an authorization code for tokens (with PKCE verifier).
   */
  async exchangeCodeForTokens(params: {
    tokenUrl: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    tokenAuthMethod?: string;
    clientAssertion?: ClientAssertionSettings;
    /** Sent as User-Agent; Reddit throttles generic agents at its token endpoint. */
    userAgent?: string;
    /** RFC 8707 resource indicator (MCP servers). */
    resource?: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }> {
    const useBasic =
      params.tokenAuthMethod === 'basic' ||
      params.tokenAuthMethod === 'client_secret_basic';
    const privateKeyJwt = isPrivateKeyJwt(params.tokenAuthMethod);

    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    };
    if (params.resource) body.resource = params.resource;

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (params.userAgent) headers['User-Agent'] = params.userAgent;

    if (privateKeyJwt) {
      // private_key_jwt (RFC 7523 §2.2): a JWT signed with the client's own
      // key replaces the secret. The client id is the assertion's `sub`;
      // Revolut Business documents the exchange without a client_id field.
      if (!params.clientAssertion) {
        throw new Error(
          'Token exchange failed: private_key_jwt is configured but no client assertion settings were found',
        );
      }
      delete body.client_id;
      Object.assign(body, clientAssertionParams(params.clientAssertion));
    } else if (useBasic && params.clientSecret) {
      // client_secret_basic (RFC 6749 §2.3.1): credentials go in the
      // Authorization header, NOT the body. Providers like DATEV reject a
      // body-supplied client_secret for confidential clients with 401.
      const basic = Buffer.from(
        `${params.clientId}:${params.clientSecret}`,
      ).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else if (params.clientSecret && params.tokenAuthMethod !== 'none') {
      // client_secret_post (default): credentials in the body. A public
      // client ('none') sends its client_id only.
      body.client_secret = params.clientSecret;
    }

    this.logger.debug(
      `Exchanging auth code at ${params.tokenUrl} (auth=${privateKeyJwt ? 'private_key_jwt' : useBasic ? 'basic' : params.tokenAuthMethod === 'none' ? 'none' : 'post'})`,
    );

    await assertSafeOutboundUrl(params.tokenUrl);
    let response;
    try {
      response = await axios.post(
        params.tokenUrl,
        new URLSearchParams(body).toString(),
        {
          headers,
          timeout: 10000,
          ...outboundAxiosOptions({ credentialsInBody: true }),
        },
      );
    } catch (err: any) {
      // Say what the provider said (RFC 6749 §5.2 error/error_description),
      // not only axios's "Request failed with status code 400": the reason
      // is usually a setting the user can fix, such as a wrong redirect URI
      // or an expired assertion.
      const status = err?.response?.status;
      const data = err?.response?.data;
      const reason =
        data && typeof data === 'object'
          ? [data.error, data.error_description, data.message]
              .filter((v: unknown) => typeof v === 'string' && v.length > 0)
              .map((v: string) => v.slice(0, 200))
          : [];
      if (typeof status === 'number') {
        throw new Error(
          `Token exchange failed: HTTP ${status}${reason.length ? `: ${[...new Set(reason)].join(': ')}` : ''}`,
        );
      }
      throw err;
    }

    const data = response.data;
    if (data.error) {
      throw new Error(`Token exchange failed: ${data.error} — ${data.error_description || ''}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  // --- PKCE Helpers ---

  generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
  }

  generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  generateState(): string {
    return randomBytes(16).toString('hex');
  }

  // --- Pending Flow Storage ---
  //
  // An authorization in flight is stored in the database (state hashed, the
  // rest encrypted), so it survives a restart or a blue/green deploy between
  // consent and callback. It is read twice: peeked by the provider callback,
  // which only forwards the code to the dashboard, and taken (deleted) by the
  // authenticated request that exchanges the code, after checking that the
  // same user started it.

  private stateHash(state: string): string {
    return createHash('sha256').update(state).digest('hex');
  }

  private encryptionKey(): string {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is not set');
    return key;
  }

  async storePendingFlow(
    state: string,
    data: PendingOAuthFlow,
    opts: { returnTo?: string } = {},
  ): Promise<void> {
    const expiresAt = Date.now() + PENDING_FLOW_TTL_MS;
    const returnTo = safeReturnTo(opts.returnTo);
    if (!this.prisma) {
      this.memoryFlows.set(state, { flow: data, returnTo, expiresAt });
      return;
    }
    await this.prisma.connectorOAuthAttempt
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);
    await this.prisma.connectorOAuthAttempt.create({
      data: {
        stateHash: this.stateHash(state),
        userId: data.userId,
        connectorId: data.connectorId,
        payload: encrypt(JSON.stringify(data), this.encryptionKey(), 'connector-oauth'),
        returnTo: returnTo ?? null,
        expiresAt: new Date(expiresAt),
      },
    });
  }

  /** The pending flow for `state`, without consuming it. */
  async getPendingFlow(state: string): Promise<PendingFlowRecord | undefined> {
    if (!state) return undefined;
    if (!this.prisma) {
      const hit = this.memoryFlows.get(state);
      if (!hit || hit.expiresAt < Date.now()) return undefined;
      return { flow: hit.flow, returnTo: hit.returnTo };
    }
    const row = await this.prisma.connectorOAuthAttempt.findUnique({
      where: { stateHash: this.stateHash(state) },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return this.toRecord(row);
  }

  /** The pending flow for `state`, deleted in the same step: usable once. */
  async takePendingFlow(state: string): Promise<PendingFlowRecord | undefined> {
    if (!state) return undefined;
    if (!this.prisma) {
      const hit = this.memoryFlows.get(state);
      this.memoryFlows.delete(state);
      if (!hit || hit.expiresAt < Date.now()) return undefined;
      return { flow: hit.flow, returnTo: hit.returnTo };
    }
    const row = await this.prisma.connectorOAuthAttempt
      .delete({ where: { stateHash: this.stateHash(state) } })
      .catch(() => null);
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return this.toRecord(row);
  }

  async deletePendingFlow(state: string): Promise<void> {
    await this.takePendingFlow(state);
  }

  private toRecord(row: { payload: string; returnTo: string | null }): PendingFlowRecord | undefined {
    try {
      const flow = JSON.parse(
        decrypt(row.payload, this.encryptionKey(), 'connector-oauth'),
      ) as PendingOAuthFlow;
      return { flow, returnTo: safeReturnTo(row.returnTo ?? undefined) };
    } catch (err: any) {
      this.logger.warn(`Unreadable pending OAuth flow: ${err?.message || err}`);
      return undefined;
    }
  }
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  /** What the server granted: `none`, `client_secret_post`, `client_secret_basic`. */
  tokenAuthMethod: string;
  /** Unix seconds; absent or 0 means the secret does not expire. */
  clientSecretExpiresAt?: number;
}

/**
 * How a dynamically registered client should authenticate at the token
 * endpoint, from what the authorization server advertises.
 *
 * `client_secret_post` stays the first choice when offered (what this always
 * asked for); a server that offers only public clients gets `none`.
 * RFC 8414 says an absent list means `client_secret_basic`, but servers that
 * omit it have always been registered with `client_secret_post` here, so that
 * stays.
 */
export function chooseTokenAuthMethod(supported: unknown): string {
  const list = Array.isArray(supported)
    ? supported.filter((v): v is string => typeof v === 'string')
    : [];
  if (list.length === 0 || list.includes('client_secret_post')) return 'client_secret_post';
  if (list.includes('client_secret_basic')) return 'client_secret_basic';
  if (list.includes('none')) return 'none';
  return 'client_secret_post';
}

/**
 * A host only reachable from the machine or network it lives on: loopback,
 * private and link-local addresses, `localhost`, `.local` / `.internal`
 * names and single-label names such as a Docker service (`backend`).
 */
export function isLocalOnlyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map((p) => parseInt(p, 10));
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      /^::ffff:(127|10|192\.168)\./.test(host)
    );
  }
  return !host.includes('.');
}

/** How long a started authorization waits for the user to come back. */
export const PENDING_FLOW_TTL_MS = 15 * 60 * 1000;

export interface PendingFlowRecord {
  flow: PendingOAuthFlow;
  /** Where the dashboard should land afterwards (internal path), if set. */
  returnTo?: string;
}

/**
 * An internal dashboard path, or undefined. Anything else (an absolute URL,
 * `//host`, a backslash trick) would be an open redirect.
 */
export function safeReturnTo(value: string | undefined | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  if (value.length > 500) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20)) return undefined;
  return value;
}
