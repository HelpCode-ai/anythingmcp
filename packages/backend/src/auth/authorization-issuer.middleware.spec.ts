import { AuthorizationIssuerMiddleware } from './authorization-issuer.middleware';
import { ConfigService } from '@nestjs/config';

describe('AuthorizationIssuerMiddleware', () => {
  let middleware: AuthorizationIssuerMiddleware;
  let res: any;
  let next: jest.Mock;
  let redirected: string | undefined;

  const req = (headers: Record<string, string> = { host: 'mcp.example.com' }) =>
    ({ headers, secure: false }) as any;

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue('http://localhost:4000'),
    } as unknown as ConfigService;
    middleware = new AuthorizationIssuerMiddleware(config);
    next = jest.fn();
    redirected = undefined;
    res = {
      redirect: jest.fn((...args: any[]) => {
        redirected = typeof args[0] === 'number' ? args[1] : args[0];
      }),
    };
  });

  it('appends iss to a successful authorization response', () => {
    middleware.use(req(), res, next);
    res.redirect('https://claude.ai/cb?code=abc&state=xyz');

    const url = new URL(redirected!);
    expect(url.searchParams.get('iss')).toBe('http://mcp.example.com');
    // The original parameters must survive untouched.
    expect(url.searchParams.get('code')).toBe('abc');
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('appends iss to an ERROR response too (RFC 9207 §2)', () => {
    middleware.use(req(), res, next);
    res.redirect('https://claude.ai/cb?error=access_denied');

    expect(new URL(redirected!).searchParams.get('iss')).toBe(
      'http://mcp.example.com',
    );
  });

  it('leaves internal hops alone', () => {
    // The strategy bounces /authorize to the login page; that is not an
    // authorization response and must not gain an iss parameter.
    middleware.use(req(), res, next);
    res.redirect('http://mcp.example.com/auth/login');

    expect(redirected).toBe('http://mcp.example.com/auth/login');
  });

  it('supports the redirect(status, url) overload', () => {
    middleware.use(req(), res, next);
    res.redirect(302, 'https://claude.ai/cb?code=abc');

    expect(new URL(redirected!).searchParams.get('iss')).toBe(
      'http://mcp.example.com',
    );
  });

  it('does not double-append when iss is already present', () => {
    middleware.use(req(), res, next);
    res.redirect('https://claude.ai/cb?code=abc&iss=https%3A%2F%2Fother');

    expect(new URL(redirected!).searchParams.getAll('iss')).toEqual([
      'https://other',
    ]);
  });

  it('honours the forwarded proto and host, matching the metadata document', () => {
    // If the issuer emitted here disagreed with the one advertised in
    // /.well-known, every conforming client would reject every response.
    middleware.use(
      req({ host: 'internal:4000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.example.com' }),
      res,
      next,
    );
    res.redirect('https://claude.ai/cb?code=abc');

    expect(new URL(redirected!).searchParams.get('iss')).toBe(
      'https://mcp.example.com',
    );
  });

  it('leaves an unparseable target untouched rather than break the flow', () => {
    middleware.use(req(), res, next);
    res.redirect('::::not a url');

    expect(redirected).toBe('::::not a url');
  });
});
