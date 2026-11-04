// Browser login for the amcp CLI (RFC 8252 loopback redirect), used by
// `amcp login --browser`. It does NOT replace the existing key-based logins:
// it is an extra way to obtain a management key without pasting one.
//
// Flow: the CLI starts a one-shot HTTP server bound to 127.0.0.1 on a random
// port, opens the instance's /cli-auth page in the browser, and waits. The
// page runs under the user's existing dashboard session, mints a management
// key with the existing POST /api/mcp-keys, and delivers it back by POSTing a
// form to the loopback server — so the key travels in a request body, never in
// a URL, query string, log or browser history. A `state` value binds the
// browser round-trip to this CLI invocation, and a short verification code
// shown in both places lets the user confirm they match.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URLSearchParams } from 'node:url';

export interface BrowserAuthResult {
  key: string;
  authorizeUrl: string;
  code: string;
}

export type ManagementScopeArg = 'read' | 'admin';

const SCOPE_MAP: Record<ManagementScopeArg, string> = {
  read: 'MANAGEMENT_READ',
  admin: 'MANAGEMENT_ADMIN',
};

/** A short, human-checkable code derived from the state (e.g. "4F2A-9C1E"). */
function verificationCode(state: string): string {
  const hex = state.slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/** Best-effort open of a URL in the default browser; never throws. */
function openBrowser(url: string): void {
  // Headless / CI / tests: skip launching and rely on the printed URL.
  if (process.env.AMCP_NO_BROWSER === '1') return;
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Headless or no opener: the caller has already printed the URL.
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111">`
    + `<h1 style="font-size:1.1rem">${title}</h1><p>${body}</p></body>`;
}

/**
 * Run the loopback browser-authorization flow. Resolves with the minted key,
 * or rejects on denial, timeout, or a state mismatch. `instanceOrigin` is the
 * instance's origin (e.g. https://cloud.anythingmcp.com); a browser POST that
 * names any other origin is refused. The opaque origin "null" is accepted:
 * that is what browsers send when an HTTPS page posts to the loopback.
 */
export function browserAuthorize(options: {
  instanceUrl: string;
  instanceOrigin: string;
  scope: ManagementScopeArg;
  label: string;
  timeoutMs?: number;
  onUrl?: (url: string, code: string) => void;
}): Promise<BrowserAuthResult> {
  const { instanceUrl, instanceOrigin, scope, label } = options;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const state = randomBytes(24).toString('hex');
  const code = verificationCode(state);

  return new Promise<BrowserAuthResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('amcp', 'This endpoint expects the authorization to be posted from the dashboard.'));
        return;
      }
      // Reject a POST that names a different origin. Browsers send the opaque
      // origin "null" when an HTTPS page posts a form to this http:// loopback
      // (a secure-to-insecure navigation), so "null" must be accepted; the
      // unguessable `state` checked below is what binds the request.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== 'null' && origin !== instanceOrigin) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('amcp', 'Unexpected origin. Nothing was saved.'));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 64_000) req.destroy(); // a key is tiny; cap the body
      });
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        if (form.get('state') !== state) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('amcp', 'This request did not match the one your terminal started. Nothing was saved.'));
          finish(() => reject(new Error('State mismatch: the browser response did not match this login attempt')));
          return;
        }
        const error = form.get('error');
        const key = form.get('key');
        if (error || !key) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Authorization cancelled', 'You can close this tab and return to your terminal.'));
          finish(() => reject(new Error(error === 'access_denied' ? 'Authorization was declined in the browser' : 'No key was returned by the browser')));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('You are signed in', 'The amcp CLI has your key. You can close this tab and return to your terminal.'));
        finish(() => resolve({ key, authorizeUrl, code }));
      });
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser`)));
    }, timeoutMs);

    let authorizeUrl = '';
    server.on('error', (err) => finish(() => reject(err)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(() => reject(new Error('Could not start the local callback server')));
        return;
      }
      const callback = `http://127.0.0.1:${address.port}/`;
      const params = new URLSearchParams({
        callback,
        state,
        code,
        scope: SCOPE_MAP[scope],
        label,
      });
      authorizeUrl = `${instanceUrl.replace(/\/$/, '')}/cli-auth?${params.toString()}`;
      options.onUrl?.(authorizeUrl, code);
      openBrowser(authorizeUrl);
    });
  });
}
