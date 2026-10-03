import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../common/ssrf.util';
import {
  clientAssertionParams,
  isPrivateKeyJwt,
  type ClientAssertionSettings,
} from './engines/client-assertion.util';
import { ssrfGuardedAxiosOptions } from '../common/guarded-http.util';

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
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
    candidates.push({
      url: `${actualOrigin}/.well-known/oauth-authorization-server`,
      protectedResource: false,
    });

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
          return metadata;
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
      return this.rebaseToOrigin(document as OAuthMetadata, actualOrigin);
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
      ...ssrfGuardedAxiosOptions(),
    });
    return response.data;
  }

  /**
   * Rebase endpoint URLs onto the MCP server's own origin when the metadata
   * reports a different one (e.g. a self-hosted server whose OAUTH_SERVER_URL
   * env var is misconfigured). Only applied to same-origin AS metadata — a
   * protected-resource document naming an external authorization server is
   * taken at face value.
   */
  private rebaseToOrigin(
    metadata: OAuthMetadata,
    actualOrigin: string,
  ): OAuthMetadata {
    const rebase = (endpoint: string): string => {
      try {
        const parsed = new URL(endpoint);
        if (parsed.origin !== actualOrigin) {
          this.logger.warn(
            `Rebasing OAuth endpoint from ${parsed.origin} → ${actualOrigin} (${parsed.pathname})`,
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
   */
  async registerClient(
    registrationEndpoint: string,
    callbackUrl: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    this.logger.debug(
      `Registering OAuth client at ${registrationEndpoint}`,
    );

    await assertSafeOutboundUrl(registrationEndpoint);
    const response = await axios.post(
      registrationEndpoint,
      {
        client_name: 'AnythingMCP Bridge',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
      { timeout: 10000, ...ssrfGuardedAxiosOptions() },
    );

    const clientId = response.data?.client_id;
    if (!clientId) {
      throw new Error(
        'Dynamic client registration failed: server did not return a client_id',
      );
    }

    return {
      clientId,
      clientSecret: response.data.client_secret,
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
  }): string {
    const url = new URL(params.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', params.state);
    if (params.scope) {
      url.searchParams.set('scope', params.scope);
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

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
    } else if (params.clientSecret) {
      // client_secret_post (default): credentials in the body.
      body.client_secret = params.clientSecret;
    }

    this.logger.debug(
      `Exchanging auth code at ${params.tokenUrl} (auth=${privateKeyJwt ? 'private_key_jwt' : useBasic ? 'basic' : 'post'})`,
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
          ...ssrfGuardedAxiosOptions(),
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
