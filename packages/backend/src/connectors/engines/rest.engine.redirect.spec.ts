import * as dns from 'dns';
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

  it("leaves the connector's key behind when the API redirects to another origin", async () => {
    const real = dns.promises.lookup;
    jest.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, opts: any) =>
      host === 'cdn.other.test'
        ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
        : real(host, opts)) as any);
    process.env.SSRF_ALLOWED_HOSTS = 'localhost,cdn.other.test';
    const seen: http.IncomingHttpHeaders[] = [];
    const cdnPort = await listen((req, res) => {
      seen.push(req.headers);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"file":"ok"}');
    });
    const apiPort2 = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://cdn.other.test:${cdnPort}/file` });
      res.end();
    });
    try {
      const engine = new RestEngine({} as any, {} as any);
      const result = await engine.execute(
        {
          baseUrl: `http://localhost:${apiPort2}`,
          authType: 'API_KEY',
          authConfig: { headerName: 'X-Partner', apiKey: 'partner-secret' },
          headers: { 'X-Tenant': 'tenant-secret' },
        },
        { method: 'GET', path: '/download', headers: { Accept: 'application/json' } },
        {},
      );
      expect(result).toEqual({ file: 'ok' });
      expect(seen[0]['x-partner']).toBeUndefined();
      expect(seen[0]['x-tenant']).toBeUndefined();
      expect(seen[0].accept).toBe('application/json');
    } finally {
      process.env.SSRF_ALLOWED_HOSTS = 'localhost';
      jest.restoreAllMocks();
    }
  });

  it('sends the whole form-data body again on the retry after a 401', async () => {
    const bodies: string[] = [];
    const port = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization === 'Bearer fresh') {
          res.end('{"ok":true}');
        } else {
          res.statusCode = 401;
          res.end('{"error":"expired"}');
        }
      });
    });
    const oauth2 = {
      getAccessToken: jest.fn().mockResolvedValue('stale'),
      refreshToken: jest.fn().mockResolvedValue('fresh'),
    };
    const engine = new RestEngine(oauth2 as any, {} as any);
    const result = await engine.execute(
      {
        baseUrl: `http://localhost:${port}`,
        authType: 'OAUTH2',
        authConfig: { refreshToken: 'rt', tokenUrl: `http://localhost:${port}/token` },
      },
      {
        method: 'POST',
        path: '/notes',
        bodyEncoding: 'form-data',
        bodyMapping: { title: '$title', text: '$text' },
      },
      { title: 'Quarterly', text: 'numbers' },
    );
    expect(result).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('name="title"');
      expect(body).toContain('Quarterly');
      expect(body).toContain('numbers');
    }
  });

  it('an OpenAPI import from URL does not follow it either', async () => {
    await expect(
      new OpenApiParser().parseSpecFromUrl(`http://localhost:${apiPort}/openapi.json`),
    ).rejects.toThrow(/not a public IP/);
    expect(internalHits).toBe(0);
  });
});
