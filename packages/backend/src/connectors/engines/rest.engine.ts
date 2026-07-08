import { Injectable, Logger } from '@nestjs/common';
import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  Method,
} from 'axios';
import FormData from 'form-data';
import { createUnblockerProxyAgent } from './unblocker-proxy-agent';
import { resolveDbRestProfile } from '../../common/db-rest.util';
import { buildOAuth1Header } from './oauth1-signer';
import { OAuth2TokenService } from './oauth2-token.service';
import {
  LoginTokenService,
  LoginTokenAuthConfig,
} from './login-token.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

/**
 * RestEngine — executes HTTP calls to REST APIs.
 * Handles path parameter interpolation, query params, body mapping, and auth injection.
 * Supports OAuth2 token refresh: if a request returns 401 and a refreshToken + tokenUrl
 * are available, it will attempt to refresh the access token and retry the request once.
 */
@Injectable()
export class RestEngine {
  private readonly logger = new Logger(RestEngine.name);

  constructor(
    private readonly oauth2TokenService: OAuth2TokenService,
    private readonly loginTokenService: LoginTokenService,
  ) {}

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
      connectorId?: string;
      // When set, route this request through the proxy / web-unblocker.
      // The caller (DynamicMcpTools) decides whether a proxy applies
      // (env present, tool opted in, license + rate-limit ok) and passes
      // the URL here, or omits it for a direct request.
      proxyUrl?: string;
    },
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, unknown>;
      bodyMapping?: Record<string, unknown>;
      bodyTemplate?: string;
      bodyEncoding?: string;
      headers?: Record<string, string>;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Interpolate path parameters: /users/{id} → /users/123
    let path = endpointMapping.path;
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`{${key}}`, String(value));
    }

    // Allow per-tool absolute URLs to escape the connector's baseUrl. Useful
    // when a vendor publishes multiple distinct API hosts under one product
    // (e.g. Statsig: api.statsig.com for SDK + statsigapi.net for Console),
    // so a single adapter can cover both without two connector records.
    const url = /^https?:\/\//i.test(path)
      ? path
      : joinBaseAndPath(config.baseUrl, path);
    await assertSafeOutboundUrl(url);

    // Resolve dynamic headers from endpoint mapping ($param references)
    const resolvedEndpointHeaders: Record<string, string> = {};
    if (endpointMapping.headers) {
      for (const [key, value] of Object.entries(endpointMapping.headers)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          const paramVal = params[value.substring(1)];
          if (paramVal !== undefined) {
            resolvedEndpointHeaders[key] = String(paramVal);
          }
        } else {
          resolvedEndpointHeaders[key] = value;
        }
      }
    }

    // Build request config
    const axiosConfig: AxiosRequestConfig = {
      method: endpointMapping.method as Method,
      url,
      headers: {
        ...config.headers,
        ...resolvedEndpointHeaders,
      },
      timeout: 30000,
    };

    // Inject authentication
    await this.injectAuth(axiosConfig, config);

    // Query parameters (merged on top of any params already set by auth injection)
    if (endpointMapping.queryParams) {
      const mappedQuery = this.mapParams(endpointMapping.queryParams, params);
      // `__rawquery` escape hatch (mirrors `__raw` for bodies): some APIs use
      // dynamic query-param KEYS rather than a fixed `filter=` param — e.g.
      // weclapp's `?articleNumber-eq=A5101&productionArticle-eq=true`, where the
      // property+operator IS the param name. A tool maps such input to the
      // `__rawquery` key; its string value is parsed as a query-string fragment
      // and each pair is merged verbatim into the request params.
      if (typeof mappedQuery['__rawquery'] === 'string') {
        const raw = String(mappedQuery['__rawquery']);
        delete mappedQuery['__rawquery'];
        for (const [k, v] of new URLSearchParams(raw)) {
          mappedQuery[k] = v;
        }
      }
      // Cloud-only Deutsche Bahn profile override (see resolveDbRestProfile):
      // in cloud the internal db-rest egresses via the Zyte unblocker where DB's
      // `dbnav` endpoints reject the request, so swap to `dbweb`. Strict no-op
      // off-cloud and for every non-db-rest target.
      axiosConfig.params = {
        ...(axiosConfig.params as Record<string, unknown> | undefined),
        ...resolveDbRestProfile(url, mappedQuery),
      };
    }

    // Request body
    if (['POST', 'PUT', 'PATCH'].includes(endpointMapping.method.toUpperCase())) {
      if (endpointMapping.bodyTemplate) {
        const rendered = renderBodyTemplate(
          endpointMapping.bodyTemplate,
          params,
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(rendered);
        } catch (e: any) {
          throw new Error(`bodyTemplate produced invalid JSON after interpolation: ${e.message}`);
        }
        assertNoPrototypePollution(parsed);
        axiosConfig.data = parsed;
      } else if (endpointMapping.bodyMapping) {
        // Handle __raw body mapping (non-JSON body, e.g. XML/SOAP)
        if ('__raw' in endpointMapping.bodyMapping) {
          const mapped = this.mapParams(endpointMapping.bodyMapping, params);
          axiosConfig.data = mapped['__raw'];
        } else {
          const mapped = this.mapParams(endpointMapping.bodyMapping, params);
          const encoding = endpointMapping.bodyEncoding || 'json';

          if (encoding === 'form-urlencoded') {
            const urlParams = new URLSearchParams();
            for (const [k, v] of spreadFormEntries(mapped)) {
              appendFormParam((key, val) => urlParams.append(key, val), k, v);
            }
            axiosConfig.data = urlParams.toString();
            axiosConfig.headers = {
              ...axiosConfig.headers,
              'Content-Type': 'application/x-www-form-urlencoded',
            };
          } else if (encoding === 'form-data') {
            const form = new FormData();
            for (const [k, v] of spreadFormEntries(mapped)) {
              appendFormParam((key, val) => form.append(key, val), k, v);
            }
            axiosConfig.data = form;
            axiosConfig.headers = {
              ...axiosConfig.headers,
              ...form.getHeaders(),
            };
          } else {
            axiosConfig.data = mapped;
          }
        }
      }
    }

    // OAuth 1.0a signing must happen here — AFTER query params and the body are
    // built, because the signature base string folds in the request's query and
    // form-urlencoded body params (unlike Bearer/API-key auth, which is set in
    // injectAuth before those exist).
    this.applyOAuth1Signature(axiosConfig, config);

    // Route through the proxy / web-unblocker when the caller asked for it.
    // The unblocker agent disables upstream TLS verification (Zyte and friends
    // MITM the connection) — see createUnblockerProxyAgent. Equivalent to
    // curl's --proxy-insecure. We disable axios' native proxy handling so the
    // agent owns the tunnel.
    if (config.proxyUrl) {
      const agent = createUnblockerProxyAgent(config.proxyUrl);
      axiosConfig.httpsAgent = agent;
      axiosConfig.httpAgent = agent;
      axiosConfig.proxy = false;
      this.logger.debug(`REST call via proxy: ${axiosConfig.method} ${url}`);
    } else {
      this.logger.debug(`REST call: ${axiosConfig.method} ${url}`);
    }

    try {
      const response = await this.requestWithRetry(axiosConfig);
      return response.data;
    } catch (error) {
      // OAuth2 auto-refresh: retry once on 401
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        config.authType === 'OAUTH2' &&
        config.authConfig?.refreshToken &&
        config.authConfig?.tokenUrl
      ) {
        this.logger.debug('OAuth2: access token expired, attempting refresh...');
        const newToken = await this.oauth2TokenService.refreshToken(
          config.authConfig,
          config.connectorId,
        );
        if (newToken) {
          axiosConfig.headers = {
            ...axiosConfig.headers,
            Authorization: `Bearer ${newToken}`,
          };
          const retryResponse = await axios(axiosConfig);
          return retryResponse.data;
        }
      }
      // LOGIN_TOKEN auto-relogin: retry once on 401 when refreshOn401 is enabled
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        config.authType === 'LOGIN_TOKEN' &&
        (config.authConfig as Record<string, unknown> | undefined)?.refreshOn401 !== false
      ) {
        this.logger.debug('LOGIN_TOKEN: 401 received, re-issuing token...');
        const authConfig = config.authConfig as unknown as LoginTokenAuthConfig;
        const bundle = await this.loginTokenService.forceRelogin(
          authConfig,
          config.connectorId,
        );
        injectLoginTokenHeaders(axiosConfig, authConfig, bundle.token, bundle.aud);
        const retryResponse = await axios(axiosConfig);
        return retryResponse.data;
      }
      throw error;
    }
  }

  /**
   * Whether an error is a transient failure worth retrying. We only retry on
   * signals that strongly imply the origin did NOT process the request:
   * 429/502/503/504 responses, or connection-level failures with no response.
   * This keeps non-idempotent writes safe (a 500 is never retried).
   */
  private isTransientError(error: unknown): boolean {
    if (!(error instanceof AxiosError)) return false;
    const status = error.response?.status;
    if (status) return [429, 502, 503, 504].includes(status);
    return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(
      error.code ?? '',
    );
  }

  /** Execute the request with a small bounded backoff on transient errors. */
  private async requestWithRetry(
    axiosConfig: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    const delaysMs = [300, 900];
    for (let attempt = 0; ; attempt++) {
      try {
        return await axios(axiosConfig);
      } catch (error) {
        if (attempt >= delaysMs.length || !this.isTransientError(error)) {
          throw error;
        }
        this.logger.debug(
          `Transient error (attempt ${attempt + 1}), retrying in ${delaysMs[attempt]}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }
  }

  private async injectAuth(
    axiosConfig: AxiosRequestConfig,
    config: {
      authType: string;
      authConfig?: Record<string, unknown>;
      connectorId?: string;
    },
  ): Promise<void> {
    if (!config.authConfig) return;

    switch (config.authType) {
      case 'API_KEY': {
        axiosConfig.headers = {
          ...axiosConfig.headers,
          [String(config.authConfig.headerName || 'X-API-Key')]: String(
            config.authConfig.apiKey,
          ),
        };
        // Some vendors require additional fixed headers alongside the key
        // (e.g. Copper sends X-PW-AccessToken + X-PW-Application + X-PW-UserEmail).
        const extra = config.authConfig.extraHeaders as
          | Record<string, string>
          | undefined;
        if (extra && typeof extra === 'object') {
          for (const [k, v] of Object.entries(extra)) {
            axiosConfig.headers[k] = String(v);
          }
        }
        break;
      }
      case 'BEARER_TOKEN':
        axiosConfig.headers = {
          ...axiosConfig.headers,
          Authorization: `Bearer ${config.authConfig.token}`,
        };
        break;
      case 'BASIC_AUTH':
        axiosConfig.auth = {
          username: String(config.authConfig.username),
          password: String(config.authConfig.password),
        };
        break;
      case 'OAUTH2': {
        const accessToken = await this.oauth2TokenService.getAccessToken(
          config.authConfig,
          config.connectorId,
        );
        // Some vendors use a non-standard prefix (e.g. Zoho: "Zoho-oauthtoken").
        const prefix = String(config.authConfig?.tokenPrefix ?? 'Bearer');
        axiosConfig.headers = {
          ...axiosConfig.headers,
          Authorization: `${prefix} ${accessToken}`,
        };
        // Some vendors require additional static headers alongside the
        // Bearer token (e.g. Etsy v3 requires both `Authorization: Bearer
        // <oauth-token>` AND `x-api-key: <app-key>`). Opt-in via
        // authConfig.extraHeaders — same shape as API_KEY auth.
        const extraOAuth = config.authConfig?.extraHeaders as
          | Record<string, string>
          | undefined;
        if (extraOAuth && typeof extraOAuth === 'object') {
          for (const [k, v] of Object.entries(extraOAuth)) {
            axiosConfig.headers[k] = String(v);
          }
        }
        break;
      }
      case 'QUERY_AUTH':
        // Inject authConfig values as query parameters (for APIs that auth via query string)
        axiosConfig.params = {
          ...(axiosConfig.params as Record<string, unknown> | undefined),
          ...config.authConfig,
        };
        break;
      case 'LOGIN_TOKEN': {
        const bundle = await this.loginTokenService.getToken(
          config.authConfig as unknown as LoginTokenAuthConfig,
          config.connectorId,
        );
        injectLoginTokenHeaders(
          axiosConfig,
          config.authConfig as unknown as LoginTokenAuthConfig,
          bundle.token,
          bundle.aud,
        );
        break;
      }
      case 'OAUTH1':
        // Deferred: OAuth 1.0a signs over the query/body params, which aren't
        // built yet. Handled by applyOAuth1Signature() after they are.
        break;
    }
  }

  /**
   * Apply an OAuth 1.0a (HMAC-SHA1) `Authorization` header. Called after query
   * params and the body have been built, since the signature covers them.
   *
   * authConfig fields:
   * - `consumerKey`, `consumerSecret` — required (two-legged/app-only).
   * - `token`, `tokenSecret` — optional (three-legged/user context).
   * - `realm` — optional Authorization-header realm (not signed).
   */
  private applyOAuth1Signature(
    axiosConfig: AxiosRequestConfig,
    config: { authType: string; authConfig?: Record<string, unknown> },
  ): void {
    if (config.authType !== 'OAUTH1' || !config.authConfig) return;
    const ac = config.authConfig;

    // Only fold a form-urlencoded body into the signature; JSON bodies are not
    // part of the OAuth 1.0a base string.
    let bodyParams: Record<string, unknown> | undefined;
    const contentType = String(
      (axiosConfig.headers as Record<string, unknown> | undefined)?.[
        'Content-Type'
      ] ?? '',
    );
    if (
      contentType.includes('application/x-www-form-urlencoded') &&
      typeof axiosConfig.data === 'string'
    ) {
      bodyParams = {};
      for (const [k, v] of new URLSearchParams(axiosConfig.data)) {
        bodyParams[k] = v;
      }
    }

    const header = buildOAuth1Header({
      method: String(axiosConfig.method || 'GET'),
      url: String(axiosConfig.url),
      consumerKey: String(ac.consumerKey),
      consumerSecret: String(ac.consumerSecret),
      token: ac.token ? String(ac.token) : undefined,
      tokenSecret: ac.tokenSecret ? String(ac.tokenSecret) : undefined,
      realm: ac.realm ? String(ac.realm) : undefined,
      queryParams: axiosConfig.params as Record<string, unknown> | undefined,
      bodyParams,
    });

    axiosConfig.headers = {
      ...axiosConfig.headers,
      Authorization: header,
    };
  }

  private mapParams(
    mapping: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapping)) {
      const resolved = this.resolveValue(value, params);
      if (resolved !== undefined) {
        result[key] = resolved;
      }
    }
    return result;
  }

  /**
   * Recursively resolve a value against params.
   * - String "$paramName" (whole string) → params.paramName — returns undefined if missing/empty so the key is dropped
   * - String "...${paramName}..." (embedded) → interpolated; if any placeholder is missing the whole value is dropped
   * - Arrays/objects → recurse
   * - Anything else → returned as-is
   */
  private resolveValue(
    value: unknown,
    params: Record<string, unknown>,
  ): unknown {
    if (typeof value === 'string') {
      if (value.startsWith('$') && !value.includes('${')) {
        const paramName = value.substring(1);
        const paramValue = params[paramName];
        return paramValue !== undefined && paramValue !== ''
          ? paramValue
          : undefined;
      }
      if (value.includes('${')) {
        let missing = false;
        const interpolated = value.replace(/\$\{([\w$]+)\}/g, (_, name) => {
          const pv = params[name];
          if (pv === undefined || pv === '') {
            missing = true;
            return '';
          }
          return String(pv);
        });
        return missing ? undefined : interpolated;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((v) => this.resolveValue(v, params))
        .filter((v) => v !== undefined);
    }
    if (value && typeof value === 'object') {
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const resolved = this.resolveValue(v, params);
        if (resolved !== undefined) {
          nested[k] = resolved;
        }
      }
      return nested;
    }
    return value;
  }
}

/**
 * Join a connector baseUrl and an (already path-interpolated) endpoint path
 * with exactly one slash at the seam. A baseUrl saved with a trailing slash
 * (e.g. "https://api.example.com/v3.1/") combined with a leading-slash path
 * ("/Users/me") previously produced a double slash ("…/v3.1//Users/me"),
 * which several APIs answer with 404 or 500 even on otherwise-valid requests.
 * An empty path leaves the baseUrl untouched.
 */
function joinBaseAndPath(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Emit a mapped body value as flat key/value pairs using PHP-style bracket
 * notation for nested objects and arrays, e.g.
 *   fields: { TITLE: 'x', TAGS: ['a', 'b'] }
 *     → fields[TITLE]=x, fields[TAGS][0]=a, fields[TAGS][1]=b
 *
 * The form encoders (application/x-www-form-urlencoded and multipart/form-data)
 * cannot carry a nested object directly; the previous `String(value)` coercion
 * turned objects into the literal string "[object Object]", which APIs that
 * expect bracketed params — Bitrix24 and most PHP backends — reject with a
 * "value does not match parameter" error. Primitives are emitted as-is;
 * null/undefined are skipped so absent optional fields don't send empty keys.
 */
/**
 * Yield top-level (key, value) entries for a form body, expanding a special
 * `__spread` key: its object value's own entries are hoisted to the top level
 * instead of being nested under the literal `__spread` key.
 *
 * This lets a generic, method-agnostic tool (e.g. Bitrix24's `bitrix24_call`)
 * forward an arbitrary caller-supplied params object as the request body's
 * top-level fields — `{filter:{...}, taskId:1}` becomes `filter[...]=` and
 * `taskId=1`, NOT `params[filter][...]` / `params[taskId]` which the previous
 * `{params:$params}` mapping produced and the upstream API rejected
 * ("Could not find value for parameter {fields}", "Param #0 (taskId)").
 */
function* spreadFormEntries(
  mapped: Record<string, unknown>,
): Generator<[string, unknown]> {
  for (const [k, v] of Object.entries(mapped)) {
    if (
      k === '__spread' &&
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      yield* Object.entries(v as Record<string, unknown>);
    } else {
      yield [k, v];
    }
  }
}

function appendFormParam(
  sink: (key: string, value: string) => void,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => appendFormParam(sink, `${key}[${i}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendFormParam(sink, `${key}[${k}]`, v);
    }
    return;
  }
  sink(key, String(value));
}

/**
 * Param names that, if interpolated into a JSON body, can poison the
 * Object.prototype chain after JSON.parse and let an attacker forge
 * application-level booleans (isAdmin, role, etc.).
 */
const FORBIDDEN_PARAM_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Render a JSON body template by substituting ${name} placeholders with
 * properly-encoded values:
 *   - Inside a JSON string ("...${name}..."): the value is coerced to a
 *     string and JSON-string-escaped so it cannot terminate the surrounding
 *     quotes or inject syntax.
 *   - In a free position ({"x": ${name}}): the value is JSON-encoded as a
 *     full JSON value (number/object/array/null/string).
 *
 * Forbidden param names that can pollute Object.prototype are rejected.
 */
function renderBodyTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_PARAM_KEYS.has(key)) {
      throw new Error(
        `bodyTemplate param '${key}' is not allowed (prototype pollution)`,
      );
    }
  }

  return template.replace(
    /(")?\$\{([A-Za-z_][A-Za-z0-9_]*)\}(")?/g,
    (_match, leftQuote: string | undefined, name: string, rightQuote: string | undefined) => {
      const value = params[name];
      const insideString = leftQuote && rightQuote;
      if (insideString) {
        const asString =
          value === undefined || value === null ? '' : String(value);
        const escaped = JSON.stringify(asString).slice(1, -1);
        return `${leftQuote}${escaped}${rightQuote}`;
      }
      if (value === undefined) return 'null';
      return JSON.stringify(value);
    },
  );
}

/**
 * Inject the bearer header (and any extraHeaders) for a LOGIN_TOKEN connector.
 * Both the main header and extraHeaders support `${token}` / `${aud}` placeholders.
 */
export function injectLoginTokenHeaders(
  axiosConfig: AxiosRequestConfig,
  authConfig: LoginTokenAuthConfig,
  token: string,
  aud?: string,
): void {
  const headerName = authConfig.headerName || 'Authorization';
  const headerTemplate = authConfig.headerTemplate || 'Bearer ${token}';
  const interpolate = (s: string): string =>
    s.replace(/\$\{token\}/g, token).replace(/\$\{aud\}/g, aud || '');

  axiosConfig.headers = {
    ...axiosConfig.headers,
    [headerName]: interpolate(headerTemplate),
  };
  for (const [k, v] of Object.entries(authConfig.extraHeaders || {})) {
    axiosConfig.headers[k] = interpolate(String(v));
  }
}

/**
 * Walk a parsed JSON value and reject any explicit __proto__ / constructor /
 * prototype keys. Catches injections that survived interpolation (e.g. a
 * pre-baked malicious template).
 */
function assertNoPrototypePollution(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypePollution(item);
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PARAM_KEYS.has(key)) {
      throw new Error(
        `bodyTemplate produced forbidden key '${key}' (prototype pollution)`,
      );
    }
    assertNoPrototypePollution((value as Record<string, unknown>)[key]);
  }
}
