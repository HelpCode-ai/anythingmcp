import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type * as OidcClient from 'openid-client';
import { MSA_TENANT_ID } from '../../identity-providers/provider-config';
import { DeploymentService } from '../../common/deployment.service';

/**
 * Cloud social sign-in providers: Google, Microsoft (personal and work
 * accounts) and GitHub.
 *
 * Platform-wide, configured through environment variables, and enabled one by
 * one: a provider whose `SOCIAL_<P>_CLIENT_ID` / `SOCIAL_<P>_CLIENT_SECRET`
 * are not both set does not exist as far as the rest of the app is concerned.
 * This is unrelated to the per-organization enterprise SSO in
 * `identity-providers/`, which stays self-hosted only.
 */

/** The `openid-client` module, injected so specs can replace it (it is ESM-only). */
export type OidcLib = Pick<
  typeof OidcClient,
  'discovery' | 'Configuration' | 'buildAuthorizationUrl' | 'authorizationCodeGrant' | 'fetchProtectedResource'
>;
export const OIDC_LIB = Symbol('OIDC_LIB');

export const SOCIAL_PROVIDER_IDS = ['google', 'microsoft', 'github'] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export function isSocialProviderId(value: unknown): value is SocialProviderId {
  return typeof value === 'string' && (SOCIAL_PROVIDER_IDS as readonly string[]).includes(value);
}

/** What a provider tells us about the person who signed in. */
export interface SocialProfile {
  /** Immutable id at the provider. The only lookup key. */
  subject: string;
  /** Normalised later; null when the provider shared none. */
  email: string | null;
  /**
   * Whether the PROVIDER vouches that this person controls `email`. Only a
   * verified email may create an account or attach to an existing one.
   */
  emailVerified: boolean;
  name: string | null;
  /** Microsoft only: the `tid` claim. */
  tenantId?: string | null;
}

export interface AuthorizationParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface CompletionParams {
  /** The callback URL as received, rebuilt on the configured origin. */
  currentUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface SocialProviderAdapter {
  readonly id: SocialProviderId;
  /** Shown on the button: "Continue with <label>". */
  readonly label: string;
  authorizationUrl(params: AuthorizationParams): Promise<URL>;
  complete(params: CompletionParams): Promise<SocialProfile>;
}

/** A provider refused or returned something unusable. Never shown verbatim. */
export class SocialProviderError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Microsoft sends optional boolean claims as booleans or as strings. */
function truthyClaim(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

interface Credentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Builds the configuration once per process and reuses it. A failed discovery
 * is not cached, so the next sign-in retries instead of failing until restart.
 */
function cached<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

class GoogleProvider implements SocialProviderAdapter {
  readonly id = 'google' as const;
  readonly label = 'Google';
  private readonly config: () => Promise<OidcClient.Configuration>;

  constructor(private readonly lib: OidcLib, creds: Credentials) {
    this.config = cached(() =>
      lib.discovery(new URL('https://accounts.google.com'), creds.clientId, creds.clientSecret),
    );
  }

  async authorizationUrl(p: AuthorizationParams): Promise<URL> {
    return this.lib.buildAuthorizationUrl(await this.config(), {
      redirect_uri: p.redirectUri,
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  }

  async complete(p: CompletionParams): Promise<SocialProfile> {
    const tokens = await this.lib.authorizationCodeGrant(await this.config(), p.currentUrl, {
      pkceCodeVerifier: p.codeVerifier,
      expectedState: p.state,
      expectedNonce: p.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const subject = stringClaim(claims?.sub);
    if (!claims || !subject) throw new SocialProviderError('missing_subject');
    return {
      subject,
      email: stringClaim(claims.email),
      emailVerified: claims.email_verified === true,
      name: stringClaim(claims.name),
    };
  }
}

class MicrosoftProvider implements SocialProviderAdapter {
  readonly id = 'microsoft' as const;
  readonly label = 'Microsoft';
  private readonly config: () => Promise<OidcClient.Configuration>;

  constructor(private readonly lib: OidcLib, creds: Credentials) {
    // `/common` serves both personal Microsoft accounts and work or school
    // accounts of any tenant. Its metadata names a templated issuer
    // (`.../{tenantid}/v2.0`); openid-client recognises Entra discovery and
    // checks each id_token's `iss` against its own `tid`. That only happens
    // through `discovery()`: a hand-built Configuration would compare against
    // the literal template and refuse every sign-in.
    this.config = cached(() =>
      lib.discovery(
        new URL('https://login.microsoftonline.com/common/v2.0'),
        creds.clientId,
        creds.clientSecret,
      ),
    );
  }

  async authorizationUrl(p: AuthorizationParams): Promise<URL> {
    return this.lib.buildAuthorizationUrl(await this.config(), {
      redirect_uri: p.redirectUri,
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
      prompt: 'select_account',
    });
  }

  async complete(p: CompletionParams): Promise<SocialProfile> {
    // An RFC 9207 `iss` on the callback would be compared, as a string, with
    // the templated issuer and never match. The id_token's own `iss` is still
    // checked against its `tid`, and each provider has its own callback path,
    // which is what stops a mix-up.
    const currentUrl = new URL(p.currentUrl.href);
    currentUrl.searchParams.delete('iss');

    const tokens = await this.lib.authorizationCodeGrant(await this.config(), currentUrl, {
      pkceCodeVerifier: p.codeVerifier,
      expectedState: p.state,
      expectedNonce: p.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const subject = stringClaim(claims?.sub);
    const tenantId = stringClaim(claims?.tid);
    if (!claims || !subject) throw new SocialProviderError('missing_subject');
    if (!tenantId || !GUID.test(tenantId)) throw new SocialProviderError('missing_tenant');

    // Only the `email` claim, never `preferred_username`: in a work tenant
    // either can be set to any address by whoever administers that tenant
    // (the nOAuth attack). The address counts as verified only for personal
    // accounts, whose address Microsoft itself verified, or when the
    // `xms_edov` optional claim says the domain owner is verified.
    const email = stringClaim(claims.email);
    const emailVerified =
      !!email && (tenantId.toLowerCase() === MSA_TENANT_ID || truthyClaim(claims.xms_edov));
    return { subject, email, emailVerified, name: stringClaim(claims.name), tenantId };
  }
}

const GITHUB_API_HEADERS = () =>
  new Headers({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });

class GitHubProvider implements SocialProviderAdapter {
  readonly id = 'github' as const;
  readonly label = 'GitHub';
  private readonly config: OidcClient.Configuration;

  constructor(private readonly lib: OidcLib, creds: Credentials) {
    // Plain OAuth 2.0: GitHub publishes no discovery document and issues no
    // id_token, so the identity comes from its REST API.
    this.config = new lib.Configuration(
      {
        issuer: 'https://github.com/login/oauth',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
      },
      creds.clientId,
      creds.clientSecret,
    );
  }

  async authorizationUrl(p: AuthorizationParams): Promise<URL> {
    return this.lib.buildAuthorizationUrl(this.config, {
      redirect_uri: p.redirectUri,
      scope: 'read:user user:email',
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
  }

  async complete(p: CompletionParams): Promise<SocialProfile> {
    const tokens = await this.lib.authorizationCodeGrant(this.config, p.currentUrl, {
      pkceCodeVerifier: p.codeVerifier,
      expectedState: p.state,
    });
    const accessToken = tokens.access_token;

    const userRes = await this.lib.fetchProtectedResource(
      this.config,
      accessToken,
      new URL('https://api.github.com/user'),
      'GET',
      undefined,
      GITHUB_API_HEADERS(),
    );
    if (!userRes.ok) throw new SocialProviderError('profile_unavailable');
    const user = (await userRes.json()) as { id?: unknown; name?: unknown; login?: unknown };
    // The numeric id is permanent; the login can be renamed and reused.
    if (typeof user?.id !== 'number' && typeof user?.id !== 'string') {
      throw new SocialProviderError('missing_subject');
    }

    // The primary address, and only if GitHub verified it. A public profile
    // email is free text and proves nothing.
    let email: string | null = null;
    const emailsRes = await this.lib.fetchProtectedResource(
      this.config,
      accessToken,
      new URL('https://api.github.com/user/emails'),
      'GET',
      undefined,
      GITHUB_API_HEADERS(),
    );
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email?: unknown; primary?: unknown; verified?: unknown }>;
      const primary = Array.isArray(emails)
        ? emails.find((e) => e?.primary === true && e?.verified === true)
        : undefined;
      email = stringClaim(primary?.email);
    }

    return {
      subject: String(user.id),
      email,
      emailVerified: !!email,
      name: stringClaim(user.name) ?? stringClaim(user.login),
    };
  }
}

const FACTORIES: Record<SocialProviderId, (lib: OidcLib, creds: Credentials) => SocialProviderAdapter> = {
  google: (lib, creds) => new GoogleProvider(lib, creds),
  microsoft: (lib, creds) => new MicrosoftProvider(lib, creds),
  github: (lib, creds) => new GitHubProvider(lib, creds),
};

/** The providers this deployment has credentials for, in button order. */
@Injectable()
export class SocialProviderRegistry {
  private readonly logger = new Logger(SocialProviderRegistry.name);
  private readonly adapters = new Map<SocialProviderId, SocialProviderAdapter>();

  constructor(
    config: ConfigService,
    deployment: DeploymentService,
    @Inject(OIDC_LIB) lib: OidcLib,
  ) {
    // Cloud only. A self-hosted instance has the per-organization SSO instead,
    // and ignores these variables even if they are set.
    if (!deployment.isCloud()) return;
    for (const id of SOCIAL_PROVIDER_IDS) {
      const key = id.toUpperCase();
      const clientId = config.get<string>(`SOCIAL_${key}_CLIENT_ID`)?.trim();
      const clientSecret = config.get<string>(`SOCIAL_${key}_CLIENT_SECRET`)?.trim();
      if (!clientId || !clientSecret) continue;
      this.adapters.set(id, FACTORIES[id](lib, { clientId, clientSecret }));
    }
    if (this.adapters.size) {
      this.logger.log(`Social sign-in providers configured: ${[...this.adapters.keys()].join(', ')}`);
    }
  }

  /** The adapter for an enabled provider, or null. */
  get(id: unknown): SocialProviderAdapter | null {
    return isSocialProviderId(id) ? this.adapters.get(id) ?? null : null;
  }

  enabled(): { id: SocialProviderId; name: string }[] {
    return [...this.adapters.values()].map((a) => ({ id: a.id, name: a.label }));
  }
}
