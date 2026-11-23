// `openid-client` v6 is ESM-only and Jest cannot parse it; these tests do not
// exercise the network half of SsoService.
jest.mock('openid-client', () => ({}));
import { SsoController } from './sso.controller';

/**
 * The SSO return of an MCP authorization and the client's connection grant.
 *
 * This sign-in writes no grant. But a client that already has one (from a
 * password or dashboard sign-in) and now asks for a further server by its URL
 * must get that server added: the per-server endpoint refuses a server outside
 * the grant, and signing in again has to be able to fix that.
 */
describe('SsoController — MCP authorization and the connection grant', () => {
  const profile = { id: 'u1', email: 'a@example.com', name: 'A', username: 'a@example.com' };

  function setup(opts: { requestedServerId?: string; grants?: any } = {}) {
    const grants =
      opts.grants === undefined ? { extendForAuthorization: jest.fn().mockResolvedValue(true) } : opts.grants;
    const controller = new SsoController(
      { complete: jest.fn().mockResolvedValue({ kind: 'MCP', profile }) } as any,
      { get: () => 'https://mcp.example.com' } as any,
      { log: jest.fn() } as any,
      grants ?? undefined,
    );
    jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
    const res: any = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
      setHeader: jest.fn(),
    };
    const req: any = {
      originalUrl: '/auth/sso/callback?code=c&state=s',
      headers: { 'x-forwarded-proto': 'https', host: 'mcp.example.com' },
      cookies: { oauth_session: 'sess-1' },
      signedCookies: opts.requestedServerId ? { mcp_resource: opts.requestedServerId } : {},
      ip: '10.0.0.1',
    };
    return { controller, grants, req, res };
  }

  const finished = (res: any) =>
    expect(res.redirect).toHaveBeenCalledWith(303, expect.stringMatching(/\/callback$/));

  it('adds the requested server to the grant of the client being authorized', async () => {
    const { controller, grants, req, res } = setup({ requestedServerId: 'cmsrvb00000000000000000bb' });
    await controller.callback(req, res);
    expect(grants.extendForAuthorization).toHaveBeenCalledWith('sess-1', 'u1', 'cmsrvb00000000000000000bb');
    finished(res);
  });

  it('touches no grant when the client named no server', async () => {
    const { controller, grants, req, res } = setup();
    await controller.callback(req, res);
    expect(grants.extendForAuthorization).not.toHaveBeenCalled();
    finished(res);
  });

  it('finishes the sign-in when the grant cannot be extended', async () => {
    const grants = { extendForAuthorization: jest.fn().mockRejectedValue(new Error('db down')) };
    const { controller, req, res } = setup({ requestedServerId: 'cmsrvb00000000000000000bb', grants });
    await controller.callback(req, res);
    finished(res);
  });

  it('works without the grant service', async () => {
    const { controller, req, res } = setup({ requestedServerId: 'cmsrvb00000000000000000bb', grants: null });
    await controller.callback(req, res);
    finished(res);
  });
});
