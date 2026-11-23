// `openid-client` v6 is ESM-only and Jest cannot parse it; these tests do not
// exercise the network half of SsoService.
jest.mock('openid-client', () => ({}));
import { SsoController } from './sso.controller';
import { SsoError } from './sso.service';
import { LoginController } from '../auth/login.controller';

/** The SSO callback for a sign-in started on the MCP authorization page (/auth/login). */
describe('SsoController: sign-in for the MCP authorization page', () => {
  const frontend = 'https://mcp.example.com';
  const PROFILE = { id: 'u1', email: 'person@example.com', name: 'Person', username: 'person@example.com' };

  function setup(
    complete: jest.Mock,
    opts: { pages?: Partial<Record<'completeSsoSignIn' | 'hasPendingAuthorization', jest.Mock>> | null; signedCookies?: Record<string, string> } = {},
  ) {
    const pages =
      opts.pages === null
        ? null
        : {
            completeSsoSignIn: jest.fn(async (_req: any, res: any) => res.redirect(`${frontend}/callback`)),
            hasPendingAuthorization: jest.fn(async () => false),
            ...opts.pages,
          };
    const moduleRef = {
      get: jest.fn((token: unknown, options: unknown) => {
        expect(token).toBe(LoginController);
        expect(options).toEqual({ strict: false });
        if (!pages) throw new Error('Nest could not find LoginController');
        return pages;
      }),
    };
    const securityEvents = { log: jest.fn() };
    const controller = new SsoController(
      { complete } as any,
      { get: (k: string) => (k === 'FRONTEND_URL' ? frontend : undefined) } as any,
      securityEvents as any,
      moduleRef as any,
    );
    const res: any = {
      headersSent: false,
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
      setHeader: jest.fn(),
    };
    const req: any = {
      originalUrl: '/auth/sso/callback?code=c&state=s',
      headers: { 'x-forwarded-proto': 'https', host: 'mcp.example.com' },
      cookies: { oauth_session: 'sess-1' },
      signedCookies: opts.signedCookies ?? {},
      ip: '10.0.0.1',
    };
    return { controller, req, res, pages, securityEvents };
  }

  const target = (res: any) => {
    const call = res.redirect.mock.calls[0];
    return typeof call[0] === 'number' ? call[1] : call[0];
  };
  const failed = (surface: string | null, reason = 'token_exchange_failed') => {
    const error = new SsoError(reason);
    error.surface = surface;
    return jest.fn().mockRejectedValue(error);
  };

  it('hands the signed-in person to the authorization pages instead of going to /callback itself', async () => {
    const complete = jest.fn().mockResolvedValue({ kind: 'MCP', profile: PROFILE });
    const { controller, req, res, pages } = setup(complete);

    await controller.callback(req, res);

    // The session the browser presents now is what the service checks the attempt against.
    expect(complete.mock.calls[0][1]).toMatchObject({ oauthSessionId: 'sess-1' });
    expect(pages!.completeSsoSignIn).toHaveBeenCalledTimes(1);
    expect(pages!.completeSsoSignIn).toHaveBeenCalledWith(req, res, PROFILE);
    // No sign-in cookie from here: only the pages set it, after their checks.
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledTimes(1);
  });

  it('issues nothing when the authorization pages cannot be reached', async () => {
    const complete = jest.fn().mockResolvedValue({ kind: 'MCP', profile: PROFILE });
    const { controller, req, res, securityEvents } = setup(complete, { pages: null });

    await controller.callback(req, res);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(target(res)).toMatch(/^\/auth\/login\?error=/);
    expect(target(res)).not.toContain('callback');
    // The provider's part succeeded: not audited as a failed sign-in.
    expect(securityEvents.log).not.toHaveBeenCalled();
  });

  it('answers once when the pages fail after they have already answered', async () => {
    const complete = jest.fn().mockResolvedValue({ kind: 'MCP', profile: PROFILE });
    const { controller, req, res } = setup(complete, {
      pages: {
        completeSsoSignIn: jest.fn(async (_req: any, r: any) => {
          r.redirect('/somewhere');
          r.headersSent = true;
          throw new Error('late failure');
        }),
      },
    });

    await controller.callback(req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
  });

  it('sends a failed sign-in back to the authorization page, not to the dashboard sign-in', async () => {
    const { controller, req, res, pages } = setup(failed('MCP'));

    await controller.callback(req, res);

    expect(res.redirect.mock.calls[0][0]).toBe(303);
    expect(target(res)).toBe(
      `/auth/login?error=${encodeURIComponent('Sign-in failed. Please try again or contact your administrator.')}`,
    );
    // Known from the attempt itself: nothing else is asked.
    expect(pages!.hasPendingAuthorization).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('keeps the message that describes the instance, and no other cause', async () => {
    const seat = setup(failed('MCP', 'seat_limit'));
    await seat.controller.callback(seat.req, seat.res);
    expect(decodeURIComponent(target(seat.res))).toContain('no free user seats');

    const binding = setup(failed('MCP', 'mcp_session_binding_mismatch'));
    await binding.controller.callback(binding.req, binding.res);
    expect(decodeURIComponent(target(binding.res))).toBe(
      '/auth/login?error=Sign-in failed. Please try again or contact your administrator.',
    );
  });

  it('with the attempt unknown, goes to the authorization page only while one is pending in this browser', async () => {
    const pending = setup(failed(null, 'state_replayed_or_expired'), {
      pages: { hasPendingAuthorization: jest.fn(async () => true) },
    });
    await pending.controller.callback(pending.req, pending.res);
    expect(target(pending.res)).toMatch(/^\/auth\/login\?error=/);

    const none = setup(failed(null, 'state_replayed_or_expired'));
    await none.controller.callback(none.req, none.res);
    expect(target(none.res)).toMatch(new RegExp(`^${frontend}/login\\?error=`));

    const unreachable = setup(failed(null, 'state_replayed_or_expired'), { pages: null });
    await unreachable.controller.callback(unreachable.req, unreachable.res);
    expect(target(unreachable.res)).toMatch(new RegExp(`^${frontend}/login\\?error=`));
  });

  it('leaves a failed dashboard sign-in on the dashboard, whatever is pending', async () => {
    const { controller, req, res, pages } = setup(failed('DASHBOARD'), {
      pages: { hasPendingAuthorization: jest.fn(async () => true) },
    });

    await controller.callback(req, res);

    expect(target(res)).toMatch(new RegExp(`^${frontend}/login\\?error=`));
    expect(pages!.hasPendingAuthorization).not.toHaveBeenCalled();
  });

  it('leaves the other surfaces where they went: settings for a link, the connect page for a connect', async () => {
    const link = setup(failed('LINK', 'not_a_member'), { pages: { hasPendingAuthorization: jest.fn(async () => true) } });
    await link.controller.callback(link.req, link.res);
    expect(target(link.res)).toMatch(new RegExp(`^${frontend}/settings\\?linkError=`));

    const connect = setup(failed('CONNECT', 'connect_binding_mismatch'), {
      signedCookies: { connect_sso: JSON.stringify({ b: 'binding-1', c: 'conn-1' }) },
      pages: { hasPendingAuthorization: jest.fn(async () => true) },
    });
    await connect.controller.callback(connect.req, connect.res);
    expect(target(connect.res)).toMatch(new RegExp(`^${frontend}/auth/connect/conn-1\\?error=`));
  });

  it('an MCP failure goes to the authorization page even with a connect cookie left in the browser', async () => {
    const { controller, req, res } = setup(failed('MCP'), {
      signedCookies: { connect_sso: JSON.stringify({ b: 'binding-1', c: 'conn-1' }) },
    });

    await controller.callback(req, res);

    expect(target(res)).toMatch(/^\/auth\/login\?error=/);
  });
});
