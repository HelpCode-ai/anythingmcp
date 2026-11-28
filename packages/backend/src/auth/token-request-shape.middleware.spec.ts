import express, { json, urlencoded } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TOKEN_STRING_PARAMS,
  TokenRequestShapeMiddleware,
} from './token-request-shape.middleware';
import { RefreshTokenRevocationMiddleware } from './refresh-token-revocation.middleware';

describe('TokenRequestShapeMiddleware', () => {
  let middleware: TokenRequestShapeMiddleware;
  let res: any;
  let next: jest.Mock;

  const req = (body: any, method = 'POST') => ({ method, body }) as any;

  beforeEach(() => {
    middleware = new TokenRequestShapeMiddleware();
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  const expectPassthrough = () => {
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  };

  const expectRefused = (param: string) => {
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_request',
      error_description: `The ${param} parameter must be a single string value.`,
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  };

  it('passes a refresh request with string values', () => {
    middleware.use(
      req({ grant_type: 'refresh_token', refresh_token: 'a.b.c', client_id: 'x' }),
      res,
      next,
    );
    expectPassthrough();
  });

  it('passes an authorization_code request with string values', () => {
    middleware.use(
      req({
        grant_type: 'authorization_code',
        code: 'abc',
        code_verifier: 'v',
        redirect_uri: 'http://127.0.0.1/cb',
        client_id: 'x',
        resource: 'https://example.test/mcp',
        scope: 'mcp',
      }),
      res,
      next,
    );
    expectPassthrough();
  });

  it('leaves missing parameters to the later steps', () => {
    middleware.use(req({ grant_type: 'refresh_token' }), res, next);
    expectPassthrough();
  });

  it('passes an empty or absent body', () => {
    middleware.use(req(undefined), res, next);
    expectPassthrough();
  });

  it('ignores non-POST requests', () => {
    middleware.use(req({ refresh_token: ['a.b.c'] }, 'GET'), res, next);
    expectPassthrough();
  });

  it('ignores parameters it does not check', () => {
    middleware.use(
      req({ grant_type: 'refresh_token', refresh_token: 'a.b.c', extra: ['x'] }),
      res,
      next,
    );
    expectPassthrough();
  });

  it('refuses an array refresh_token', () => {
    middleware.use(
      req({ grant_type: 'refresh_token', refresh_token: ['a.b.c'] }),
      res,
      next,
    );
    expectRefused('refresh_token');
  });

  it('refuses an object refresh_token', () => {
    middleware.use(
      req({ grant_type: 'refresh_token', refresh_token: { a: 'a.b.c' } }),
      res,
      next,
    );
    expectRefused('refresh_token');
  });

  it('refuses a null value', () => {
    middleware.use(
      req({ grant_type: 'refresh_token', refresh_token: null }),
      res,
      next,
    );
    expectRefused('refresh_token');
  });

  it.each(TOKEN_STRING_PARAMS.map((p) => [p]))(
    'refuses %s when it is not a string',
    (param) => {
      middleware.use(req({ [param]: ['value'] }), res, next);
      expectRefused(param);
    },
  );

  it('refuses a numeric value', () => {
    middleware.use(req({ grant_type: 'refresh_token', client_id: 42 }), res, next);
    expectRefused('client_id');
  });
});

/**
 * The same chain as the /token route in app.module.ts, behind the body parsers
 * main.ts installs, ending in a stand-in for the upstream controller that reads
 * `refresh_token` the way it does (`String(refresh_token ?? '')`).
 */
describe('POST /token parameter shapes through the middleware chain', () => {
  const USER_ID = 'cmpzj8mm9007j1ymn5mo2y3eq';
  const TOKEN = 'a.signed.refresh-token';

  let server: Server;
  let baseUrl: string;
  let jwt: { verifyAsync: jest.Mock };
  let prisma: any;
  let upstream: jest.Mock;

  beforeAll(async () => {
    jwt = { verifyAsync: jest.fn() };
    prisma = {
      user: { findUnique: jest.fn() },
      oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
    const shape = new TokenRequestShapeMiddleware();
    const revocation = new RefreshTokenRevocationMiddleware(
      prisma,
      jwt as any,
      securityEvents as any,
    );
    upstream = jest.fn((req: any, res: any) => {
      res.status(200).json({ refreshed: String(req.body.refresh_token ?? '') });
    });

    const app = express();
    app.use(json());
    app.use(urlencoded({ extended: true }));
    app.post(
      '/token',
      (req, res, next) => shape.use(req, res, next),
      (req, res, next) => void revocation.use(req, res, next),
      upstream,
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    upstream.mockClear();
    jwt.verifyAsync.mockReset();
    prisma.user.findUnique.mockReset();
    // A refresh token minted before the user's sessions were revoked.
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, type: 'refresh', iat: 1000 });
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: new Date(2000 * 1000),
      organizationId: null,
    });
  });

  const postJson = (body: unknown) =>
    fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const postForm = (body: string) =>
    fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('refuses an array refresh_token sent as JSON', async () => {
    const r = await postJson({ grant_type: 'refresh_token', refresh_token: [TOKEN] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The refresh_token parameter must be a single string value.',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses refresh_token[] sent form-urlencoded', async () => {
    const r = await postForm(
      `grant_type=refresh_token&refresh_token%5B%5D=${encodeURIComponent(TOKEN)}`,
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_request');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a repeated refresh_token sent form-urlencoded', async () => {
    const r = await postForm(
      `grant_type=refresh_token&refresh_token=${TOKEN}&refresh_token=${TOKEN}`,
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_request');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('still refuses a revoked refresh token sent as a string', async () => {
    const r = await postForm(`grant_type=refresh_token&refresh_token=${TOKEN}`);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes a valid string refresh token on to upstream', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      sessionsValidFrom: null,
      organizationId: null,
    });
    const r = await postJson({ grant_type: 'refresh_token', refresh_token: TOKEN });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ refreshed: TOKEN });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
