import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { getAdapter } from '../adapters/catalog';
import { RestEngine } from './engines/rest.engine';
import { withCatalogUserAgent } from './catalog-user-agent.util';

const SEVDESK_UA = 'AnythingMCP (support@anythingmcp.com)';

describe('withCatalogUserAgent', () => {
  it('the sevdesk adapter declares the User-Agent sevdesk asks partners to send', () => {
    expect(getAdapter('sevdesk')?.connector.headers).toEqual({ 'User-Agent': SEVDESK_UA });
  });

  it("adds the adapter's User-Agent to a catalog connector installed without it", () => {
    expect(withCatalogUserAgent(undefined, { adapterSlug: 'sevdesk' })).toEqual({ 'User-Agent': SEVDESK_UA });
    expect(withCatalogUserAgent({ Accept: 'application/json' }, { adapterSlug: 'sevdesk' })).toEqual({
      Accept: 'application/json',
      'User-Agent': SEVDESK_UA,
    });
  });

  it('keeps a User-Agent stored on the connector, whatever its case', () => {
    const own = { 'user-agent': 'my-client/1' };
    expect(withCatalogUserAgent(own, { adapterSlug: 'sevdesk' })).toBe(own);
  });

  it('leaves hand-made connectors and adapters without the header unchanged', () => {
    const headers = { Accept: 'application/json' };
    expect(withCatalogUserAgent(headers, null)).toBe(headers);
    expect(withCatalogUserAgent(headers, { adapterSlug: 42 })).toBe(headers);
    expect(withCatalogUserAgent(headers, { adapterSlug: 'no-such-adapter' })).toBe(headers);
    expect(withCatalogUserAgent(undefined, { adapterSlug: 'lexware-office' })).toBeUndefined();
  });

  it('ignores a templated User-Agent, which may carry a per-connector value', () => {
    const adapter = getAdapter('sevdesk')!;
    const original = adapter.connector.headers;
    (adapter.connector as { headers?: Record<string, string> }).headers = { 'User-Agent': 'client/{{VER}}' };
    try {
      expect(withCatalogUserAgent(undefined, { adapterSlug: 'sevdesk' })).toBeUndefined();
    } finally {
      (adapter.connector as { headers?: Record<string, string> }).headers = original;
    }
  });

  describe('on the wire', () => {
    let server: Server;
    let baseUrl: string;
    let received: IncomingHttpHeaders = {};

    beforeAll(async () => {
      server = createServer((req, res) => {
        received = req.headers;
        res.setHeader('content-type', 'application/json');
        res.end('{"objects":[]}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('a sevdesk call from a connector installed before the header carries it', async () => {
      const engine = new RestEngine({} as any, {} as any);
      await engine.execute(
        {
          baseUrl,
          authType: 'NONE',
          headers: withCatalogUserAgent(undefined, { adapterSlug: 'sevdesk' }),
        },
        { method: 'GET', path: '/SevUser' },
        {},
      );
      expect(received['user-agent']).toBe(SEVDESK_UA);
    });
  });
});
