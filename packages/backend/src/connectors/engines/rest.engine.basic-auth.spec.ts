import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { RestEngine } from './rest.engine';

/**
 * What actually goes over the wire for BASIC_AUTH, with the real axios and a
 * real socket. rest.engine.spec.ts mocks axios and can only assert the `auth`
 * object handed to it; the header itself is built further down (axios → Node's
 * http client), and that is the part an upstream judges.
 *
 * Companies House is the case that matters: the API key is the username and
 * the password is empty, so the header must be exactly Basic base64("<key>:").
 * Anything else — no colon, `<key>:undefined`, no header — is answered with
 * 400 {"error":"Invalid Authorization header"} instead of a 401 for a wrong
 * key, which sends people looking for a bug in the connector.
 */
describe('RestEngine BASIC_AUTH on the wire', () => {
  let server: Server;
  let baseUrl: string;
  let seen: IncomingHttpHeaders[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  const engine = new RestEngine({} as any, {} as any);

  const call = (authConfig: Record<string, unknown>) =>
    engine.execute(
      { baseUrl, authType: 'BASIC_AUTH', authConfig },
      { method: 'GET', path: '/search/companies' },
      {},
    );

  it('sends Basic base64("<key>:") for an empty password (Companies House)', async () => {
    const key = '12345678-1234-1234-1234-123456789abc';
    await call({ username: key, password: '' });

    expect(seen[0].authorization).toBe(
      `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    );
  });

  it('treats an absent password as empty, never as the string "undefined"', async () => {
    await call({ username: 'key-only' });

    expect(seen[0].authorization).toBe(
      `Basic ${Buffer.from('key-only:').toString('base64')}`,
    );
  });

  it('sends username and password joined by a colon', async () => {
    await call({ username: 'user', password: 'pa:ss' });

    expect(seen[0].authorization).toBe(
      `Basic ${Buffer.from('user:pa:ss').toString('base64')}`,
    );
  });
});
