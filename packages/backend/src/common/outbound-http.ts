import axios, {
  AxiosAdapter,
  AxiosError,
  AxiosHeaders,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import * as http from 'http';
import * as https from 'https';
import {
  assertSafeOutboundUrl,
  createSsrfGuardedAgents,
  SsrfBlockedError,
} from './ssrf.util';

/**
 * Outbound HTTP to user-supplied URLs.
 *
 * This module is the single entry point for requests whose address comes from
 * a connector, an import or a user rather than from our own configuration:
 * connector base URLs, token and login endpoints, spec and schema URLs, MCP
 * servers. Use it for every such request:
 *  - axios: `outboundRequest(config)`, or spread `outboundAxiosOptions()` into
 *    the config of `axios.get/post/...`; `outboundAxios()` for libraries that
 *    take an axios instance (soap).
 *  - fetch: `ssrfGuardedFetch`, for libraries that take a fetch (the MCP SDK).
 *  - Downloading a file or document for a user: `fetchOutbound`
 *    (outbound-fetch.util), which adds a byte cap and a deadline.
 *
 * What the axios path does:
 *  - The outbound policy (assertSafeOutboundUrl: SSRF_* env, the admin
 *    allowlist, the public-address rule) is applied to every hop: the URL
 *    and each redirect target.
 *  - Sockets connect through agents whose `lookup` applies the same policy to
 *    the addresses actually connected to (ssrfGuardedLookup), so the check and
 *    the connection use the same DNS answer.
 *  - Redirects are followed by our own code (the HTTP client sends with
 *    `maxRedirects: 0`): at most 5 by default, `Location` resolved against the
 *    current URL, 303 (and 301/302 after a POST) turned into a GET without a
 *    body, 307/308 resent with method and body.
 *  - When a redirect leaves the origin (scheme, host, port), credentials stay
 *    behind: Authorization, Cookie, Proxy-Authorization, HTTP Basic `auth`,
 *    headers whose name says they carry a credential (`*-Api-Key`, `*Token*`,
 *    ...) and any header the caller lists in `credentialHeaders`. An upgrade
 *    from http to https on the same host keeps them. A body that carries
 *    credentials (`credentialsInBody`) is never resent to another origin.
 *  - `timeout` is one deadline for the whole exchange, redirects included.
 *    Everything else the caller sets (responseType, validateStatus, signal,
 *    maxContentLength, headers, ...) applies to every hop, and validateStatus
 *    to the final response.
 *
 * Proxies: a connector's own proxy agent (proxyUrl) replaces the guarded
 * agents, and an operator proxy from HTTP(S)_PROXY is applied by axios as
 * before. In both cases the proxy resolves the target, so the connect-time
 * check does not see it; every hop's URL is still checked here first.
 */

export const OUTBOUND_MAX_REDIRECTS = 5;

export interface OutboundRequestOptions {
  /** Redirects to follow. Default: the config's maxRedirects, else 5. */
  maxRedirects?: number;
  /**
   * Builds the request body again for a redirect that resends it (307/308).
   * Needed for one-shot bodies such as a form-data stream; the value must be
   * ready to send (string, Buffer, stream or form-data), as axios' request
   * transforms do not run on it.
   */
  data?: () => unknown;
  /**
   * Headers that carry credentials besides the ones recognised by name (see
   * {@link isCredentialHeader}), e.g. a connector's API key header. They are
   * not sent to another origin after a redirect.
   */
  credentialHeaders?: string[];
  /**
   * The body carries credentials (a token request, a login). A redirect to
   * another origin that would send the body again (307/308) is refused.
   */
  credentialsInBody?: boolean;
  /**
   * Ignore the env/DB SSRF allowlists for this call and every redirect hop
   * (see {@link VetHostOptions} in `ssrf.util.ts`). Use this when the target
   * is a URL a workspace admin supplies for something other than a
   * connector — an alert webhook, for instance — so it never inherits trust
   * an admin granted a connector for an unrelated reason.
   */
  skipAllowlists?: boolean;
}

let sharedAgents: { httpAgent: http.Agent; httpsAgent: https.Agent } | null = null;
let sharedStrictAgents: { httpAgent: http.Agent; httpsAgent: https.Agent } | null = null;

function guardedAgents(options?: OutboundRequestOptions) {
  // The lookup reads process.env on every call, so one pair serves all.
  if (options?.skipAllowlists) {
    sharedStrictAgents ??= createSsrfGuardedAgents(process.env, { skipAllowlists: true });
    return sharedStrictAgents;
  }
  sharedAgents ??= createSsrfGuardedAgents();
  return sharedAgents;
}

let sharedAdapter: AxiosAdapter | null = null;

/**
 * Spread into the config of any axios call to a user-supplied URL. A caller
 * that needs its own agent (a connector's proxy) sets httpAgent/httpsAgent
 * after the spread; the adapter, and with it every check above, stays.
 */
export function outboundAxiosOptions(
  options?: OutboundRequestOptions,
): Pick<AxiosRequestConfig, 'httpAgent' | 'httpsAgent' | 'adapter'> {
  const { httpAgent, httpsAgent } = guardedAgents(options);
  const adapter = options
    ? createOutboundAdapter(options)
    : (sharedAdapter ??= createOutboundAdapter({}));
  return { httpAgent, httpsAgent, adapter };
}

/** axios(config) with {@link outboundAxiosOptions}; agents set in `config` win. */
export function outboundRequest<T = any>(
  config: AxiosRequestConfig,
  options?: OutboundRequestOptions,
): Promise<AxiosResponse<T>> {
  const { adapter, ...agents } = outboundAxiosOptions(options);
  return axios({ ...agents, ...config, adapter });
}

let sharedAxios: AxiosInstance | null = null;

/** An axios instance with {@link outboundAxiosOptions}, for libraries that take one (soap). */
export function outboundAxios(): AxiosInstance {
  sharedAxios ??= axios.create(outboundAxiosOptions());
  return sharedAxios;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function createOutboundAdapter(options: OutboundRequestOptions): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const send = axios.getAdapter('http');
    const limit = options.maxRedirects ?? config.maxRedirects ?? OUTBOUND_MAX_REDIRECTS;
    const accept = config.validateStatus;
    const deadline = config.timeout ? Date.now() + config.timeout : 0;

    let url = axios.getUri(config);
    let hop: InternalAxiosRequestConfig = {
      ...config,
      maxRedirects: 0,
      beforeRedirect: undefined,
      // Settled below, once, on the final response.
      validateStatus: null,
    };

    for (let redirects = 0; ; redirects++) {
      await assertSafeOutboundUrl(url, process.env, { skipAllowlists: options.skipAllowlists });
      if (deadline) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new AxiosError(
            `timeout of ${config.timeout}ms exceeded`,
            AxiosError.ECONNABORTED,
            config,
          );
        }
        hop.timeout = left;
      }

      let res: AxiosResponse;
      try {
        res = await send(hop);
      } catch (err) {
        // The guarded lookup fails inside the HTTP client, which wraps the
        // error; hand back the guard's own error, as the URL check does.
        const cause = (err as { cause?: unknown })?.cause;
        throw cause instanceof SsrfBlockedError ? cause : err;
      }

      const location = res.headers?.['location'];
      if (!REDIRECT_STATUSES.has(res.status) || typeof location !== 'string' || limit <= 0) {
        return settle(res, accept);
      }
      discardBody(res);
      if (redirects >= limit) {
        throw new AxiosError(
          'Maximum number of redirects exceeded',
          'ERR_FR_TOO_MANY_REDIRECTS',
          config,
          res.request,
        );
      }

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new AxiosError(
          `Redirected to an invalid URL by ${safeOrigin(url)}`,
          AxiosError.ERR_BAD_RESPONSE,
          config,
          res.request,
        );
      }
      hop = redirectedConfig(hop, res.status, new URL(url), next, options);
      url = next.toString();
    }
  };
}

/** Same outcome as axios' own settle: the response, or an AxiosError carrying it. */
function settle(
  res: AxiosResponse,
  accept: ((status: number) => boolean) | null | undefined,
): AxiosResponse {
  if (!res.status || !accept || accept(res.status)) return res;
  throw new AxiosError(
    `Request failed with status code ${res.status}`,
    [AxiosError.ERR_BAD_REQUEST, AxiosError.ERR_BAD_RESPONSE][Math.floor(res.status / 100) - 4],
    res.config,
    res.request,
    res,
  );
}

function discardBody(res: AxiosResponse): void {
  const data = res.data as { destroy?: () => void } | undefined;
  if (data && typeof data.destroy === 'function') data.destroy();
}

function isStream(data: unknown): boolean {
  return !!data && typeof (data as { pipe?: unknown }).pipe === 'function';
}

/** The config for the request a redirect asks for. */
function redirectedConfig(
  hop: InternalAxiosRequestConfig,
  status: number,
  from: URL,
  to: URL,
  options: OutboundRequestOptions,
): InternalAxiosRequestConfig {
  const headers = new AxiosHeaders(AxiosHeaders.from(hop.headers).toJSON());
  headers.delete('host');

  let method = String(hop.method || 'get').toUpperCase();
  let data = hop.data;
  const toGet =
    status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (status === 301 || status === 302) && method === 'POST';
  if (toGet) {
    method = 'GET';
    data = undefined;
    for (const name of Object.keys(headers.toJSON())) {
      if (/^content-/i.test(name)) headers.delete(name);
    }
  } else if (data !== undefined && data !== null) {
    if (options.data) {
      data = options.data();
    } else if (isStream(data)) {
      throw new AxiosError(
        `${from.origin} redirected (${status}) a request whose body was streamed and cannot be sent again`,
        AxiosError.ERR_BAD_REQUEST,
        hop,
      );
    }
  }

  let auth = hop.auth;
  if (!keepsCredentials(from, to)) {
    if (options.credentialsInBody && data !== undefined && data !== null) {
      throw new AxiosError(
        `${from.origin} redirected (${status}) the request to ${to.origin}; ` +
          'its body carries credentials and is not sent to another origin',
        AxiosError.ERR_BAD_REQUEST,
        hop,
      );
    }
    const extra = new Set((options.credentialHeaders ?? []).map((h) => h.toLowerCase()));
    for (const name of Object.keys(headers.toJSON())) {
      if (isCredentialHeader(name, extra)) headers.delete(name);
    }
    auth = undefined;
  }

  return {
    ...hop,
    url: to.toString(),
    baseURL: undefined,
    params: undefined,
    method,
    data,
    headers,
    auth,
  };
}

/**
 * Whether credentials may follow a redirect from `from` to `to`: same origin,
 * or the same host moving from http to https on the default ports.
 */
export function keepsCredentials(from: URL, to: URL): boolean {
  if (from.origin === to.origin) return true;
  return (
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    from.hostname === to.hostname &&
    from.port === '' &&
    to.port === ''
  );
}

const ALWAYS_CREDENTIAL = new Set(['authorization', 'proxy-authorization', 'cookie']);
const CREDENTIAL_NAME =
  /auth|token|api[-_]?key|secret|session|signature|password|passwd|credential/i;

/**
 * Whether a request header must not be sent to another origin after a
 * redirect: the standard credential headers, any name that says it carries
 * one, and the names in `extra` (lower-cased).
 */
export function isCredentialHeader(name: string, extra: Set<string> = new Set()): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_CREDENTIAL.has(lower) || extra.has(lower) || CREDENTIAL_NAME.test(lower);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the server';
  }
}

/**
 * A `fetch` that follows redirects itself and runs assertSafeOutboundUrl on
 * every redirect target. Same semantics as fetch otherwise: 307/308 keep
 * method and body, 303 (and 301/302 after a POST) turn into a body-less GET,
 * and credential headers are dropped when the redirect leaves the origin.
 *
 * The URL passed in is NOT checked here: the caller checks it once, as every
 * caller already does. An MCP transport calls this for each message of a
 * session, and a DNS lookup per message would be pure overhead.
 */
export async function ssrfGuardedFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  let url = typeof input === 'string' ? input : input.toString();
  let current: RequestInit = { ...init };
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...current, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (init.redirect === 'manual') return res;
    if (init.redirect === 'error') throw new TypeError(`Redirect refused for ${url}`);
    if (hop >= OUTBOUND_MAX_REDIRECTS) {
      throw new TypeError(`Too many redirects from ${new URL(url).origin}`);
    }
    await res.body?.cancel().catch(() => undefined);

    const next = new URL(location, url);
    await assertSafeOutboundUrl(next.toString());
    const method = (current.method ?? 'GET').toUpperCase();
    const toGet =
      res.status === 303
        ? method !== 'GET' && method !== 'HEAD'
        : (res.status === 301 || res.status === 302) && method === 'POST';
    if (toGet) {
      const headers = new Headers(current.headers);
      for (const name of [...headers.keys()]) {
        if (name.startsWith('content-')) headers.delete(name);
      }
      current = { ...current, method: 'GET', body: undefined, headers };
    }
    if (!keepsCredentials(new URL(url), next)) {
      const headers = new Headers(current.headers);
      for (const name of [...headers.keys()]) {
        if (isCredentialHeader(name)) headers.delete(name);
      }
      current = { ...current, headers };
    }
    url = next.toString();
  }
}
