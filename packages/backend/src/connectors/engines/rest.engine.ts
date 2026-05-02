import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosError, Method } from 'axios';
import FormData from 'form-data';
import { OAuth2TokenService } from './oauth2-token.service';
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

  constructor(private readonly oauth2TokenService: OAuth2TokenService) {}

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
      connectorId?: string;
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

    const url = `${config.baseUrl}${path}`;
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
      axiosConfig.params = {
        ...(axiosConfig.params as Record<string, unknown> | undefined),
        ...this.mapParams(endpointMapping.queryParams, params),
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
            for (const [k, v] of Object.entries(mapped)) {
              urlParams.append(k, String(v));
            }
            axiosConfig.data = urlParams.toString();
            axiosConfig.headers = {
              ...axiosConfig.headers,
              'Content-Type': 'application/x-www-form-urlencoded',
            };
          } else if (encoding === 'form-data') {
            const form = new FormData();
            for (const [k, v] of Object.entries(mapped)) {
              form.append(k, String(v));
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

    this.logger.debug(`REST call: ${axiosConfig.method} ${url}`);

    try {
      const response = await axios(axiosConfig);
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
      throw error;
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
      case 'API_KEY':
        axiosConfig.headers = {
          ...axiosConfig.headers,
          [String(config.authConfig.headerName || 'X-API-Key')]: String(
            config.authConfig.apiKey,
          ),
        };
        break;
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
        axiosConfig.headers = {
          ...axiosConfig.headers,
          Authorization: `Bearer ${accessToken}`,
        };
        break;
      }
      case 'QUERY_AUTH':
        // Inject authConfig values as query parameters (for APIs that auth via query string)
        axiosConfig.params = {
          ...(axiosConfig.params as Record<string, unknown> | undefined),
          ...config.authConfig,
        };
        break;
    }
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
