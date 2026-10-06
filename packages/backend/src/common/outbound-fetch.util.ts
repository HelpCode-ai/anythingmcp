import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import {
  assertSafeOutboundUrl,
  createSsrfGuardedAgents,
  SsrfBlockedError,
} from './ssrf.util';
import { isCredentialHeader, keepsCredentials } from './outbound-http';

/**
 * Download a third-party URL on a user's behalf: a file to attach to a
 * request, a spec to import, anything whose address comes from a user or a
 * model rather than from the connector's own configuration.
 *
 * What it guarantees, so callers don't each re-implement it:
 *  - SSRF: every hop (the URL and each redirect target) passes
 *    assertSafeOutboundUrl, and the socket connects only to addresses the
 *    guard checked (ssrfGuardedLookup), so neither a redirect nor a DNS
 *    answer that changes after the check reaches an internal address.
 *  - A bare request: only the headers the caller passes, no env proxy, no
 *    cookies. Never pass connector credentials here; on a redirect to
 *    another origin, credential headers are dropped anyway (see
 *    isCredentialHeader in outbound-http.ts).
 *  - Bounded: one deadline for the whole exchange (redirects and body
 *    included) and a byte cap, enforced on Content-Length up front and on
 *    the bytes actually read. The body is buffered, so it can be sent again
 *    (e.g. on a 401 retry).
 *  - Non-2xx answers are errors, so an error page never passes as content.
 *  - Errors name the URL without its query string: presigned links carry
 *    their credentials there.
 */

export const OUTBOUND_FETCH_DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 5,
};

export interface OutboundFetchOptions {
  /** Byte cap on the (decompressed) body. Default 10 MB. */
  maxBytes?: number;
  /** Deadline for the whole exchange, redirects included. Default 30 s. */
  timeoutMs?: number;
  /** Redirects to follow; each target is checked again. Default 5. */
  maxRedirects?: number;
  /** Request headers. Nothing else is sent besides axios' own defaults. */
  headers?: Record<string, string>;
  /** Policy env, for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface OutboundFetchResult {
  status: number;
  /** Response headers, lower-cased names. */
  headers: Record<string, string>;
  body: Buffer;
  /** The URL that answered, after redirects. */
  finalUrl: string;
}

export type OutboundFetchFailure =
  | 'invalid_url'
  | 'status'
  | 'too_large'
  | 'timeout'
  | 'too_many_redirects'
  | 'network';

export class OutboundFetchError extends Error {
  constructor(
    message: string,
    readonly reason: OutboundFetchFailure,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundFetchError';
  }
}

/** `origin + path` of a URL, for messages and logs: no query, no fragment, no userinfo. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET `url` with the guarantees described above. Throws SsrfBlockedError when
 * a hop is not allowed (so callers can keep showing the allowlist hint) and
 * OutboundFetchError for everything else.
 */
export async function fetchOutbound(
  url: string,
  options: OutboundFetchOptions = {},
): Promise<OutboundFetchResult> {
  const maxBytes = options.maxBytes ?? OUTBOUND_FETCH_DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? OUTBOUND_FETCH_DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? OUTBOUND_FETCH_DEFAULTS.maxRedirects;
  const env = options.env ?? process.env;
  const { httpAgent, httpsAgent } = createSsrfGuardedAgents(env);
  let headers: Record<string, string> = { ...(options.headers ?? {}) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = url;
  try {
    for (let redirects = 0; ; redirects++) {
      await assertHop(current, env);
      const res = await request(current, headers, controller.signal, httpAgent, httpsAgent);
      const stream = res.data as Readable;

      const location = res.headers['location'];
      if (REDIRECT_STATUSES.has(res.status) && typeof location === 'string') {
        stream.destroy();
        if (redirects >= maxRedirects) {
          throw new OutboundFetchError(
            `${redactUrl(url)} redirected more than ${maxRedirects} times.`,
            'too_many_redirects',
          );
        }
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new OutboundFetchError(
            `${redactUrl(current)} redirected to an invalid URL.`,
            'invalid_url',
          );
        }
        if (!keepsCredentials(new URL(current), new URL(next))) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !isCredentialHeader(k)),
          );
        }
        current = next;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        stream.destroy();
        throw new OutboundFetchError(
          `${redactUrl(current)} answered HTTP ${res.status}.`,
          'status',
          res.status,
        );
      }

      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        stream.destroy();
        throw tooLarge(current, maxBytes);
      }
      const body = await readWithLimit(stream, maxBytes, current, controller.signal);
      return {
        status: res.status,
        headers: flattenHeaders(res.headers),
        body,
        finalUrl: current,
      };
    }
  } catch (err) {
    if (err instanceof OutboundFetchError || err instanceof SsrfBlockedError) throw err;
    // The guarded lookup rejects inside the HTTP client; surface its error.
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof SsrfBlockedError) throw cause;
    if (controller.signal.aborted) {
      throw new OutboundFetchError(
        `${redactUrl(current)} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
        'timeout',
      );
    }
    const code = (err as { code?: string })?.code;
    throw new OutboundFetchError(
      `Could not fetch ${redactUrl(current)}${code ? ` (${code})` : ''}.`,
      'network',
    );
  } finally {
    clearTimeout(timer);
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}

async function assertHop(url: string, env: NodeJS.ProcessEnv): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OutboundFetchError('Not a valid URL.', 'invalid_url');
  }
  // Checked here as well, because the guard itself can be disabled by env.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutboundFetchError(
      `Only http and https URLs can be fetched, not '${parsed.protocol}'.`,
      'invalid_url',
    );
  }
  await assertSafeOutboundUrl(url, env);
}

function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  httpAgent: unknown,
  httpsAgent: unknown,
): Promise<AxiosResponse> {
  return axios.request({
    url,
    method: 'GET',
    headers,
    responseType: 'stream',
    // Redirects are followed by hand above, so each target is checked.
    maxRedirects: 0,
    // An env proxy would resolve the proxy instead of the target and skip
    // the guarded lookup.
    proxy: false,
    httpAgent,
    httpsAgent,
    signal,
    validateStatus: () => true,
  });
}

function readWithLimit(
  stream: Readable,
  maxBytes: number,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      stream.removeListener('data', onData);
      if (err) {
        stream.destroy();
        reject(err);
      } else {
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) return finish(tooLarge(url, maxBytes));
      chunks.push(chunk);
    };
    const onAbort = () =>
      finish(
        new OutboundFetchError(`${redactUrl(url)} did not finish in time.`, 'timeout'),
      );
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    stream.on('data', onData);
    stream.once('end', () => finish(null));
    stream.once('error', (e) => finish(e));
  });
}

function tooLarge(url: string, maxBytes: number): OutboundFetchError {
  return new OutboundFetchError(
    `${redactUrl(url)} is larger than ${formatBytes(maxBytes)}.`,
    'too_large',
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

function flattenHeaders(raw: AxiosResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}
