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

  it('allows a conforming S256 authorization request', async () => {
    const challenge = s256(randomBytes(32).toString('base64url'));

    await middleware.use(
      req({ client_id: 'c1', code_challenge: challenge, code_challenge_method: 'S256' }),
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a request with no code_challenge', async () => {
    await middleware.use(req({ client_id: 'c1' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf().error).toBe('invalid_request');
    expect(bodyOf().error_description).toMatch(/code_challenge is required/);
  });

  it("rejects code_challenge_method 'plain'", async () => {
    // `plain` puts the verifier in the clear on the authorization request, so
    // it defends against nothing an attacker who can read the request cannot
    // already do. Upstream defaults to exactly this when the method is absent.
    await middleware.use(
      req({ code_challenge: s256('v'), code_challenge_method: 'plain' }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(bodyOf().error_description).toMatch(/S256/);
  });

  it('rejects a challenge with no method (upstream would assume plain)', async () => {
    await middleware.use(req({ code_challenge: s256('v') }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a malformed challenge', async () => {
    await middleware.use(
      req({ code_challenge: 'too-short', code_challenge_method: 'S256' }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(bodyOf().error_description).toMatch(/base64url/);
  });

  it('never redirects to a client-supplied redirect_uri', async () => {
    // Redirecting on error would mean trusting an unvalidated client URI,
    // which is how an authorization endpoint becomes an open redirector.
    await middleware.use(
      req({ client_id: 'c1', redirect_uri: 'https://evil.tld/cb' }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.header).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(JSON.stringify(bodyOf())).not.toContain('evil.tld');
  });

  it('leaves non-GET requests alone', async () => {
    await middleware.use(req({}, 'POST'), res, next);
    expect(next).toHaveBeenCalled();
  });

  describe('OAUTH_PKCE_EXEMPT_CLIENT_IDS', () => {
    const original = process.env.OAUTH_PKCE_EXEMPT_CLIENT_IDS;
    let findUnique: jest.Mock;

    const withClient = (client: Record<string, unknown> | null) => {
      findUnique = jest.fn().mockResolvedValue(client);
      middleware = new AuthorizePkceMiddleware({
        oAuthClient: { findUnique },
      } as any);
    };

    const confidential = {
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecret: 's3cret',
    };

    beforeEach(() => {
      process.env.OAUTH_PKCE_EXEMPT_CLIENT_IDS = 'copilot-studio, other';
    });
    afterAll(() => {
      if (original === undefined) delete process.env.OAUTH_PKCE_EXEMPT_CLIENT_IDS;
      else process.env.OAUTH_PKCE_EXEMPT_CLIENT_IDS = original;
    });

    it('lets a listed confidential client authorize without PKCE', async () => {
      withClient(confidential);
      await middleware.use(req({ client_id: 'copilot-studio' }), res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'copilot-studio' } }),
      );
    });

    it('accepts client_secret_basic too', async () => {
      withClient({ ...confidential, tokenEndpointAuthMethod: 'client_secret_basic' });
      await middleware.use(req({ client_id: 'other' }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it('keeps PKCE required for a listed public client', async () => {
      // A public client has no secret, so nothing would stand in for PKCE.
      withClient({ tokenEndpointAuthMethod: 'none', clientSecret: null });
      await middleware.use(req({ client_id: 'copilot-studio' }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('keeps PKCE required for a listed client with no stored secret', async () => {
      withClient({ tokenEndpointAuthMethod: 'client_secret_post', clientSecret: null });
      await middleware.use(req({ client_id: 'copilot-studio' }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('keeps PKCE required for a listed id that is not registered', async () => {
      withClient(null);
      await middleware.use(req({ client_id: 'copilot-studio' }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('never looks up clients that are not listed', async () => {
      withClient(confidential);
      await middleware.use(req({ client_id: 'some-dcr-client' }), res, next);

      expect(findUnique).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('still validates a challenge a listed client chooses to send', async () => {
      withClient(confidential);
      await middleware.use(
        req({ client_id: 'copilot-studio', code_challenge: 'x', code_challenge_method: 'plain' }),
        res,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('does not exempt a request that names a method without a challenge', async () => {
      withClient(confidential);
      await middleware.use(
        req({ client_id: 'copilot-studio', code_challenge_method: 'plain' }),
        res,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('fails closed when the lookup throws', async () => {
      findUnique = jest.fn().mockRejectedValue(new Error('db down'));
      middleware = new AuthorizePkceMiddleware({ oAuthClient: { findUnique } } as any);
      await middleware.use(req({ client_id: 'copilot-studio' }), res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
