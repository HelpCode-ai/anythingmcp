import { OAuthRegisterGuardMiddleware } from './oauth-register-guard.middleware';
import type { Request, Response } from 'express';

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    header(key: string, value: string) {
      headers[key] = value;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  } as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
  return res as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

function makeReq(overrides: Partial<Request>): Request {
  return {
    method: 'POST',
    headers: {},
    body: undefined,
    ...overrides,
  } as Request;
}

describe('OAuthRegisterGuardMiddleware', () => {
  const guard = new OAuthRegisterGuardMiddleware();

  it('passes through non-POST requests', () => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(makeReq({ method: 'GET' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('rejects multipart/form-data with 400 invalid_client_metadata', () => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(
      makeReq({
        headers: { 'content-type': 'multipart/form-data; boundary=---x' },
        body: undefined,
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('rejects JSON with missing redirect_uris', () => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(
      makeReq({
        headers: { 'content-type': 'application/json' },
        body: { client_name: 'Claude' },
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rejects JSON with empty redirect_uris', () => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(
      makeReq({
        headers: { 'content-type': 'application/json' },
        body: { redirect_uris: [] },
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('passes valid JSON through to the controller', () => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(
      makeReq({
        headers: { 'content-type': 'application/json' },
        body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  describe('redirect_uri content validation', () => {
    const register = (redirect_uris: unknown[]) => {
      const next = jest.fn();
      const res = makeRes();
      guard.use(
        makeReq({
          headers: { 'content-type': 'application/json' },
          body: { redirect_uris },
        }),
        res,
        next,
      );
      return { next, res };
    };

    it.each([
      ['a wildcard', 'https://*.evil.tld/cb'],
      ['path traversal', 'https://example.com/cb/../../admin'],
      ['a fragment', 'https://example.com/cb#t'],
      ['cleartext http to a public host', 'http://example.com/cb'],
    ])('rejects %s', (_label, uri) => {
      const { next, res } = register([uri]);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect((res.body as any).error).toBe('invalid_redirect_uri');
    });

    it('still accepts the URI shapes real MCP clients register', () => {
      const { next, res } = register([
        'https://claude.ai/api/mcp/auth_callback',
        'http://localhost:33418/callback',
        'vscode://anthropic.claude/authenticate',
      ]);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    it('rejects the whole registration when any URI is bad', () => {
      const { next, res } = register([
        'https://claude.ai/api/mcp/auth_callback',
        'https://*.evil.tld/cb',
      ]);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
    });
  });
});

describe('OAuthRegisterGuardMiddleware — size and field limits', () => {
  const guard = new OAuthRegisterGuardMiddleware();
  const OK_URI = 'https://claude.ai/api/mcp/auth_callback';
  const run = (body: unknown, headers: Record<string, string> = {}) => {
    const next = jest.fn();
    const res = makeRes();
    guard.use(makeReq({ headers: { 'content-type': 'application/json', ...headers }, body }), res, next);
    return { next, res };
  };

  it('refuses a body over 16 KB by Content-Length with 413', () => {
    const { next, res } = run({ redirect_uris: [OK_URI] }, { 'content-length': String(16 * 1024 + 1) });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('refuses a body over 16 KB without Content-Length (measured after parsing)', () => {
    const { next, res } = run({ redirect_uris: [OK_URI], software_statement: 'x'.repeat(17 * 1024) });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
  });

  it.each([
    ['client_name over 200 characters', { client_name: 'n'.repeat(201) }],
    ['client_description over 2048 characters', { client_description: 'd'.repeat(2049) }],
    ['client_uri over 2048 characters', { client_uri: 'https://a.example/' + 'p'.repeat(2048) }],
    ['logo_uri over 2048 characters', { logo_uri: 'https://a.example/' + 'p'.repeat(2048) }],
    ['tos_uri over 2048 characters', { tos_uri: 'https://a.example/' + 'p'.repeat(2048) }],
    ['policy_uri over 2048 characters', { policy_uri: 'https://a.example/' + 'p'.repeat(2048) }],
    ['more than 5 contacts', { contacts: ['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x'] }],
    ['a client_name that is not a string', { client_name: { x: 1 } }],
    ['contacts that is not an array', { contacts: 'a@x' }],
  ])('refuses %s with 400 invalid_client_metadata', (_what, extra) => {
    const { next, res } = run({ redirect_uris: [OK_URI], ...extra });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client_metadata', error_description: expect.any(String) });
  });

  it('refuses more than 10 redirect_uris', () => {
    const uris = Array.from({ length: 11 }, (_, i) => 'https://a.example/cb' + i);
    const { next, res } = run({ redirect_uris: uris });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('refuses a redirect_uri over 2048 characters', () => {
    const { next, res } = run({ redirect_uris: ['https://a.example/' + 'p'.repeat(2048)] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('accepts a full registration at the limits', () => {
    const { next, res } = run({
      client_name: 'n'.repeat(200),
      client_uri: 'https://claude.ai',
      logo_uri: 'https://claude.ai/logo.png',
      contacts: ['a@x', 'b@x', 'c@x', 'd@x', 'e@x'],
      redirect_uris: Array.from({ length: 10 }, (_, i) => 'https://claude.ai/cb' + i),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
