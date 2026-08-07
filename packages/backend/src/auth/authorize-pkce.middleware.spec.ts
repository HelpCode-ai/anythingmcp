import { AuthorizePkceMiddleware } from './authorize-pkce.middleware';
import { createHash, randomBytes } from 'crypto';

describe('AuthorizePkceMiddleware', () => {
  let middleware: AuthorizePkceMiddleware;
  let next: jest.Mock;
  let res: any;

  /** A genuine S256 challenge, derived the way a conforming client would. */
  const s256 = (verifier: string) =>
    createHash('sha256').update(verifier).digest('base64url');

  const req = (query: Record<string, unknown>, method = 'GET') =>
    ({ method, query }) as any;

  beforeEach(() => {
    middleware = new AuthorizePkceMiddleware();
    next = jest.fn();
    res = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  const bodyOf = () => res.json.mock.calls[0][0];

  it('allows a conforming S256 authorization request', () => {
    const challenge = s256(randomBytes(32).toString('base64url'));

    middleware.use(
      req({ client_id: 'c1', code_challenge: challenge, code_challenge_method: 'S256' }),
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a request with no code_challenge', () => {
    middleware.use(req({ client_id: 'c1' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf().error).toBe('invalid_request');
    expect(bodyOf().error_description).toMatch(/code_challenge is required/);
  });

  it("rejects code_challenge_method 'plain'", () => {
    // `plain` puts the verifier in the clear on the authorization request, so
    // it defends against nothing an attacker who can read the request cannot
    // already do. Upstream defaults to exactly this when the method is absent.
    middleware.use(
      req({ code_challenge: s256('v'), code_challenge_method: 'plain' }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(bodyOf().error_description).toMatch(/S256/);
  });

  it('rejects a challenge with no method (upstream would assume plain)', () => {
    middleware.use(req({ code_challenge: s256('v') }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a malformed challenge', () => {
    middleware.use(
      req({ code_challenge: 'too-short', code_challenge_method: 'S256' }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(bodyOf().error_description).toMatch(/base64url/);
  });

  it('never redirects to a client-supplied redirect_uri', () => {
    // Redirecting on error would mean trusting an unvalidated client URI,
    // which is how an authorization endpoint becomes an open redirector.
    middleware.use(
      req({ client_id: 'c1', redirect_uri: 'https://evil.tld/cb' }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.header).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(JSON.stringify(bodyOf())).not.toContain('evil.tld');
  });

  it('leaves non-GET requests alone', () => {
    middleware.use(req({}, 'POST'), res, next);
    expect(next).toHaveBeenCalled();
  });
});
