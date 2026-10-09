import { McpAuthMiddleware } from './mcp-auth.middleware';
import { McpCombinedAuthGuard } from './mcp-combined-auth.guard';

/**
 * The MCP request pipeline per auth mode, as AppModule.configure wires it:
 * McpAuthMiddleware in front of McpCombinedAuthGuard in 'legacy' and 'both',
 * the guard alone in 'oauth2' (the Cloud). Each case runs both, in that order,
 * against the same configuration.
 */

const KEY_USER = {
  id: 'u1',
  email: 'a@b.com',
  role: 'EDITOR',
  organizationId: 'org-A',
  mcpRoleId: null,
  mcpServerId: 's1',
  apiKeyName: 'k',
};
const JWT = 'eyJhbGciOiJIUzI1NiJ9.e30.sig';
const KEY_HEADERS: Array<Record<string, string>> = [
  { 'x-api-key': 'mcp_valid' },
  { authorization: 'Bearer mcp_valid' },
];

type Env = Record<string, string | undefined>;

function harness(env: Env) {
  const config = { get: jest.fn((k: string) => env[k]) };
  const auth = {
    verifyToken: jest.fn((token: string) => {
      if (token === JWT) return { sub: 'u1', type: 'access', user_data: { id: 'u1', email: 'a@b.com' } };
      throw new Error('invalid token');
    }),
  };
  const apiKeys = {
    resolveUserByKey: jest.fn(async (key: string) => (key === 'mcp_valid' ? KEY_USER : null)),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'u1',
        organizationId: 'org-A',
        email: 'a@b.com',
        role: 'ADMIN',
        sessionsValidFrom: null,
      })),
      findFirst: jest.fn(),
    },
    oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const middleware = new McpAuthMiddleware(config as any, apiKeys as any);
  const guard = new McpCombinedAuthGuard(config as any, auth as any, apiKeys as any, prisma as any);
  return { middleware, guard, auth, apiKeys };
}

interface Outcome {
  allowed: boolean;
  /** Which step refused, when refused. */
  refusedBy?: 'middleware' | 'guard';
  status?: number;
  wwwAuthenticate?: string;
  user?: any;
}

async function send(
  env: Env,
  headers: Record<string, string> = {},
  opts: { method?: string; path?: string } = {},
): Promise<Outcome> {
  const { middleware, guard } = harness(env);
  const path = opts.path ?? '/mcp';
  const req: any = {
    method: opts.method ?? 'POST',
    path,
    url: path,
    headers: { host: 'mcp.example.com', ...headers },
  };
  const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const header = () =>
    res.setHeader.mock.calls.find((c: any[]) => c[0] === 'WWW-Authenticate')?.[1] as string | undefined;
  const status = () => res.status.mock.calls[0]?.[0] as number | undefined;

  const mode = env.MCP_AUTH_MODE || 'none';
  if (mode === 'legacy' || mode === 'both') {
    let passed = false;
    await middleware.use(req, res, () => {
      passed = true;
    });
    if (!passed) return { allowed: false, refusedBy: 'middleware', status: status(), wwwAuthenticate: header() };
  }
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  const allowed = await guard.canActivate(ctx);
  return allowed
    ? { allowed, user: req.user }
    : { allowed, refusedBy: 'guard', status: status(), wwwAuthenticate: header() };
}

describe("MCP auth, 'both' mode", () => {
  const both: Env = { MCP_AUTH_MODE: 'both' };

  it('accepts an OAuth access token without any static credential configured', async () => {
    const out = await send(both, { authorization: `Bearer ${JWT}` });
    expect(out.allowed).toBe(true);
    // Verified and resolved by the guard: the organization comes from the user row.
    expect(out.user).toMatchObject({ authMethod: 'jwt', sub: 'u1', organizationId: 'org-A' });
  });

  it('accepts a per-user mcp_ key, as X-API-Key and as a bearer token', async () => {
    for (const headers of KEY_HEADERS) {
      const out = await send(both, headers);
      expect(out.allowed).toBe(true);
      expect(out.user).toMatchObject({ authMethod: 'mcp_api_key', organizationId: 'org-A', mcpServerId: 's1' });
    }
  });

  it('answers a request without credentials with the 401 an OAuth client starts its flow from', async () => {
    for (const path of ['/mcp', '/mcp/srv-1']) {
      const out = await send(both, {}, { path });
      expect(out).toMatchObject({ allowed: false, refusedBy: 'guard', status: 401 });
      expect(out.wwwAuthenticate).toContain(
        `resource_metadata="http://mcp.example.com/.well-known/oauth-protected-resource${path}"`,
      );
    }
  });

  it('refuses an invalid token, saying it is invalid', async () => {
    const out = await send(both, { authorization: 'Bearer not-a-jwt' });
    expect(out).toMatchObject({ allowed: false, status: 401 });
    expect(out.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it('still accepts the static credentials when they are configured', async () => {
    const env = { ...both, MCP_API_KEY: 'static-key', MCP_BEARER_TOKEN: 'static-bearer' };
    expect((await send(env, { 'x-api-key': 'static-key' })).user).toEqual({ authMethod: 'static_api_key' });
    expect((await send(env, { authorization: 'Bearer static-bearer' })).user).toEqual({ authMethod: 'static_bearer' });
    expect((await send(env, { authorization: `Bearer ${JWT}` })).allowed).toBe(true);
  });

  it("decides every request exactly as 'oauth2' does", async () => {
    const cases: Array<[Record<string, string>, { method?: string; path?: string }]> = [
      [{ authorization: `Bearer ${JWT}` }, {}],
      [{ authorization: `Bearer ${JWT}` }, { path: '/mcp/srv-1' }],
      [{ 'x-api-key': 'mcp_valid' }, {}],
      [{ authorization: 'Bearer mcp_valid' }, {}],
      [{ authorization: 'Bearer mcp_unknown' }, {}],
      [{ authorization: 'Bearer garbage' }, {}],
      [{ 'x-api-key': 'garbage' }, {}],
      [{}, {}],
      [{}, { path: '/mcp/srv-1' }],
      [{}, { method: 'GET' }],
      [{}, { path: '/mcp/demo' }],
    ];
    for (const extra of [{}, { MCP_API_KEY: 'static-key', MCP_ALLOW_ANONYMOUS: 'true' }]) {
      for (const [headers, opts] of cases) {
        const viaBoth = await send({ MCP_AUTH_MODE: 'both', ...extra }, headers, opts);
        const viaOAuth2 = await send({ MCP_AUTH_MODE: 'oauth2', ...extra }, headers, opts);
        expect({ headers, opts, ...viaBoth }).toEqual({ headers, opts, ...viaOAuth2 });
      }
    }
  });
});

describe("MCP auth, 'oauth2' mode (the Cloud) is unchanged", () => {
  const oauth2: Env = { MCP_AUTH_MODE: 'oauth2' };

  it('is decided by the guard alone; the middleware would not even look at it', async () => {
    const { middleware, apiKeys } = harness(oauth2);
    const req: any = { headers: { authorization: 'Bearer mcp_valid' } };
    const next = jest.fn();
    await middleware.use(req, {} as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(apiKeys.resolveUserByKey).not.toHaveBeenCalled();
  });

  it('accepts OAuth tokens and mcp_ keys, and answers 401 with resource_metadata otherwise', async () => {
    expect((await send(oauth2, { authorization: `Bearer ${JWT}` })).user).toMatchObject({ authMethod: 'jwt' });
    expect((await send(oauth2, { 'x-api-key': 'mcp_valid' })).user).toMatchObject({ authMethod: 'mcp_api_key' });
    const none = await send(oauth2);
    expect(none).toMatchObject({ allowed: false, status: 401 });
    expect(none.wwwAuthenticate).toContain('resource_metadata=');
  });
});

describe("MCP auth, 'legacy' mode", () => {
  const legacy: Env = { MCP_AUTH_MODE: 'legacy' };

  it('refuses a request without credentials when no static credential is configured, as before', async () => {
    const out = await send(legacy);
    expect(out).toMatchObject({ allowed: false, refusedBy: 'middleware', status: 401 });
  });

  it('keeps refusing a token when no static credential is configured', async () => {
    const out = await send(legacy, { authorization: `Bearer ${JWT}` });
    expect(out).toMatchObject({ allowed: false, refusedBy: 'middleware', status: 401 });
  });

  it('allows anonymous requests only with MCP_ALLOW_ANONYMOUS=true', async () => {
    const out = await send({ ...legacy, MCP_ALLOW_ANONYMOUS: 'true' });
    expect(out.allowed).toBe(true);
    expect(out.user).toEqual({ authMethod: 'none' });
  });

  it('accepts the static key and the static bearer token', async () => {
    const env = { ...legacy, MCP_API_KEY: 'static-key', MCP_BEARER_TOKEN: 'static-bearer' };
    expect((await send(env, { 'x-api-key': 'static-key' })).user).toEqual({ authMethod: 'static_api_key' });
    expect((await send(env, { authorization: 'Bearer static-bearer' })).user).toEqual({ authMethod: 'static_bearer' });
  });

  it('refuses a wrong static key, and a request with none, when one is configured', async () => {
    const env = { ...legacy, MCP_API_KEY: 'static-key' };
    expect(await send(env, { 'x-api-key': 'wrong' })).toMatchObject({ allowed: false, refusedBy: 'middleware', status: 401 });
    expect(await send(env)).toMatchObject({ allowed: false, refusedBy: 'middleware', status: 401 });
  });

  it('accepts a per-user mcp_ key, with or without static credentials', async () => {
    for (const env of [legacy, { ...legacy, MCP_API_KEY: 'static-key' }]) {
      for (const headers of KEY_HEADERS) {
        const out = await send(env, headers);
        expect(out.allowed).toBe(true);
        expect(out.user).toMatchObject({ authMethod: 'mcp_api_key', sub: 'u1', organizationId: 'org-A' });
      }
    }
  });

  it('refuses an unknown mcp_ key sent as a bearer token in the middleware', async () => {
    const out = await send({ ...legacy, MCP_API_KEY: 'static' }, { authorization: 'Bearer mcp_unknown' });
    expect(out).toMatchObject({ allowed: false, refusedBy: 'middleware', status: 401 });
  });

  it('leaves a JWT to the guard, which verifies it (revocation included)', async () => {
    const env = { ...legacy, MCP_API_KEY: 'static-key' };
    const ok = await send(env, { authorization: `Bearer ${JWT}` });
    expect(ok.user).toMatchObject({ authMethod: 'jwt', organizationId: 'org-A' });
    const bad = await send(env, { authorization: 'Bearer garbage' });
    expect(bad).toMatchObject({ allowed: false, refusedBy: 'guard', status: 401 });
  });

  it('keeps a static MCP_BEARER_TOKEN with an mcp_ prefix on the static path', async () => {
    const { middleware, apiKeys } = harness({ ...legacy, MCP_BEARER_TOKEN: 'mcp_static' });
    const req: any = { headers: { authorization: 'Bearer mcp_static' } };
    const next = jest.fn();
    await middleware.use(req, {} as any, next);
    expect(next).toHaveBeenCalled();
    expect(apiKeys.resolveUserByKey).not.toHaveBeenCalled();
    expect(req.user).toEqual({ authMethod: 'static_bearer' });
  });
});
