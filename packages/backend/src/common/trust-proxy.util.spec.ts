import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { DEFAULT_TRUST_PROXY, resolveTrustProxy } from './trust-proxy.util';

describe('resolveTrustProxy', () => {
  it('trusts only private-network proxies by default', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolveTrustProxy(raw)).toEqual(
        expect.objectContaining({ value: DEFAULT_TRUST_PROXY, unsafe: false }),
      );
    }
  });

  it('reads a number of hops', () => {
    expect(resolveTrustProxy('1').value).toBe(1);
    expect(resolveTrustProxy(' 2 ').value).toBe(2);
    expect(resolveTrustProxy('0').value).toBe(false);
  });

  it('reads true and false, and flags true as unsafe', () => {
    expect(resolveTrustProxy('false')).toEqual(expect.objectContaining({ value: false, unsafe: false }));
    expect(resolveTrustProxy('TRUE')).toEqual(expect.objectContaining({ value: true, unsafe: true }));
  });

  it('reads a list of addresses, ranges and names', () => {
    expect(resolveTrustProxy('loopback,  203.0.113.0/24 ,198.51.100.7').value).toBe(
      'loopback, 203.0.113.0/24, 198.51.100.7',
    );
  });

  it('refuses a value Express would not understand', () => {
    expect(() => resolveTrustProxy('not-a-proxy')).toThrow(/TRUST_PROXY/);
    expect(() => resolveTrustProxy('10.0.0.0/99')).toThrow(/TRUST_PROXY/);
  });
});

describe('req.ip behind a proxy', () => {
  // The backend sees the request from 127.0.0.1 (a proxy on the same host or
  // Docker network); the proxy appended the address it saw, 203.0.113.7, to
  // whatever X-Forwarded-For the client sent.
  const forwardedFor = '10.10.10.10, 198.51.100.99, 203.0.113.7';

  async function ipSeenWith(trust: boolean | number | string, xff: string): Promise<string> {
    const app = express();
    app.set('trust proxy', trust);
    app.get('/', (req, res) => {
      res.send(req.ip);
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': xff } });
      return await res.text();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('gives the address the proxy saw by default, not one the client made up', async () => {
    expect(await ipSeenWith(resolveTrustProxy(undefined).value, forwardedFor)).toBe('203.0.113.7');
  });

  it('gives the right address for one hop as well', async () => {
    expect(await ipSeenWith(resolveTrustProxy('1').value, forwardedFor)).toBe('203.0.113.7');
  });

  it('let the client choose its address with the old setting (true)', async () => {
    expect(await ipSeenWith(true, forwardedFor)).toBe('10.10.10.10');
  });

  it('still sees a client on the same private network', async () => {
    expect(await ipSeenWith(resolveTrustProxy(undefined).value, '192.168.1.20')).toBe('192.168.1.20');
  });
});
