import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Proxy agent for TLS-intercepting web unblockers (e.g. Zyte).
 *
 * Web unblockers MITM the upstream TLS connection and present their own leaf
 * certificate, so the upstream handshake cannot be verified against the system
 * CA store. We must therefore connect with `rejectUnauthorized: false`.
 *
 * The catch: passing `rejectUnauthorized: false` to the `HttpsProxyAgent`
 * constructor only applies it to the hop *to the proxy*. In
 * `https-proxy-agent@7`, the upstream TLS upgrade (after the CONNECT tunnel) is
 * built from the per-request `opts`, NOT from the constructor options — so the
 * flag never reaches the upstream socket and Node throws
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on the unblocker's MITM cert.
 *
 * This subclass injects `rejectUnauthorized: false` into the per-request opts
 * so it actually applies to the upstream TLS connection. Equivalent to curl's
 * `--proxy-insecure`. Only used for explicitly proxied connector calls.
 */
type ConnectArgs = Parameters<HttpsProxyAgent<string>['connect']>;

class UnblockerProxyAgent extends HttpsProxyAgent<string> {
  async connect(req: ConnectArgs[0], opts: ConnectArgs[1]) {
    // `rejectUnauthorized` only exists on the HTTPS branch of AgentConnectOpts;
    // cast through the param type so the merge stays well-typed.
    const insecure = { ...opts, rejectUnauthorized: false } as ConnectArgs[1];
    return super.connect(req, insecure);
  }
}

/**
 * Build a proxy agent for a TLS-intercepting web unblocker. The returned agent
 * disables upstream certificate verification (see UnblockerProxyAgent) — use it
 * only for calls deliberately routed through the unblocker proxy.
 */
export function createUnblockerProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  // rejectUnauthorized:false on the constructor covers the proxy hop; the
  // subclass covers the upstream hop. Both are needed.
  return new UnblockerProxyAgent(proxyUrl, { rejectUnauthorized: false });
}
