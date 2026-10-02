import axios from 'axios';
import * as dns from 'dns';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ssrfGuardedAxiosOptions, ssrfGuardedFetch } from './guarded-http.util';
import { ssrfGuardedLookup } from './ssrf.util';

// Guard on; `localhost` is the only allowlisted name and stands in for a
// public host. Literal 127.0.0.1 stays blocked, like an internal service.
const GUARD_ENV = { SSRF_GUARD: 'enabled', SSRF_ALLOWED_HOSTS: 'localhost' };

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
interface Hit {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('guarded HTTP clients', () => {
  const saved: Record<string, string | undefined> = {};
  const servers: http.Server[] = [];

  async function serve(handler: Handler) {
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, body, res);
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    servers.push(server);
    return { port: (server.address() as AddressInfo).port, hits };
  }

  const redirectTo = (location: string, status = 302): Handler => (_req, _body, res) => {
    res.writeHead(status, { Location: location });
    res.end();
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(GUARD_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(async () => {
    for (const k of Object.keys(GUARD_ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (s) => new Promise<void>((ok) => {
          s.closeAllConnections();
          s.close(() => ok());
        }),
      ),
    );
  });

  describe('axios with ssrfGuardedAxiosOptions', () => {
    it('refuses a redirect to an internal IP and never contacts it', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/meta`));
      await expect(
        axios.get(`http://localhost:${pub.port}/`, ssrfGuardedAxiosOptions()),
      ).rejects.toThrow(/not a public IP/);
      expect(internal.hits).toHaveLength(0);
    });

    it('refuses a redirect to a name that resolves to an internal IP', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://inside.test:${internal.port}/`));
      const real = dns.promises.lookup;
      jest.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, opts: any) =>
        host === 'inside.test'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : real(host, opts)) as any);
      await expect(
        axios.get(`http://localhost:${pub.port}/`, ssrfGuardedAxiosOptions()),
      ).rejects.toThrow(/non-public address '127\.0\.0\.1'/);
      expect(internal.hits).toHaveLength(0);
    });

    it('still follows a redirect to an allowed host', async () => {
      const target = await serve((_q, _b, res) => res.end('ok'));
      const pub = await serve(redirectTo(`http://localhost:${target.port}/x`));
      const res = await axios.get(`http://localhost:${pub.port}/`, ssrfGuardedAxiosOptions());
      expect(res.data).toBe('ok');
    });

    it('is inert when the guard is off (unit tests, SSRF_GUARD=disabled)', async () => {
      process.env.SSRF_GUARD = 'disabled';
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/`));
      const res = await axios.get(`http://localhost:${pub.port}/`, ssrfGuardedAxiosOptions());
      expect(res.data).toBe('INTERNAL');
    });
  });

  describe('ssrfGuardedFetch', () => {
    it('refuses a redirect to an internal IP and never contacts it', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/meta`));
      await expect(ssrfGuardedFetch(`http://localhost:${pub.port}/`)).rejects.toThrow(
        /not a public IP/,
      );
      expect(internal.hits).toHaveLength(0);
    });

    it('follows an allowed redirect', async () => {
      const target = await serve((_q, _b, res) => res.end('ok'));
      const pub = await serve(redirectTo(`http://localhost:${target.port}/x`));
      const res = await ssrfGuardedFetch(`http://localhost:${pub.port}/`);
      expect(await res.text()).toBe('ok');
    });

    it('keeps method and body on 307, turns POST into GET on 302', async () => {
      const target = await serve((_q, _b, res) => res.end('ok'));
      const p307 = await serve(redirectTo(`http://localhost:${target.port}/a`, 307));
      const p302 = await serve(redirectTo(`http://localhost:${target.port}/b`, 302));
      await ssrfGuardedFetch(`http://localhost:${p307.port}/`, { method: 'POST', body: 'payload' });
      await ssrfGuardedFetch(`http://localhost:${p302.port}/`, { method: 'POST', body: 'payload' });
      expect(target.hits[0]).toMatchObject({ method: 'POST', url: '/a', body: 'payload' });
      expect(target.hits[1]).toMatchObject({ method: 'GET', url: '/b', body: '' });
    });

    it('drops Authorization and Cookie when the redirect leaves the origin', async () => {
      const other = await serve((_q, _b, res) => res.end('ok'));
      const pub = await serve(redirectTo(`http://localhost:${other.port}/`));
      await ssrfGuardedFetch(`http://localhost:${pub.port}/`, {
        headers: { Authorization: 'Bearer t', Cookie: 'a=b', Accept: 'application/json' },
      });
      expect(other.hits[0].headers.authorization).toBeUndefined();
      expect(other.hits[0].headers.cookie).toBeUndefined();
      expect(other.hits[0].headers.accept).toBe('application/json');
    });

    it('does not re-check the starting URL (the caller does, once per call)', async () => {
      const s = await serve((_q, _b, res) => res.end('ok'));
      const spy = jest.spyOn(dns.promises, 'lookup');
      process.env.SSRF_ALLOW_LOCALHOST = 'true';
      delete process.env.SSRF_ALLOWED_HOSTS;
      try {
        for (let i = 0; i < 5; i++) {
          await (await ssrfGuardedFetch(`http://localhost:${s.port}/mcp`, { method: 'POST', body: '{}' })).text();
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        delete process.env.SSRF_ALLOW_LOCALHOST;
      }
    });

    it('stops after five redirects', async () => {
      const loop = await serve(redirectTo('/again'));
      await expect(ssrfGuardedFetch(`http://localhost:${loop.port}/`)).rejects.toThrow(
        /Too many redirects/,
      );
    });
  });

  it("does not block the operator's own HTTP proxy", async () => {
    const lookup = ssrfGuardedLookup({
      SSRF_GUARD: 'enabled',
      HTTP_PROXY: 'http://localhost:3128',
    } as NodeJS.ProcessEnv);
    const addrs = await new Promise((resolve, reject) =>
      lookup('localhost', { all: true }, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(Array.isArray(addrs) && addrs.length > 0).toBe(true);
  });
});
