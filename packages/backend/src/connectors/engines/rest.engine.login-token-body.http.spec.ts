import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { PrismaService } from '../../common/prisma.service';

/**
 * The XML login-token flow over real HTTP (no axios mock), against a small
 * server that behaves like Fnac Darty's seller API: `/auth` answers a token
 * in XML, every other request carries it as an attribute of its root element,
 * and a token the server no longer knows is refused in the body: with HTTP
 * 400, as the test platform answers a wrong key, or with HTTP 200.
 */

type Seen = { path: string; body: string; contentType?: string; authorization?: string };

const listen = async (handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

// The error a call fails with; a call that succeeds fails the test.
const caught = (call: Promise<unknown>): Promise<any> =>
  call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error) => error,
  );
const ERROR_WHEN = [
  { path: 'offers_query_response.error.code', in: ['ERR_097', 'ERR_098', 'ERR_102'], messagePath: 'offers_query_response.error.#text', status: 401 },
  { path: 'offers_query_response.error.code', matches: '.+', messagePath: 'offers_query_response.error.#text', status: 400 },
];
const TEMPLATE =
  '<?xml version="1.0" encoding="utf-8"?><offers_query xmlns="urn:test" partner_id="P1" shop_id="S1" token="${loginToken}">' +
  '${?page}<paging>${page}</paging>${/page}${?sku}<offer_seller_id>${sku}</offer_seller_id>${/sku}</offers_query>';

describe('LOGIN_TOKEN over HTTP: XML login, token in the body, re-login on an expired token', () => {
  let api: Server;
  let baseUrl: string;
  let seen: Seen[];
  let issued: string[];
  // How the server refuses a token it does not know.
  let refusal: { status: number };

  beforeAll(async () => {
    const started = await listen((req, res, body) => {
      seen.push({
        path: req.url ?? '',
        body,
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
      });
      res.setHeader('Content-Type', 'text/xml; charset=UTF-8');
      if (req.url === '/api.php/auth') {
        if (!body.includes('<key>k&amp;y</key>')) {
          res.statusCode = 400;
          res.end('<auth_response status="ERROR" xmlns="urn:test"><error severity="ERROR" code="ERR_097">Authentication failed</error></auth_response>');
          return;
        }
        const token = `TOKEN-${issued.length + 1}`;
        issued.push(token);
        res.end(
          `<?xml version="1.0" encoding="UTF-8" ?>\n<auth_response status="OK" xmlns="urn:test">\n  <token>${token}</token>\n` +
            `  <validity>${new Date(Date.now() + 3_600_000).toISOString()}</validity>\n  <version>2.6.0</version>\n</auth_response>`,
        );
        return;
      }
      const token = /token="([^"]*)"/.exec(body)?.[1];
      if (token !== issued.at(-1)) {
        res.statusCode = refusal.status;
        res.end(
          '<offers_query_response status="FATAL" xmlns="urn:test"><error severity="FATAL" code="ERR_098">Authentication Failure: token session time is expired, please authenticate.</error></offers_query_response>',
        );
        return;
      }
      res.end(
        '<offers_query_response status="OK" xmlns="urn:test"><page>1</page><offer><offer_seller_id><![CDATA[SKU-1]]></offer_seller_id><price>239.3</price></offer></offers_query_response>',
      );
    });
    api = started.server;
    baseUrl = `${started.url}/api.php`;
  });
  afterAll(() => close(api));
  beforeEach(() => {
    seen = [];
    issued = [];
    refusal = { status: 400 };
  });

  const authConfig = (extra: Record<string, unknown> = {}) => ({
    loginUrl: `${baseUrl}/auth`,
    loginMethod: 'POST',
    loginBodyFormat: 'xml',
    loginBody: '<auth xmlns="urn:test"><partner_id>${username}</partner_id><shop_id>${aud}</shop_id><key>${password}</key></auth>',
    loginHeaders: { 'Content-Type': 'text/xml; charset=utf-8' },
    username: 'P1',
    password: 'k&y',
    aud: 'S1',
    loginResponseFormat: 'xml',
    tokenJsonPath: 'auth_response.token',
    expiryJsonPath: 'auth_response.validity',
    expiryFormat: 'iso8601',
    refreshOn401: true,
    refreshOnBody401: true,
    tokenPlacement: 'body',
    ...extra,
  });
  const setup = () => {
    const login = new LoginTokenService(
      { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
      { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService,
    );
    const engine = new RestEngine({} as OAuth2TokenService, login);
    const call = (params: Record<string, unknown>, auth = authConfig()) =>
      engine.execute(
        { baseUrl, authType: 'LOGIN_TOKEN', authConfig: auth, errorWhen: ERROR_WHEN, connectorId: 'conn-http', headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
        { method: 'POST', path: '/offers_query', bodyEncoding: 'xml', bodyTemplate: TEMPLATE },
        params,
      );
    return { call };
  };

  it('logs in with XML, sends the token in the body and reuses it', async () => {
    const { call } = setup();
    const first = await call({ page: 1 });
    const second = await call({ sku: 'A & B' });
    expect(seen.map((r) => r.path)).toEqual(['/api.php/auth', '/api.php/offers_query', '/api.php/offers_query']);
    expect(seen[0].body).toBe('<auth xmlns="urn:test"><partner_id>P1</partner_id><shop_id>S1</shop_id><key>k&amp;y</key></auth>');
    expect(seen[0].contentType).toBe('text/xml; charset=utf-8');
    expect(seen[1].body).toBe(
      '<?xml version="1.0" encoding="utf-8"?><offers_query xmlns="urn:test" partner_id="P1" shop_id="S1" token="TOKEN-1"><paging>1</paging></offers_query>',
    );
    expect(seen[2].body).toContain('token="TOKEN-1"><offer_seller_id>A &amp; B</offer_seller_id>');
    for (const request of seen.slice(1)) {
      expect(request.authorization).toBeUndefined();
      expect(request.contentType).toBe('text/xml; charset=utf-8');
    }
    // The XML answer reaches the caller as an object, CDATA and all.
    expect(first).toMatchObject({
      offers_query_response: { status: 'OK', page: '1', offer: { offer_seller_id: 'SKU-1', price: '239.3' } },
    });
    expect(second).toEqual(first);
  });

  for (const status of [400, 200]) {
    it(`logs in again and repeats the call when the server refuses the token with HTTP ${status}`, async () => {
      refusal = { status };
      const { call } = setup();
      await call({ page: 1 });
      // The server forgets the session: only a newly issued token is accepted.
      issued.push('ROTATED');
      const out = await call({ page: 2 });
      expect(seen.map((r) => r.path)).toEqual([
        '/api.php/auth',
        '/api.php/offers_query',
        '/api.php/offers_query',
        '/api.php/auth',
        '/api.php/offers_query',
      ]);
      expect(seen[2].body).toContain('token="TOKEN-1"');
      expect(seen[4].body).toContain('token="TOKEN-3"><paging>2</paging>');
      expect(out).toMatchObject({ offers_query_response: { status: 'OK' } });
    });
  }

  it('reports a wrong key as the HTTP 400 the login answered, without a second attempt', async () => {
    const { call } = setup();
    const failure = await caught(call({ page: 1 }, authConfig({ password: 'wrong' })));
    expect(failure).toBeInstanceOf(AxiosError);
    expect(failure.response.status).toBe(400);
    expect(seen.map((r) => r.path)).toEqual(['/api.php/auth']);
  });

  it('refuses to follow a redirect to another origin with a body that carries the token', async () => {
    let elsewhereHits = 0;
    const elsewhere = await listen((_req, res) => {
      elsewhereHits += 1;
      res.end('<ok/>');
    });
    const redirecting = await listen((req, res, body) => {
      if (req.url === '/api.php/auth') {
        res.setHeader('Content-Type', 'text/xml');
        res.end('<auth_response status="OK"><token>TOKEN-R</token></auth_response>');
        return;
      }
      seen.push({ path: req.url ?? '', body });
      res.statusCode = 307;
      res.setHeader('Location', `${elsewhere.url}/api.php/offers_query`);
      res.end();
    });
    try {
      const login = new LoginTokenService(
        { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
        { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService,
      );
      const base = `${redirecting.url}/api.php`;
      await expect(
        new RestEngine({} as OAuth2TokenService, login).execute(
          { baseUrl: base, authType: 'LOGIN_TOKEN', authConfig: authConfig({ loginUrl: `${base}/auth` }), connectorId: 'conn-redirect' },
          { method: 'POST', path: '/offers_query', bodyEncoding: 'xml', bodyTemplate: TEMPLATE },
          { page: 1 },
        ),
      ).rejects.toThrow(/its body carries credentials and is not sent to another origin/);
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toContain('token="TOKEN-R"');
      expect(elsewhereHits).toBe(0);
    } finally {
      await close(redirecting.server);
      await close(elsewhere.server);
    }
  });
});
