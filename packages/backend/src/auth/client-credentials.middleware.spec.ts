import { Logger } from '@nestjs/common';
import {
  ClientCredentialsMiddleware,
  loggableClientId,
} from './client-credentials.middleware';

describe('ClientCredentialsMiddleware', () => {
  let middleware: ClientCredentialsMiddleware;
  let res: any;
  let next: jest.Mock;
  let warn: jest.SpyInstance;

  const req = (body: any, extra: Record<string, any> = {}) =>
    ({ method: 'POST', body, headers: {}, ip: '203.0.113.7', ...extra }) as any;

  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    middleware = new ClientCredentialsMiddleware();
  });

  afterEach(() => warn.mockRestore());

  const expectRefused = () => {
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'unauthorized_client' }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    // Never a token, whatever the client sent.
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('access_token');
  };

  // ── Pass-through: every other grant belongs to the upstream controller ───

  it('ignores non-POST requests', () => {
    middleware.use(req({ grant_type: 'client_credentials' }, { method: 'GET' }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['authorization_code', 'refresh_token', undefined])(
    'passes the %s grant through',
    (grant) => {
      middleware.use(req({ grant_type: grant }), res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  // ── The grant itself ─────────────────────────────────────────────────────

  it('refuses a self-registered client that sends its credentials in the body', () => {
    // The attack: POST /register with grant_types ["client_credentials"] and
    // client_secret_post, then POST /token with the issued id and secret.
    middleware.use(
      req({
        grant_type: 'client_credentials',
        client_id: 'a1b2c3d4e5f6',
        client_secret: 'issued-by-dcr',
      }),
      res,
      next,
    );
    expectRefused();
  });

  it('refuses credentials sent with HTTP Basic auth', () => {
    middleware.use(
      req(
        { grant_type: 'client_credentials' },
        { headers: { authorization: basic('a1b2c3d4e5f6', 'issued-by-dcr') } },
      ),
      res,
      next,
    );
    expectRefused();
  });

  it('refuses a form-urlencoded body that reached it as a string', () => {
    middleware.use(
      req('grant_type=client_credentials&client_id=x&client_secret=y'),
      res,
      next,
    );
    expectRefused();
  });

  it('refuses a request without any credentials the same way', () => {
    middleware.use(req({ grant_type: 'client_credentials' }), res, next);
    expectRefused();
  });

  it('logs a warning with the client id and address, never the secret', () => {
    middleware.use(
      req({
        grant_type: 'client_credentials',
        client_id: 'a1b2c3d4e5f6',
        client_secret: 'super-secret-value',
      }),
      res,
      next,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('a1b2c3d4e5f6');
    expect(line).toContain('203.0.113.7');
    expect(line).not.toContain('super-secret-value');
  });
});

describe('loggableClientId', () => {
  const r = (headers: Record<string, string> = {}) => ({ headers }) as any;

  it('prefers the Basic auth client id and drops the secret', () => {
    const header = `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`;
    expect(loggableClientId(r({ authorization: header }), { client_id: 'other' })).toBe(
      'client-1',
    );
  });

  it('falls back to the body', () => {
    expect(loggableClientId(r(), { client_id: 'client-2' })).toBe('client-2');
  });

  it('says <none> when no id was sent', () => {
    expect(loggableClientId(r(), {})).toBe('<none>');
    expect(loggableClientId(r(), { client_id: 42 })).toBe('<none>');
  });

  it('neutralises characters that could forge a log line', () => {
    expect(loggableClientId(r(), { client_id: 'evil\nFAKE LOG LINE' })).toBe(
      'evil?FAKE?LOG?LINE',
    );
  });

  it('caps the length', () => {
    const out = loggableClientId(r(), { client_id: 'a'.repeat(500) });
    expect(out).toBe(`${'a'.repeat(64)}…`);
  });
});
