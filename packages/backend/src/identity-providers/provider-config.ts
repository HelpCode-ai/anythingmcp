import { z } from 'zod';

/**
 * Per-type validation for identity-provider configuration.
 *
 * This file is the trust boundary for SSO configuration. Everything here is
 * supplied by a workspace admin, and the values end up driving a server-side
 * fetch (OIDC discovery, JWKS) and the issuer check on a signed token — so a
 * loose field is not a usability problem, it is a forgery primitive.
 */

/** Exactly the Entra tenant GUID shape. Nothing else may reach a URL. */
export const ENTRA_TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The consumer/personal-account tenant. A B2B workspace must not accept it:
 * every personal Microsoft account lives in this one tenant, so `tid` stops
 * discriminating between customers entirely.
 */
export const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/**
 * Hosts allowed to serve discovery and JWKS, per provider type.
 *
 * HARDCODED on purpose. The instance already has `SsrfPolicyService`, but its
 * allowlist is instance-wide and editable by ANY workspace admin through
 * `PUT /api/admin/settings/ssrf-allowed-hosts` — using it here would let the
 * attacker choose their own destination. A fixed list per type cannot be
 * widened from inside the product.
 *
 * `null` means "no fixed host" and is only reachable for the generic OIDC type,
 * which is self-host only.
 */
const ALLOWED_ISSUER_HOSTS: Record<string, string[] | null> = {
  // Only the commercial cloud. Sovereign clouds are NOT reachable: `deriveIssuer`
  // hardcodes this host for ENTRA and discards any admin-supplied issuer, so
  // listing them here would be dead entries implying support that does not
  // exist. Supporting them means changing `deriveIssuer`, not this list.
  ENTRA: ['login.microsoftonline.com'],
  GOOGLE: ['accounts.google.com'],
  GITHUB: ['github.com'],
  OKTA: null, // customer-specific subdomain; suffix-checked below
  AUTH0: null, // customer-specific subdomain, plus custom domains
  OIDC: null,
};

/** Suffixes accepted when a type has no fixed host but a known domain family. */
const ALLOWED_ISSUER_SUFFIXES: Record<string, string[] | undefined> = {
  OKTA: ['.okta.com', '.oktapreview.com', '.okta-emea.com'],
  // No suffix list: Auth0 custom domains are the norm, so `.auth0.com` would
  // reject most real tenants. The consequence is that AUTH0 falls through to
  // the `allowArbitraryIssuer` gate below and is therefore SELF-HOST ONLY,
  // exactly like OIDC. Offering it in cloud requires a domain-verification
  // step, not a wider suffix list.
  AUTH0: undefined,
};

export const entraConfigSchema = z.object({
  tenantId: z
    .string()
    // Lowercased here so the stored config and the derived issuer can never
    // disagree in case. Entra emits `tid` lowercase, and a later comparison
    // against a stored uppercase GUID would silently fail to match.
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(
      ENTRA_TENANT_ID_RE,
      'tenantId must be the tenant GUID (a directory name or URL is not accepted)',
    ))
    .refine(
      (v) => v.toLowerCase() !== MSA_TENANT_ID,
      'The personal Microsoft account tenant cannot be used: every consumer account shares it, so it identifies no organization',
    ),
});

export const googleConfigSchema = z.object({
  /**
   * Google Workspace `hd` claim. Without it Google is NOT authoritative for a
   * non-gmail.com address, so leaving this empty means any Google account can
   * sign in — which is almost never what a workspace wants.
   */
  hostedDomain: z.string().min(1).optional(),
});

export const oktaConfigSchema = z.object({
  /** Custom authorization server; omitted means the org server. */
  authorizationServerId: z.string().min(1).optional(),
});

export const auth0ConfigSchema = z.object({
  /**
   * Auth0 drops custom claims that are not namespaced, SILENTLY — the login
   * still succeeds, the roles simply are not there. Requiring the namespace
   * up front turns that into a configuration error instead of an
   * authorization one.
   */
  rolesClaimNamespace: z
    .string()
    .url('Must be a URL you control, e.g. https://your-app.example.com/roles')
    .optional(),
});

export const githubConfigSchema = z.object({
  /** Restrict sign-in to members of one GitHub organization. */
  organization: z.string().min(1).optional(),
});

export const oidcConfigSchema = z.object({
  /** Keycloak and friends let the operator name this claim; it is not fixed. */
  groupsClaimName: z.string().min(1).optional(),
});

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  ENTRA: entraConfigSchema,
  GOOGLE: googleConfigSchema,
  OKTA: oktaConfigSchema,
  AUTH0: auth0ConfigSchema,
  GITHUB: githubConfigSchema,
  OIDC: oidcConfigSchema,
};

export class ProviderConfigError extends Error {}

/** Validates the `config` blob for a provider type, returning the parsed value. */
export function parseProviderConfig(
  type: string,
  config: unknown,
): Record<string, unknown> {
  const schema = SCHEMAS[type];
  if (!schema) throw new ProviderConfigError(`Unknown provider type '${type}'`);

  const result = schema.safeParse(config ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw new ProviderConfigError(detail);
  }
  return result.data as Record<string, unknown>;
}

/**
 * Derives the issuer for types where we — not the admin — decide it, so there
 * is nothing to get wrong or to smuggle a hostile URL through.
 *
 * Returns null when the type genuinely needs an admin-supplied issuer.
 */
export function deriveIssuer(
  type: string,
  config: Record<string, unknown>,
): string | null {
  switch (type) {
    case 'ENTRA':
      // Single-tenant authority. Never `/common` or `/organizations`: those
      // return a TEMPLATED issuer, and validating against a template is the
      // "wildcard issuer" pitfall that lets any tenant's token through.
      return `https://login.microsoftonline.com/${String(config.tenantId).toLowerCase()}/v2.0`;
    case 'GOOGLE':
      return 'https://accounts.google.com';
    case 'GITHUB':
      // Not an OIDC issuer — GitHub does not issue id_tokens for user sign-in.
      // Recorded for consistency; the GitHub adapter identifies the user
      // through the REST API instead.
      return 'https://github.com';
    default:
      return null;
  }
}

export class IssuerNotAllowedError extends Error {}

/**
 * Rejects an issuer whose host is not permitted for the provider type.
 *
 * Runs BEFORE any network call, so a hostile value never becomes a request.
 */
export function assertIssuerAllowed(
  type: string,
  issuer: string,
  opts: { allowArbitraryIssuer: boolean },
): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new IssuerNotAllowedError('Issuer must be an absolute https URL');
  }

  if (url.protocol !== 'https:') {
    throw new IssuerNotAllowedError('Issuer must use https');
  }

  // The issuer is concatenated with `/.well-known/openid-configuration` and is
  // compared byte-for-byte against the `iss` claim, so anything beyond scheme,
  // host and path either breaks that probe or weakens the comparison:
  //   - a query string swallows the well-known path (`…?a=b/.well-known/…`),
  //     so the probe silently hits the wrong URL and "test passed" means nothing;
  //   - userinfo would attach admin-supplied credentials to the outbound call;
  //   - a port reaches a different service on an allowlisted host.
  if (url.username || url.password) {
    throw new IssuerNotAllowedError('Issuer must not contain credentials');
  }
  if (url.port) {
    throw new IssuerNotAllowedError('Issuer must not specify a port');
  }
  if (url.search || url.hash) {
    throw new IssuerNotAllowedError(
      'Issuer must not contain a query string or fragment',
    );
  }

  const host = url.hostname.toLowerCase();
  const exact = ALLOWED_ISSUER_HOSTS[type];

  if (exact) {
    if (!exact.includes(host)) {
      throw new IssuerNotAllowedError(
        `Issuer host '${host}' is not valid for ${type}. Expected one of: ${exact.join(', ')}`,
      );
    }
    return;
  }

  const suffixes = ALLOWED_ISSUER_SUFFIXES[type];
  if (suffixes) {
    if (!suffixes.some((s) => host.endsWith(s))) {
      throw new IssuerNotAllowedError(
        `Issuer host '${host}' is not valid for ${type}. Expected a host ending in: ${suffixes.join(', ')}`,
      );
    }
    return;
  }

  // No fixed host for this type. An arbitrary, admin-supplied issuer means a
  // server-side fetch to a host they chose, which is a disproportionate
  // surface in a multi-tenant deployment — allowed only where the admin
  // already controls the infrastructure.
  if (!opts.allowArbitraryIssuer) {
    throw new IssuerNotAllowedError(
      `${type} requires an operator-configured issuer and is only available on self-hosted deployments`,
    );
  }
}
