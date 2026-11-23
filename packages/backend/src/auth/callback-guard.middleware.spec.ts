import type { Request, Response } from 'express';
import { CallbackGuardMiddleware } from './callback-guard.middleware';

function fakeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    cleared: [] as string[],
    redirected: undefined as string | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    clearCookie(name: string) {
      this.cleared.push(name);
      return this;
    },
    redirect(...args: any[]) {
      this.redirected = typeof args[0] === 'number' ? args[1] : args[0];
      return this;
    },
  };
  return res as Response & Record<string, any>;
}

function build(opts: { row?: { expiresAt: bigint } | null; fail?: boolean; cloud?: boolean } = {}) {
  const findUnique = jest.fn(async () => {
    if (opts.fail) throw new Error('db down');
    return opts.row === undefined ? { expiresAt: BigInt(Date.now() + 60_000) } : opts.row;
  });
  const log = jest.fn().mockResolvedValue(undefined);
  const middleware = new CallbackGuardMiddleware(
    { oAuthSession: { findUnique } } as any,
    { get: (key: string) => (key === 'FRONTEND_URL' ? 'https://cloud.example/' : undefined) } as any,
    { isCloud: () => opts.cloud ?? true } as any,
    { log } as any,
  );
  return { middleware, findUnique, log };
}

const run = async (middleware: CallbackGuardMiddleware, req: Partial<Request>) => {
  const res = fakeRes();
  const next = jest.fn();
  middleware.use({ method: 'GET', headers: {}, cookies: {}, ...req } as Request, res, next);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { res, next };
};

describe('CallbackGuardMiddleware', () => {
  it('lets a browser with an open authorization through to the callback', async () => {
    const { middleware, findUnique } = build();
    const { res, next } = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    expect(findUnique).toHaveBeenCalledWith({ where: { sessionId: 's1' }, select: { expiresAt: true } });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
  });

  it.each([
    ['no authorization cookie (a bookmark, a second press on Continue)', {}, undefined],
    ['an authorization that no longer exists (its code was issued)', { oauth_session: 's1' }, null],
    ['an authorization that expired', { oauth_session: 's1' }, { expiresAt: BigInt(Date.now() - 1000) }],
  ])('shows a page instead of the library\'s JSON for %s', async (_label, cookies, row) => {
    const { middleware, log } = build({ row: row as any });
    const { res, next } = await run(middleware, { cookies, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Mobile/15E148' } } as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toContain('<h1>This connection request is no longer open</h1>');
    expect(res.body).toContain('If AnythingMCP is not shown as connected there, press <strong>Connect</strong> again.');
    expect(res.body).toContain('href="https://cloud.example"');
    // The sign-in of that authorization has no further use.
    expect(res.cleared).toEqual(expect.arrayContaining(['login_user', 'login_bind']));
    expect(log).toHaveBeenCalledWith({ event: 'authorize_request_closed', metadata: { device: 'mobile', via: 'callback' } });
  });

  it('records nothing on a self-hosted instance', async () => {
    const { middleware, log } = build({ row: null, cloud: false });
    const { res } = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    expect(res.body).toContain('no longer open');
    expect(log).not.toHaveBeenCalled();
  });

  it('does not call a database problem an expired request', async () => {
    const { middleware } = build({ fail: true });
    const { res, next } = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
  });

  it('clears the sign-in once the code is on its way to the client, and only then', async () => {
    const { middleware } = build();
    // The strategy sending the browser to the sign-in page: nothing is cleared.
    const hop = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    hop.res.redirect('http://mcp.test/auth/login');
    expect(hop.res.cleared).toEqual([]);
    expect(hop.res.redirected).toBe('http://mcp.test/auth/login');
    // The authorization response.
    const done = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    done.res.redirect('https://claude.ai/api/mcp/auth_callback?code=abc&state=x');
    expect(done.res.cleared).toEqual(['login_user', 'login_bind', 'first_offer']);
    expect(done.res.redirected).toBe('https://claude.ai/api/mcp/auth_callback?code=abc&state=x');
    // Express's (status, url) form too.
    const withStatus = await run(middleware, { cookies: { oauth_session: 's1' } } as any);
    withStatus.res.redirect(302, 'cursor://anysphere.cursor-mcp/oauth/callback?code=abc');
    expect(withStatus.res.cleared).toContain('login_user');
  });

  it('only looks at GET', async () => {
    const { middleware, findUnique } = build({ row: null });
    const { next } = await run(middleware, { method: 'POST', cookies: {} } as any);
    expect(next).toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
