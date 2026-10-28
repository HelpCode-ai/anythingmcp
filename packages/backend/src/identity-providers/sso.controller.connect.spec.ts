// `openid-client` v6 is ESM-only and Jest cannot parse it; the controller
// imports SsoService (the connect page's sign-in), whose network half these
// tests do not exercise.
jest.mock('openid-client', () => ({}));
import { SsoController } from './sso.controller';
import { SsoError } from './sso.service';

/** The SSO callback for a sign-in started on the connect page (/auth/connect). */
describe('SsoController — connect page sign-in', () => {
  const frontend = 'https://aibridge.example.com';

  function setup(complete: jest.Mock) {
    const controller = new SsoController(
      { complete } as any,
      { get: (k: string) => (k === 'FRONTEND_URL' ? frontend : undefined) } as any,
      { log: jest.fn() } as any,
    );
    const res: any = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
      setHeader: jest.fn(),
    };
    const req: any = {
      originalUrl: '/auth/sso/callback?code=c&state=s',
      headers: { 'x-forwarded-proto': 'https' },
      cookies: {},
      signedCookies: { connect_sso: JSON.stringify({ b: 'binding-1', c: 'conn-1' }) },
      ip: '10.0.0.1',
    };
    return { controller, req, res };
  }

  it('passes the binding cookie to the service and pins the user to the connect page', async () => {
    const complete = jest.fn().mockResolvedValue({
      kind: 'CONNECT',
      userId: 'u1',
      returnTo: '/auth/connect/conn-1',
    });
    const { controller, req, res } = setup(complete);

    await controller.callback(req, res);

    expect(complete.mock.calls[0][1]).toMatchObject({ connectBinding: 'binding-1' });
    const [name, value, options] = res.cookie.mock.calls[0];
    expect(name).toBe('connect_user');
    expect(JSON.parse(value)).toMatchObject({ uid: 'u1' });
    // Valid on the connect page only, signed, not readable by scripts.
    expect(options).toMatchObject({ path: '/auth/connect', httpOnly: true, signed: true, sameSite: 'lax' });
    expect(res.clearCookie).toHaveBeenCalledWith('connect_sso', { path: '/auth' });
    expect(res.redirect).toHaveBeenCalledWith(303, `${frontend}/auth/connect/conn-1`);
  });

  it('sends a failed connect sign-in back to the connect page, not to the dashboard login', async () => {
    const complete = jest.fn().mockRejectedValue(new SsoError('connect_binding_mismatch', 'Sign-in failed', true));
    const { controller, req, res } = setup(complete);

    await controller.callback(req, res);

    expect(res.cookie).not.toHaveBeenCalled();
    const [status, url] = res.redirect.mock.calls[0];
    expect(status).toBe(303);
    expect(url).toMatch(new RegExp(`^${frontend}/auth/connect/conn-1\\?error=`));
  });
});
