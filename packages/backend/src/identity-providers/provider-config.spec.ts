import {
  parseProviderConfig,
  deriveIssuer,
  assertIssuerAllowed,
  ProviderConfigError,
  IssuerNotAllowedError,
  MSA_TENANT_ID,
} from './provider-config';

describe('parseProviderConfig — ENTRA tenantId', () => {
  const GUID = 'aaaabbbb-cccc-dddd-eeee-ffff11112222';

  it('accepts a tenant GUID', () => {
    expect(parseProviderConfig('ENTRA', { tenantId: GUID })).toEqual({
      tenantId: GUID,
    });
  });

  it.each([
    ['a directory name', 'contoso.onmicrosoft.com'],
    ['the /common authority', 'common'],
    ['a path traversal', '../../evil.tld/x'],
    ['a full URL', 'https://evil.tld/.well-known/openid-configuration'],
    ['an empty value', ''],
  ])('rejects %s', (_label, tenantId) => {
    // SECURITY: a non-GUID here becomes part of a URL the server fetches, so a
    // loose field is a path to an attacker-chosen JWKS — i.e. forged id_tokens.
    expect(() => parseProviderConfig('ENTRA', { tenantId })).toThrow(
      ProviderConfigError,
    );
  });

  it('rejects the personal-account tenant', () => {
    // Every consumer Microsoft account lives in this one tenant, so `tid`
    // stops discriminating between customers.
    expect(() =>
      parseProviderConfig('ENTRA', { tenantId: MSA_TENANT_ID }),
    ).toThrow(/personal Microsoft account/);
  });

  it('rejects a missing tenantId', () => {
    expect(() => parseProviderConfig('ENTRA', {})).toThrow(ProviderConfigError);
  });
});

describe('parseProviderConfig — other types', () => {
  it('requires an Auth0 roles namespace to be a URL', () => {
    // Auth0 drops non-namespaced custom claims SILENTLY: the login succeeds and
    // the roles are simply absent. Validating here turns that into a config
    // error instead of an authorization one.
    expect(() =>
      parseProviderConfig('AUTH0', { rolesClaimNamespace: 'roles' }),
    ).toThrow(ProviderConfigError);
    expect(
      parseProviderConfig('AUTH0', {
        rolesClaimNamespace: 'https://app.example.com/roles',
      }),
    ).toEqual({ rolesClaimNamespace: 'https://app.example.com/roles' });
  });

  it('accepts an empty config for types with only optional settings', () => {
    expect(parseProviderConfig('GOOGLE', {})).toEqual({});
    expect(parseProviderConfig('OIDC', undefined)).toEqual({});
  });

  it('rejects an unknown type', () => {
    expect(() => parseProviderConfig('LDAP', {})).toThrow(ProviderConfigError);
  });
});

describe('deriveIssuer', () => {
  it('builds a SINGLE-TENANT Entra authority', () => {
    // Never /common or /organizations: those publish a TEMPLATED issuer, and
    // validating a token against a template is the wildcard-issuer pitfall
    // that lets any tenant's token through.
    expect(
      deriveIssuer('ENTRA', { tenantId: 'AAAABBBB-CCCC-DDDD-EEEE-FFFF11112222' }),
    ).toBe(
      'https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffff11112222/v2.0',
    );
  });

  it('fixes the issuer for Google and GitHub', () => {
    expect(deriveIssuer('GOOGLE', {})).toBe('https://accounts.google.com');
    expect(deriveIssuer('GITHUB', {})).toBe('https://github.com');
  });

  it('returns null where the admin must supply one', () => {
    expect(deriveIssuer('OKTA', {})).toBeNull();
    expect(deriveIssuer('AUTH0', {})).toBeNull();
    expect(deriveIssuer('OIDC', {})).toBeNull();
  });
});

describe('assertIssuerAllowed', () => {
  const cloud = { allowArbitraryIssuer: false };
  const selfHost = { allowArbitraryIssuer: true };

  it('accepts the Microsoft login host', () => {
    expect(() =>
      assertIssuerAllowed(
        'ENTRA',
        'https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffff11112222/v2.0',
        cloud,
      ),
    ).not.toThrow();
  });

  it('rejects another host claiming to be Entra', () => {
    expect(() =>
      assertIssuerAllowed('ENTRA', 'https://evil.tld/tenant/v2.0', cloud),
    ).toThrow(IssuerNotAllowedError);
  });

  it('accepts an Okta subdomain and rejects a lookalike', () => {
    expect(() =>
      assertIssuerAllowed('OKTA', 'https://acme.okta.com', cloud),
    ).not.toThrow();
    expect(() =>
      assertIssuerAllowed('OKTA', 'https://acme.okta.com.evil.tld', cloud),
    ).toThrow(IssuerNotAllowedError);
  });

  it('rejects http', () => {
    expect(() =>
      assertIssuerAllowed('OKTA', 'http://acme.okta.com', cloud),
    ).toThrow(/https/);
  });

  it('refuses a free-form issuer in cloud but allows it self-hosted', () => {
    // An arbitrary issuer is a server-side fetch to a host the workspace admin
    // picked — fine where they own the infrastructure, disproportionate in a
    // shared deployment.
    expect(() =>
      assertIssuerAllowed('OIDC', 'https://keycloak.internal/realms/x', cloud),
    ).toThrow(/self-hosted/);
    expect(() =>
      assertIssuerAllowed('OIDC', 'https://keycloak.internal/realms/x', selfHost),
    ).not.toThrow();
  });

  it('rejects a malformed issuer', () => {
    expect(() => assertIssuerAllowed('OIDC', 'not a url', selfHost)).toThrow(
      IssuerNotAllowedError,
    );
  });
});
