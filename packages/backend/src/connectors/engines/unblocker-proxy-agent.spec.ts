import { createUnblockerProxyAgent } from './unblocker-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Regression: every connector with useProxy=true went down for ~8 days because
 * the Zyte web-unblocker MITMs the upstream TLS, and `rejectUnauthorized:false`
 * passed to the HttpsProxyAgent constructor only covers the hop to the proxy —
 * not the upstream TLS upgrade (https-proxy-agent@7 builds that from the
 * per-request opts). Node then threw UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 *
 * The fix injects rejectUnauthorized:false into the per-request opts via a
 * connect() override. These tests pin that behaviour.
 */
describe('createUnblockerProxyAgent', () => {
  it('returns an HttpsProxyAgent', () => {
    const agent = createUnblockerProxyAgent('http://user:@proxy.example:8011');
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
  });

  it('injects rejectUnauthorized:false into the UPSTREAM connect opts', async () => {
    const agent = createUnblockerProxyAgent('http://user:@proxy.example:8011');

    // Capture the opts the override forwards to the base connect (the upstream
    // TLS path), without actually opening a socket.
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(agent));
    const superConnect = jest
      .spyOn(proto, 'connect')
      .mockResolvedValue({} as never);

    const reqOpts: any = { host: 'int.bahn.de', port: 443, secureEndpoint: true };
    await (agent as any).connect({} as any, reqOpts);

    expect(superConnect).toHaveBeenCalledTimes(1);
    const forwarded = superConnect.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded.rejectUnauthorized).toBe(false);
    // Original opts must be preserved (host/port still routed upstream).
    expect(forwarded.host).toBe('int.bahn.de');
    expect(forwarded.port).toBe(443);

    superConnect.mockRestore();
  });
});
