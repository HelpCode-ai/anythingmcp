import * as dns from 'dns';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  fetchOutbound,
  OutboundFetchError,
  redactUrl,
} from './outbound-fetch.util';
import { SsrfBlockedError, ssrfGuardedLookup } from './ssrf.util';

// The guard is on, and `localhost` stands in for a public host: it is the only
// allowlisted name. Literal 127.0.0.1 stays blocked, like an internal address.
const ENV = { SSRF_GUARD: 'enabled', SSRF_ALLOWED_HOSTS: 'localhost' } as NodeJS.ProcessEnv;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  port: number;
  hits: http.IncomingMessage[];
  close: () => Promise<void>;
}

async function serve(handler: Handler): Promise<TestServer> {
  const hits: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

describe('fetchOutbound', () => {
  const servers: TestServer[] = [];
  const start = async (h: Handler) => {
    const s = await serve(h);
    servers.push(s);
    return s;
  };

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('returns the body, headers and final URL', async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end('PNGDATA');
    });
    const out = await fetchOutbound(`http://localhost:${s.port}/a.png`, { env: ENV });
    expect(out.status).toBe(200);
    expect(out.body.toString()).toBe('PNGDATA');
    expect(out.headers['content-type']).toBe('image/png');
    expect(out.finalUrl).toBe(`http://localhost:${s.port}/a.png`);
  });

  it('sends only the caller headers: no cookie, no authorization', async () => {
    const s = await start((_req, res) => res.end('ok'));
    await fetchOutbound(`http://localhost:${s.port}/`, {
      env: ENV,
      headers: { Accept: 'image/*' },
    });
    const sent = s.hits[0].headers;
    expect(sent.accept).toBe('image/*');
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
  });

  it('follows a redirect to an allowed host', async () => {
    const s = await start((req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { Location: '/new' });
        return res.end();
      }
      res.end('moved here');
    });
    const out = await fetchOutbound(`http://localhost:${s.port}/old`, { env: ENV });
    expect(out.body.toString()).toBe('moved here');
    expect(out.finalUrl).toBe(`http://localhost:${s.port}/new`);
  });

  it('refuses a redirect to an internal address and never contacts it', async () => {
    const internal = await start((_req, res) => res.end('INTERNAL'));
    const s = await start((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/meta` });
      res.end();
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(internal.hits).toHaveLength(0);
  });

  it('checks the address the socket connects to, not an earlier DNS answer', async () => {
    const internal = await start((_req, res) => res.end('INTERNAL'));
    // A rebinding name: public when the URL is checked, loopback when the
    // client connects.
    const answers = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
    ];
    const real = dns.promises.lookup;
    jest.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, opts: any) =>
      host === 'rebind.test'
        ? Promise.resolve(answers.shift() ?? [{ address: '127.0.0.1', family: 4 }])
        : real(host, opts)) as any);

    await expect(
      fetchOutbound(`http://rebind.test:${internal.port}/`, { env: ENV }),
    ).rejects.toThrow(/non-public address '127\.0\.0\.1'/);
    expect(internal.hits).toHaveLength(0);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const s = await start((_req, res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV }),
    ).rejects.toMatchObject({ reason: 'invalid_url' });
  });

  it('stops after maxRedirects', async () => {
    const s = await start((_req, res) => {
      res.writeHead(302, { Location: '/again' });
      res.end();
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV, maxRedirects: 2 }),
    ).rejects.toMatchObject({ reason: 'too_many_redirects' });
    expect(s.hits).toHaveLength(3);
  });

  it('drops Authorization and Cookie on a redirect to another origin', async () => {
    const other = await start((_req, res) => res.end('other'));
    const s = await start((_req, res) => {
      res.writeHead(302, { Location: `http://localhost:${other.port}/` });
      res.end();
    });
    await fetchOutbound(`http://localhost:${s.port}/`, {
      env: ENV,
      headers: { Authorization: 'Bearer t', Cookie: 'a=b', Accept: 'text/plain' },
    });
    expect(s.hits[0].headers.authorization).toBe('Bearer t');
    const sent = other.hits[0].headers;
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
    expect(sent.accept).toBe('text/plain');
  });

  it('treats a non-2xx answer as an error and keeps the query string out of it', async () => {
    const s = await start((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<h1>Forbidden</h1>');
    });
    const err = await fetchOutbound(
      `http://localhost:${s.port}/f.pdf?X-Amz-Signature=secret`,
      { env: ENV },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundFetchError);
    expect(err).toMatchObject({ reason: 'status', status: 403 });
    expect(err.message).toContain('/f.pdf');
    expect(err.message).not.toContain('secret');
  });

  it('rejects a body whose Content-Length is over the cap without reading it', async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { 'Content-Length': '2048' });
      res.end(Buffer.alloc(2048));
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('aborts a streamed body as soon as it crosses the cap', async () => {
    let written = 0;
    const s = await start((_req, res) => {
      // Chunked, no Content-Length: the cap must hold on the bytes read.
      res.writeHead(200);
      const timer = setInterval(() => {
        written += 512;
        res.write(Buffer.alloc(512));
        if (written >= 64 * 1024) {
          clearInterval(timer);
          res.end();
        }
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV, maxBytes: 2048 }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    expect(written).toBeLessThan(64 * 1024);
  });

  it('gives up at the deadline', async () => {
    const s = await start(() => {
      /* never answers */
    });
    await expect(
      fetchOutbound(`http://localhost:${s.port}/`, { env: ENV, timeoutMs: 200 }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('ignores an env proxy', async () => {
    const s = await start((_req, res) => res.end('direct'));
    const saved = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    try {
      const out = await fetchOutbound(`http://localhost:${s.port}/`, { env: ENV });
      expect(out.body.toString()).toBe('direct');
    } finally {
      if (saved === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved;
    }
  });
});

describe('ssrfGuardedLookup', () => {
  const lookup = (host: string, env: NodeJS.ProcessEnv) =>
    new Promise<unknown>((resolve, reject) =>
      ssrfGuardedLookup(env)(host, { all: true }, (err, addrs) =>
        err ? reject(err) : resolve(addrs),
      ),
    );

  it('blocks a loopback name that is not allowlisted', async () => {
    await expect(
      lookup('localhost', { SSRF_GUARD: 'enabled' } as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('resolves an allowlisted name', async () => {
    const addrs = (await lookup('localhost', ENV)) as Array<{ address: string }>;
    expect(addrs.length).toBeGreaterThan(0);
  });
});

describe('redactUrl', () => {
  it('keeps origin and path only', () => {
    expect(redactUrl('https://user:pw@cdn.example.com/a/b.png?sig=x#f')).toBe(
      'https://cdn.example.com/a/b.png',
    );
  });
});
