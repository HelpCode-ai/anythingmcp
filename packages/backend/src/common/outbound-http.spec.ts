import { AxiosError } from 'axios';
import * as dns from 'dns';
import FormData from 'form-data';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  isCredentialHeader,
  keepsCredentials,
  outboundRequest,
  ssrfGuardedFetch,
} from './outbound-http';
import {
  assertSafeOutboundUrl,
  setDbAllowedHostsProvider,
  SsrfBlockedError,
  ssrfGuardedLookup,
} from './ssrf.util';

// Guard on. `localhost` and `api.other.test` are allowlisted and stand in for
// two public hosts (the second is resolved to 127.0.0.1 by a mocked lookup).
// Literal 127.0.0.1 stays blocked, like an internal service.
const GUARD_ENV = {
  SSRF_GUARD: 'enabled',
  SSRF_ALLOWED_HOSTS: 'localhost,api.other.test',
};

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
interface Hit {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Names in `fakeHosts` resolve to the given address for the guard and the
 * guarded lookup (both use dns.promises); everything else resolves for real.
 */
const fakeHosts: Record<string, string | (() => string)> = {};
function fakeDns() {
  const real = dns.promises.lookup;
  jest.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, opts: any) => {
    const entry = fakeHosts[host];
    if (entry === undefined) return real(host, opts);
    const address = typeof entry === 'function' ? entry() : entry;
    return Promise.resolve([{ address, family: 4 }]);
  }) as any);
}

describe('outbound HTTP', () => {
  const saved: Record<string, string | undefined> = {};
  const servers: http.Server[] = [];

  async function serve(handler: Handler = (_q, _b, res) => res.end('ok')) {
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
    for (const k of Object.keys(fakeHosts)) delete fakeHosts[k];
    fakeHosts['api.other.test'] = '127.0.0.1';
    fakeDns();
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

  describe('outboundRequest: redirects to internal addresses', () => {
    it.each([
      ['loopback', 'http://127.0.0.1:{internal}/meta'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['a private range', 'http://10.0.0.5/admin'],
      ['IPv6 loopback', 'http://[::1]:{internal}/'],
    ])('refuses a redirect to %s with the guard error and never connects', async (_, target) => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(target.replace('{internal}', String(internal.port))));
      const call = outboundRequest({ url: `http://localhost:${pub.port}/` });
      await expect(call).rejects.toBeInstanceOf(SsrfBlockedError);
      await expect(call).rejects.toThrow(/not a public IP/);
      expect(internal.hits).toHaveLength(0);
    });

    it('refuses a redirect to a single-label (docker-style) service name on a private address', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      fakeHosts.backend = '172.18.0.5';
      const pub = await serve(redirectTo(`http://backend:${internal.port}/internal`));
      await expect(outboundRequest({ url: `http://localhost:${pub.port}/` })).rejects.toThrow(
        /'backend' resolves to non-public address '172\.18\.0\.5'/,
      );
      expect(internal.hits).toHaveLength(0);
    });

    it('refuses a redirect to a non-http scheme', async () => {
      const pub = await serve(redirectTo('file:///etc/passwd'));
      await expect(outboundRequest({ url: `http://localhost:${pub.port}/` })).rejects.toThrow(
        /protocol 'file:' is not allowed/,
      );
    });

    it('checks the address the socket connects to, not an earlier DNS answer', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      // Public when the URL is checked, loopback when the client connects.
      const answers = ['93.184.216.34', '127.0.0.1'];
      fakeHosts['rebind.test'] = () => answers.shift() ?? '127.0.0.1';
      await expect(
        outboundRequest({ url: `http://rebind.test:${internal.port}/` }),
      ).rejects.toThrow(/non-public address '127\.0\.0\.1'/);
      expect(internal.hits).toHaveLength(0);
    });

    it('checks the first URL too, not only redirect targets', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      await expect(
        outboundRequest({ url: `http://127.0.0.1:${internal.port}/` }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(internal.hits).toHaveLength(0);
    });

    it('follows a redirect to a private host the self-hosted allowlist permits (env)', async () => {
      process.env.SSRF_ALLOWED_HOSTS = 'localhost,127.0.0.1';
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/x`));
      const res = await outboundRequest({ url: `http://localhost:${pub.port}/` });
      expect(res.data).toBe('INTERNAL');
    });

    it('follows a redirect to a private host the admin allowlist permits (database)', async () => {
      setDbAllowedHostsProvider(async () => ['127.0.0.1']);
      try {
        const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
        const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/x`));
        const res = await outboundRequest({ url: `http://localhost:${pub.port}/` });
        expect(res.data).toBe('INTERNAL');
      } finally {
        setDbAllowedHostsProvider(async () => []);
      }
    });

    it('is inert when the guard is off (unit tests, SSRF_GUARD=disabled)', async () => {
      process.env.SSRF_GUARD = 'disabled';
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      const pub = await serve(redirectTo(`http://127.0.0.1:${internal.port}/`));
      const res = await outboundRequest({ url: `http://localhost:${pub.port}/` });
      expect(res.data).toBe('INTERNAL');
    });
  });

  describe('outboundRequest: legitimate redirects', () => {
    it('resolves a relative Location against the current URL and keeps the new query', async () => {
      const s = await serve((req, _b, res) => {
        if (req.url?.startsWith('/v1/')) return redirectTo('../v2/items?page=2')(req, '', res);
        res.setHeader('Content-Type', 'application/json');
        res.end('{"ok":true}');
      });
      const res = await outboundRequest({
        url: `http://localhost:${s.port}/v1/items`,
        params: { page: 1 },
      });
      expect(res.data).toEqual({ ok: true });
      expect(s.hits.map((h) => h.url)).toEqual(['/v1/items?page=1', '/v2/items?page=2']);
    });

    it('follows a redirect to another allowed host', async () => {
      const target = await serve((_q, _b, res) => res.end('moved here'));
      const pub = await serve(redirectTo(`http://api.other.test:${target.port}/x`, 301));
      const res = await outboundRequest({ url: `http://localhost:${pub.port}/` });
      expect(res.data).toBe('moved here');
      expect(target.hits[0].headers.host).toBe(`api.other.test:${target.port}`);
    });

    it('resends method and body on 307 and 308', async () => {
      const target = await serve();
      for (const status of [307, 308]) {
        const pub = await serve(redirectTo(`http://localhost:${target.port}/s${status}`, status));
        await outboundRequest({
          url: `http://localhost:${pub.port}/`,
          method: 'POST',
          data: { a: 1 },
        });
      }
      expect(target.hits).toEqual([
        expect.objectContaining({ method: 'POST', url: '/s307', body: '{"a":1}' }),
        expect.objectContaining({ method: 'POST', url: '/s308', body: '{"a":1}' }),
      ]);
      expect(target.hits[0].headers['content-type']).toMatch(/application\/json/);
    });

    it('turns 303 (any method) and 301/302 after a POST into a GET without body', async () => {
      const target = await serve();
      const cases: Array<[number, string]> = [
        [303, 'PUT'],
        [302, 'POST'],
        [301, 'POST'],
      ];
      for (const [status, method] of cases) {
        const pub = await serve(redirectTo(`http://localhost:${target.port}/r${status}`, status));
        await outboundRequest({ url: `http://localhost:${pub.port}/`, method, data: { a: 1 } });
      }
      for (const hit of target.hits) {
        expect(hit).toMatchObject({ method: 'GET', body: '' });
        expect(hit.headers['content-type']).toBeUndefined();
        expect(hit.headers['content-length']).toBeUndefined();
      }
    });

    it('keeps the method of a PUT on 301/302, as fetch does', async () => {
      const target = await serve();
      const pub = await serve(redirectTo(`http://localhost:${target.port}/p`, 302));
      await outboundRequest({ url: `http://localhost:${pub.port}/`, method: 'PUT', data: 'x' });
      expect(target.hits[0]).toMatchObject({ method: 'PUT', body: 'x' });
    });

    it('resends a form-data body on 307 through the data factory', async () => {
      const target = await serve();
      const pub = await serve(redirectTo(`http://localhost:${target.port}/upload`, 307));
      const build = () => {
        const form = new FormData();
        form.append('title', 'mug');
        form.append('file', Buffer.from('bytes'), { filename: 'a.txt' });
        return form;
      };
      await outboundRequest(
        { url: `http://localhost:${pub.port}/`, method: 'POST', data: build() },
        { data: build },
      );
      expect(target.hits[0].body).toContain('mug');
      expect(target.hits[0].body).toContain('bytes');
      expect(target.hits[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    });

    it('refuses to resend a streamed body it cannot rebuild', async () => {
      const target = await serve();
      const pub = await serve(redirectTo(`http://localhost:${target.port}/upload`, 307));
      const form = new FormData();
      form.append('title', 'mug');
      await expect(
        outboundRequest({ url: `http://localhost:${pub.port}/`, method: 'POST', data: form }),
      ).rejects.toThrow(/cannot be sent again/);
      expect(target.hits).toHaveLength(0);
    });

    it('applies validateStatus to the final response and keeps the parsed error body', async () => {
      const target = await serve((_q, _b, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"gone"}');
      });
      const pub = await serve(redirectTo(`http://localhost:${target.port}/x`));
      const err = await outboundRequest({ url: `http://localhost:${pub.port}/` }).catch((e) => e);
      expect(err).toBeInstanceOf(AxiosError);
      expect(err.response.status).toBe(404);
      expect(err.response.data).toEqual({ error: 'gone' });

      const ok = await outboundRequest({
        url: `http://localhost:${pub.port}/`,
        validateStatus: (s) => s < 500,
      });
      expect(ok.status).toBe(404);
    });

    it('returns the redirect itself when the caller asks for maxRedirects: 0', async () => {
      const pub = await serve(redirectTo('/elsewhere'));
      const res = await outboundRequest({
        url: `http://localhost:${pub.port}/`,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/elsewhere');
    });
  });

  describe('outboundRequest: credentials on redirects', () => {
    const credentials = {
      Authorization: 'Bearer secret',
      Cookie: 'sid=1',
      'Proxy-Authorization': 'Basic eA==',
      'X-API-Key': 'k1',
      'X-Auth-Token': 't1',
      'X-Partner-Id': 'p1',
      Accept: 'application/json',
      'X-Request-Source': 'tool',
    };

    it('drops credential headers and Basic auth when the redirect leaves the origin', async () => {
      const other = await serve();
      const pub = await serve(redirectTo(`http://api.other.test:${other.port}/`));
      await outboundRequest(
        { url: `http://localhost:${pub.port}/`, headers: credentials, auth: { username: 'u', password: 'p' } },
        { credentialHeaders: ['X-Partner-Id'] },
      );
      const sent = other.hits[0].headers;
      for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-partner-id']) {
        expect(sent[name]).toBeUndefined();
      }
      expect(sent.accept).toBe('application/json');
      expect(sent['x-request-source']).toBe('tool');
    });

    it('keeps them on a same-origin redirect', async () => {
      const s = await serve((req, _b, res) =>
        req.url === '/' ? redirectTo('/next')(req, '', res) : res.end('ok'),
      );
      await outboundRequest(
        { url: `http://localhost:${s.port}/`, headers: credentials },
        { credentialHeaders: ['X-Partner-Id'] },
      );
      expect(s.hits[1].headers).toMatchObject({
        authorization: 'Bearer secret',
        cookie: 'sid=1',
        'x-api-key': 'k1',
        'x-partner-id': 'p1',
      });
    });

    it('does not resend a credential-bearing body to another origin', async () => {
      const other = await serve();
      const pub = await serve(redirectTo(`http://api.other.test:${other.port}/token`, 307));
      await expect(
        outboundRequest(
          { url: `http://localhost:${pub.port}/token`, method: 'POST', data: 'client_secret=s' },
          { credentialsInBody: true },
        ),
      ).rejects.toThrow(/body carries credentials/);
      expect(other.hits).toHaveLength(0);
    });

    it('treats an http to https upgrade on the same host as the same origin', () => {
      expect(keepsCredentials(new URL('http://api.x.com/a'), new URL('https://api.x.com/b'))).toBe(true);
      expect(keepsCredentials(new URL('https://api.x.com/a'), new URL('http://api.x.com/b'))).toBe(false);
      expect(keepsCredentials(new URL('https://api.x.com/a'), new URL('https://eu.api.x.com/'))).toBe(false);
      expect(keepsCredentials(new URL('https://api.x.com/a'), new URL('https://api.x.com:8443/'))).toBe(false);
    });

    it('recognises credential headers by name', () => {
      for (const h of ['Authorization', 'X-Api-Key', 'apikey', 'X-Shopify-Access-Token', 'X-Client-Secret', 'X-Signature']) {
        expect(isCredentialHeader(h)).toBe(true);
      }
      for (const h of ['Accept', 'Content-Type', 'User-Agent', 'X-Request-Id']) {
        expect(isCredentialHeader(h)).toBe(false);
      }
    });
  });

  describe('outboundRequest: limits', () => {
    it('stops after five redirects by default', async () => {
      const loop = await serve(redirectTo('/again'));
      const err = await outboundRequest({ url: `http://localhost:${loop.port}/` }).catch((e) => e);
      expect(err).toBeInstanceOf(AxiosError);
      expect(err.code).toBe('ERR_FR_TOO_MANY_REDIRECTS');
      expect(loop.hits).toHaveLength(6);
    });

    it('honours a lower cap', async () => {
      const loop = await serve(redirectTo('/again'));
      await expect(
        outboundRequest({ url: `http://localhost:${loop.port}/` }, { maxRedirects: 2 }),
      ).rejects.toThrow(/Maximum number of redirects/);
      expect(loop.hits).toHaveLength(3);
    });

    it('applies one timeout to the whole exchange', async () => {
      const slow = await serve((_q, _b, res) => setTimeout(() => res.end('late'), 400));
      const hop = await serve(redirectTo(`http://localhost:${slow.port}/`));
      const started = Date.now();
      await expect(
        outboundRequest({ url: `http://localhost:${hop.port}/`, timeout: 200 }),
      ).rejects.toThrow(/timeout/);
      expect(Date.now() - started).toBeLessThan(380);
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

    it('drops credential headers when the redirect leaves the origin', async () => {
      // Another port is another origin; fetch resolves names itself, so no fake host here.
      const other = await serve((_q, _b, res) => res.end('ok'));
      const pub = await serve(redirectTo(`http://localhost:${other.port}/`));
      await ssrfGuardedFetch(`http://localhost:${pub.port}/`, {
        headers: {
          Authorization: 'Bearer t',
          Cookie: 'a=b',
          'X-API-Key': 'k',
          Accept: 'application/json',
        },
      });
      expect(other.hits[0].headers.authorization).toBeUndefined();
      expect(other.hits[0].headers.cookie).toBeUndefined();
      expect(other.hits[0].headers['x-api-key']).toBeUndefined();
      expect(other.hits[0].headers.accept).toBe('application/json');
    });

    it('checks the address the connection uses, not an earlier DNS answer', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      // Public when the caller checks the URL, loopback when fetch connects.
      const answers = ['93.184.216.34', '127.0.0.1'];
      fakeHosts['rebind.test'] = () => answers.shift() ?? '127.0.0.1';
      const url = `http://rebind.test:${internal.port}/mcp`;
      await assertSafeOutboundUrl(url);
      const call = ssrfGuardedFetch(url, { method: 'POST', body: '{}' });
      await expect(call).rejects.toBeInstanceOf(SsrfBlockedError);
      await expect(call).rejects.toThrow(/non-public address '127\.0\.0\.1'/);
      expect(internal.hits).toHaveLength(0);
    });

    it('refuses a name that resolves to a link-local address at connect time', async () => {
      fakeHosts['metadata.test'] = '169.254.169.254';
      await expect(ssrfGuardedFetch('http://metadata.test/latest/meta-data/')).rejects.toThrow(
        /non-public address '169\.254\.169\.254'/,
      );
    });

    it('checks the starting URL itself: a literal internal IP is refused before connecting', async () => {
      const internal = await serve((_q, _b, res) => res.end('INTERNAL'));
      await expect(ssrfGuardedFetch(`http://127.0.0.1:${internal.port}/`)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      await expect(ssrfGuardedFetch('file:///etc/passwd')).rejects.toThrow(/protocol 'file:'/);
      expect(internal.hits).toHaveLength(0);
    });

    it('connects to the address it checked when the policy allows it', async () => {
      const s = await serve((_q, _b, res) => res.end('ok'));
      // Loopback allowed stands in for a public address here.
      process.env.SSRF_ALLOW_LOCALHOST = 'true';
      fakeHosts['public.test'] = '127.0.0.1';
      try {
        const res = await ssrfGuardedFetch(`http://public.test:${s.port}/`);
        expect(await res.text()).toBe('ok');
        expect(s.hits[0].headers.host).toBe(`public.test:${s.port}`);
      } finally {
        delete process.env.SSRF_ALLOW_LOCALHOST;
      }
    });

    it('resolves a name once per connection, not once per request', async () => {
      const s = await serve((_q, _b, res) => res.end('ok'));
      const connections = new Set<number>();
      servers[servers.length - 1].on('connection', (socket) => connections.add(socket.remotePort!));
      process.env.SSRF_ALLOW_LOCALHOST = 'true';
      fakeHosts['session.test'] = '127.0.0.1';
      try {
        for (let i = 0; i < 10; i++) {
          await (await ssrfGuardedFetch(`http://session.test:${s.port}/mcp`, { method: 'POST', body: '{}' })).text();
        }
        const lookups = (dns.promises.lookup as unknown as jest.Mock).mock.calls.filter(
          ([host]) => host === 'session.test',
        );
        expect(s.hits).toHaveLength(10);
        // Pooled connections are reused, and each new one is checked once.
        expect(connections.size).toBeLessThan(10);
        expect(lookups).toHaveLength(connections.size);
      } finally {
        delete process.env.SSRF_ALLOW_LOCALHOST;
      }
    });

    it('lets an allowlisted host through, and refuses it with skipAllowlists', async () => {
      const s = await serve((_q, _b, res) => res.end('ok'));
      // api.other.test is in SSRF_ALLOWED_HOSTS and resolves to 127.0.0.1.
      const res = await ssrfGuardedFetch(`http://api.other.test:${s.port}/`);
      expect(await res.text()).toBe('ok');
      await expect(
        ssrfGuardedFetch(`http://api.other.test:${s.port}/`, {}, { skipAllowlists: true }),
      ).rejects.toThrow(/non-public address '127\.0\.0\.1'/);
      expect(s.hits).toHaveLength(1);
    });

    it('lets a host from the admin allowlist through', async () => {
      const s = await serve((_q, _b, res) => res.end('ok'));
      fakeHosts['admin-listed.test'] = '127.0.0.1';
      setDbAllowedHostsProvider(async () => ['admin-listed.test']);
      try {
        const res = await ssrfGuardedFetch(`http://admin-listed.test:${s.port}/`);
        expect(await res.text()).toBe('ok');
      } finally {
        setDbAllowedHostsProvider(async () => []);
      }
    });

    it('streams a server-sent event response through the guarded connection', async () => {
      let finish: () => void = () => undefined;
      const s = await serve((_q, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('event: message\ndata: {"n":1}\n\n');
        finish = () => {
          res.write('event: message\ndata: {"n":2}\n\n');
          res.end();
        };
      });
      const res = await ssrfGuardedFetch(`http://localhost:${s.port}/mcp`, {
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      // The first event arrives while the response is still open.
      const first = await reader.read();
      expect(first.value).toContain('data: {"n":1}');
      finish();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += value;
      }
      expect(rest).toContain('data: {"n":2}');
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
