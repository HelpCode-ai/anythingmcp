import {
  ResourceIndicatorMiddleware,
  parseServerId,
  MCP_RESOURCE_COOKIE,
} from './resource-indicator.middleware';

describe('parseServerId', () => {
  const CUID = 'cmpzj8mm9007j1ymn5mo2y3eq';

  it('extracts the server id from a per-server resource', () => {
    expect(parseServerId(`https://mcp.example.com/mcp/${CUID}`)).toBe(CUID);
  });

  it('returns null for the instance-wide resource', () => {
    // This is what @rekog/mcp-nest records for every flow today.
    expect(parseServerId('https://mcp.example.com/mcp')).toBeNull();
  });

  it.each([
    ['a non-URL', 'not-a-url'],
    ['an unrelated path', 'https://mcp.example.com/other/x'],
    ['extra path segments', `https://mcp.example.com/mcp/${CUID}/extra`],
    ['a traversal attempt', 'https://mcp.example.com/mcp/..%2Fadmin'],
    ['a non-cuid id', 'https://mcp.example.com/mcp/short'],
    ['an injection attempt', 'https://mcp.example.com/mcp/<script>'],
  ])('returns null for %s', (_label, value) => {
    expect(parseServerId(value)).toBeNull();
  });
});

describe('ResourceIndicatorMiddleware', () => {
  const CUID = 'cmpzj8mm9007j1ymn5mo2y3eq';
  let middleware: ResourceIndicatorMiddleware;
  let res: any;
  let next: jest.Mock;

  const req = (query: Record<string, unknown>, method = 'GET') =>
    ({ method, query, headers: {}, secure: false }) as any;

  beforeEach(() => {
    middleware = new ResourceIndicatorMiddleware();
    next = jest.fn();
    res = { cookie: jest.fn(), clearCookie: jest.fn() };
  });

  it('stores the server id in a signed httpOnly cookie', () => {
    middleware.use(
      req({ resource: `https://mcp.example.com/mcp/${CUID}` }),
      res,
      next,
    );

    expect(res.cookie).toHaveBeenCalledWith(
      MCP_RESOURCE_COOKIE,
      CUID,
      expect.objectContaining({ httpOnly: true, signed: true }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('clears a stale cookie when the resource is the global one', () => {
    // Otherwise a previous flow's server would still drive which identity
    // provider buttons get rendered.
    middleware.use(req({ resource: 'https://mcp.example.com/mcp' }), res, next);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith(MCP_RESOURCE_COOKIE);
  });

  it('clears the cookie when no resource is sent at all', () => {
    middleware.use(req({}), res, next);

    expect(res.clearCookie).toHaveBeenCalledWith(MCP_RESOURCE_COOKIE);
    expect(next).toHaveBeenCalled();
  });

  it('never lets a malformed resource reach the cookie', () => {
    middleware.use(
      req({ resource: 'https://mcp.example.com/mcp/<script>alert(1)</script>' }),
      res,
      next,
    );

    expect(res.cookie).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('always calls next — it must never block the authorization flow', () => {
    middleware.use(req({ resource: 12345 }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('parseAppEndpoint and the plugin endpoint cookie', () => {
  // Imported here so the suites above stay as they were.
  const { parseAppEndpoint, MCP_APP_COOKIE, ResourceIndicatorMiddleware: Middleware } =
    jest.requireActual('./resource-indicator.middleware') as typeof import('./resource-indicator.middleware');

  it('recognises the File Search plugin endpoint only', () => {
    expect(parseAppEndpoint('https://cloud.example.com/mcp/file-search')).toBe('file-search');
    expect(parseAppEndpoint('https://cloud.example.com/mcp/chatgpt-app')).toBeNull();
    expect(parseAppEndpoint('https://cloud.example.com/mcp')).toBeNull();
    expect(parseAppEndpoint('https://cloud.example.com/mcp/file-search/x')).toBeNull();
    expect(parseAppEndpoint('not a url')).toBeNull();
  });

  it('sets the app cookie for /mcp/file-search and clears it otherwise, leaving the server id alone', () => {
    const m = new Middleware();
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };
    m.use({ method: 'GET', query: { resource: 'https://h/mcp/file-search' }, headers: {}, secure: false } as any, res, jest.fn());
    expect(res.cookie).toHaveBeenCalledWith(MCP_APP_COOKIE, 'file-search', expect.objectContaining({ httpOnly: true, signed: true }));
    // Not a server id: the server cookie is cleared as for any other value.
    expect(res.clearCookie).toHaveBeenCalledWith(MCP_RESOURCE_COOKIE);

    const res2: any = { cookie: jest.fn(), clearCookie: jest.fn() };
    m.use({ method: 'GET', query: { resource: 'https://h/mcp/chatgpt-app' }, headers: {}, secure: false } as any, res2, jest.fn());
    expect(res2.cookie).not.toHaveBeenCalled();
    expect(res2.clearCookie).toHaveBeenCalledWith(MCP_APP_COOKIE);
  });
});
