import * as http from 'http';
import { AddressInfo } from 'net';
import { RestEngine } from './rest.engine';
import { OpenApiParser } from '../parsers/openapi.parser';

// Real axios, real sockets: a connector whose server answers with a redirect
// to an internal address must not get that address's answer back. `localhost`
// is allowlisted and plays the public API; 127.0.0.1 plays the internal host.
describe('outbound calls and redirects (real HTTP)', () => {
  const saved = { guard: process.env.SSRF_GUARD, hosts: process.env.SSRF_ALLOWED_HOSTS };
  const servers: http.Server[] = [];
  let internalHits = 0;
  let internalPort = 0;
  let apiPort = 0;

  async function listen(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    process.env.SSRF_GUARD = 'enabled';
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';
    internalPort = await listen((_req, res) => {
      internalHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"secret":"metadata"}');
    });
    apiPort = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/metadata/v1.json` });
      res.end();
    });
  });

  afterAll(async () => {
    process.env.SSRF_GUARD = saved.guard;
    process.env.SSRF_ALLOWED_HOSTS = saved.hosts;
    if (saved.guard === undefined) delete process.env.SSRF_GUARD;
    if (saved.hosts === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    await Promise.all(
      servers.map(
        (s) => new Promise<void>((ok) => {
          s.closeAllConnections();
          s.close(() => ok());
        }),
      ),
    );
  });

  beforeEach(() => (internalHits = 0));

  it('a REST tool call does not follow the redirect to the internal host', async () => {
    const engine = new RestEngine({} as any, {} as any);
    await expect(
      engine.execute(
        { baseUrl: `http://localhost:${apiPort}`, authType: 'NONE' },
        { method: 'GET', path: '/items' },
        {},
      ),
    ).rejects.toThrow(/not a public IP/);
    expect(internalHits).toBe(0);
  });

  it('an OpenAPI import from URL does not follow it either', async () => {
    await expect(
      new OpenApiParser().parseSpecFromUrl(`http://localhost:${apiPort}/openapi.json`),
    ).rejects.toThrow(/not a public IP/);
    expect(internalHits).toBe(0);
  });
});
