import {
  DYNAMIC_CLIENT_KEY,
  planMcpAuthorization,
  readMcpOAuthSettings,
  type McpAuthorizeInput,
} from './mcp-oauth-settings';
import type { OAuthMetadata } from './mcp-oauth.service';

const CALLBACK = 'https://cloud.anythingmcp.com/api/mcp-oauth/callback';

/** Shapes taken from the live servers (unauthenticated probes, 6 Oct 2026). */
const NOTION: OAuthMetadata = {
  issuer: 'https://mcp.notion.com',
  authorization_endpoint: 'https://mcp.notion.com/authorize',
  token_endpoint: 'https://mcp.notion.com/token',
  registration_endpoint: 'https://mcp.notion.com/register',
  scopes_supported: ['default'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  protectedResource: { resource: 'https://mcp.notion.com/mcp', scopesSupported: ['default'] },
};
const STRIPE: OAuthMetadata = {
  issuer: 'https://access.stripe.com/mcp',
  authorization_endpoint: 'https://access.stripe.com/mcp/oauth2/authorize',
  token_endpoint: 'https://access.stripe.com/mcp/oauth2/token',
  registration_endpoint: 'https://access.stripe.com/mcp/oauth2/register',
  scopes_supported: ['mcp'],
  token_endpoint_auth_methods_supported: ['none'],
  protectedResource: { resource: 'https://mcp.stripe.com' },
};
const GITHUB: OAuthMetadata = {
  issuer: 'https://github.com/login/oauth',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
  scopes_supported: ['offline_access'],
  protectedResource: {
    resource: 'https://api.githubcopilot.com/mcp/',
    scopesSupported: ['repo', 'read:org', 'read:user'],
  },
};
/** A server without a protected-resource document (MCP spec 2025-03-26). */
const LEGACY: OAuthMetadata = {
  issuer: 'https://mcp.example.com',
  authorization_endpoint: 'https://mcp.example.com/authorize',
  token_endpoint: 'https://mcp.example.com/token',
  registration_endpoint: 'https://mcp.example.com/register',
  scopes_supported: ['read', 'write'],
};

const plan = (over: Partial<McpAuthorizeInput>) =>
  planMcpAuthorization({
    metadata: NOTION,
    settings: {},
    authConfig: {},
    envVars: {},
    callbackUrl: CALLBACK,
    mcpUrl: 'https://mcp.notion.com/mcp',
    now: Date.UTC(2026, 9, 6),
    ...over,
  });

describe('readMcpOAuthSettings', () => {
  it('takes the row first, then the catalog, and ignores what it does not know', () => {
    expect(readMcpOAuthSettings({ mcpOAuth: { scope: '' } }, { mcpOAuth: { scope: 'x' } })).toEqual({ scope: '' });
    expect(readMcpOAuthSettings(null, { mcpOAuth: { registration: 'dcr', resource: false } })).toEqual({
      registration: 'dcr',
      resource: false,
    });
    expect(readMcpOAuthSettings({ mcpOAuth: { registration: 'bogus', extra: 1 } })).toEqual({});
    expect(readMcpOAuthSettings(undefined)).toEqual({});
  });
});

describe('planMcpAuthorization', () => {
  it('registers a client with the method the server supports (public-only Stripe gets none)', () => {
    const out = plan({ metadata: STRIPE, mcpUrl: 'https://mcp.stripe.com/' });
    expect(out).toEqual({
      ok: true,
      client: {
        source: 'register',
        registrationEndpoint: 'https://access.stripe.com/mcp/oauth2/register',
        registerAuthMethod: 'none',
      },
      // The resource's own identifier, not the URL we happen to call.
      resource: 'https://mcp.stripe.com',
      scope: 'mcp',
    });
  });

  it('reuses the client it registered earlier instead of registering on every click (G6)', () => {
    const out = plan({
      authConfig: {
        [DYNAMIC_CLIENT_KEY]: {
          registrationEndpoint: 'https://mcp.notion.com/register',
          redirectUri: CALLBACK,
          clientId: 'kept',
          clientSecret: 'kept-secret',
          tokenAuthMethod: 'client_secret_post',
          registeredAt: '2026-10-01T00:00:00Z',
        },
      },
    });
    expect(out).toMatchObject({
      ok: true,
      client: { source: 'stored', clientId: 'kept', clientSecret: 'kept-secret', tokenAuthMethod: 'client_secret_post' },
    });
  });

  it('registers again when the stored client is for another server, another callback, or expired', () => {
    const stored = {
      registrationEndpoint: 'https://mcp.notion.com/register',
      redirectUri: CALLBACK,
      clientId: 'kept',
      tokenAuthMethod: 'none',
      registeredAt: '2026-10-01T00:00:00Z',
    };
    const source = (s: Record<string, unknown>) =>
      (plan({ authConfig: { [DYNAMIC_CLIENT_KEY]: { ...stored, ...s } } }) as any).client.source;
    expect(source({})).toBe('stored');
    expect(source({ registrationEndpoint: 'https://other.example.com/register' })).toBe('register');
    expect(source({ redirectUri: 'https://self-hosted.example.com/api/mcp-oauth/callback' })).toBe('register');
    expect(source({ clientSecretExpiresAt: Date.UTC(2026, 9, 5) / 1000 })).toBe('register');
  });

  it('uses a pre-registered client from env vars and skips registration (G4, G7)', () => {
    const out = plan({
      metadata: LEGACY,
      settings: { clientId: '{{ACME_CLIENT_ID}}', clientSecret: '{{ACME_CLIENT_SECRET}}', tokenAuthMethod: 'client_secret_basic' },
      envVars: { ACME_CLIENT_ID: 'typed-later', ACME_CLIENT_SECRET: 's3cret' },
    });
    expect(out).toMatchObject({
      ok: true,
      client: { source: 'preregistered', clientId: 'typed-later', clientSecret: 's3cret', tokenAuthMethod: 'client_secret_basic' },
    });
  });

  it('never registers when the adapter says preregistered, even if the server offers it (Salesforce)', () => {
    const out = plan({
      metadata: LEGACY,
      settings: { registration: 'preregistered', clientId: '{{SF_CLIENT_ID}}' },
      envVars: {},
    });
    expect(out.ok).toBe(false);
    expect((out as any).error).toContain('SF_CLIENT_ID');
    expect((out as any).error).toContain(CALLBACK);
  });

  it('falls back to registration in auto mode when the pre-registered variables are empty', () => {
    const out = plan({ settings: { clientId: '{{ACME_CLIENT_ID}}' }, envVars: { ACME_CLIENT_ID: '' } });
    expect((out as any).client.source).toBe('register');
  });

  it('names the redirect URI and the variables when there is no way to get a client', () => {
    const out = plan({ metadata: GITHUB, settings: { clientId: '{{GITHUB_OAUTH_CLIENT_ID}}' } });
    expect(out.ok).toBe(false);
    expect((out as any).error).toMatch(/GITHUB_OAUTH_CLIENT_ID/);
    expect((out as any).error).toContain(CALLBACK);
  });

  it('keeps the historical fallback: the stored client of a server without registration', () => {
    const out = plan({ metadata: GITHUB, authConfig: { clientId: 'cid', clientSecret: 'sec', tokenAuthMethod: 'basic' } });
    expect(out).toMatchObject({
      ok: true,
      client: { source: 'preregistered', clientId: 'cid', clientSecret: 'sec', tokenAuthMethod: 'basic' },
    });
  });

  it('refuses dcr mode on a server without a registration endpoint', () => {
    const out = plan({ metadata: GITHUB, settings: { registration: 'dcr' } });
    expect((out as any).error).toMatch(/does not offer dynamic client registration/);
  });

  describe('scope (G5)', () => {
    it("asks for the protected resource's scopes, not the authorization server's", () => {
      expect((plan({ metadata: GITHUB, authConfig: { clientId: 'c' } }) as any).scope).toBe('repo read:org read:user');
    });
    it('keeps the authorization server list for a server without a resource document', () => {
      expect((plan({ metadata: LEGACY }) as any).scope).toBe('read write');
    });
    it('lets the adapter fix the scope, or send none at all (Asana)', () => {
      expect((plan({ settings: { scope: 'mcp_api refresh_token' } }) as any).scope).toBe('mcp_api refresh_token');
      expect(plan({ settings: { scope: '' } })).not.toHaveProperty('scope');
    });
    it('lets the user override it in the OAuth settings', () => {
      expect((plan({ settings: { scope: '' }, authConfig: { scopes: 'read' } }) as any).scope).toBe('read');
    });
  });

  describe('resource (G2)', () => {
    it('is sent when the server publishes a protected-resource document', () => {
      expect((plan({}) as any).resource).toBe('https://mcp.notion.com/mcp');
    });
    it('falls back to the MCP URL when that document has no resource field', () => {
      const metadata = { ...NOTION, protectedResource: { scopesSupported: ['default'] } };
      expect((plan({ metadata }) as any).resource).toBe('https://mcp.notion.com/mcp');
    });
    it('is not sent to a server without one, unless the adapter asks', () => {
      expect(plan({ metadata: LEGACY })).not.toHaveProperty('resource');
      expect((plan({ metadata: LEGACY, settings: { resource: true }, mcpUrl: 'https://mcp.example.com/mcp' }) as any).resource).toBe(
        'https://mcp.example.com/mcp',
      );
    });
    it('can be switched off or fixed by the adapter', () => {
      expect(plan({ settings: { resource: false } })).not.toHaveProperty('resource');
      expect((plan({ settings: { resource: 'https://r.example.com' } }) as any).resource).toBe('https://r.example.com');
    });
  });
});
