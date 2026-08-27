import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../common/ssrf.util';

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface PendingOAuthFlow {
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
   */
  tokenAuthMethod?: string;
  createdAt: number;
}

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  // In-memory store for pending OAuth flows, keyed by state.
  // Entries auto-expire after 10 minutes.
  private pendingFlows = new Map<string, PendingOAuthFlow>();

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
    const response = await axios.get(url, { timeout: 10000 });
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
      { timeout: 10000 },
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
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }> {
    const useBasic =
      params.tokenAuthMethod === 'basic' ||
      params.tokenAuthMethod === 'client_secret_basic';

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

    if (useBasic && params.clientSecret) {
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
      `Exchanging auth code at ${params.tokenUrl} (auth=${useBasic ? 'basic' : 'post'})`,
    );

    await assertSafeOutboundUrl(params.tokenUrl);
    const response = await axios.post(
      params.tokenUrl,
      new URLSearchParams(body).toString(),
      {
        headers,
        timeout: 10000,
      },
    );

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

  storePendingFlow(state: string, data: PendingOAuthFlow): void {
    // Clean up expired entries (>10 min)
    const now = Date.now();
    for (const [key, flow] of this.pendingFlows) {
      if (now - flow.createdAt > 10 * 60 * 1000) {
        this.pendingFlows.delete(key);
      }
    }

    this.pendingFlows.set(state, data);
  }

  getPendingFlow(state: string): PendingOAuthFlow | undefined {
    const flow = this.pendingFlows.get(state);
    if (!flow) return undefined;

    // Check expiry
    if (Date.now() - flow.createdAt > 10 * 60 * 1000) {
      this.pendingFlows.delete(state);
      return undefined;
    }

    return flow;
  }

  deletePendingFlow(state: string): void {
    this.pendingFlows.delete(state);
  }
}
