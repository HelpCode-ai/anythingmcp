import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { OAuth2TokenService } from './oauth2-token.service';
import {
  LoginTokenService,
  LoginTokenAuthConfig,
} from './login-token.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

/**
 * GraphqlEngine — executes GraphQL queries/mutations.
 * Supports query variables, custom headers, auth injection, and OAuth2 token refresh.
 */
@Injectable()
export class GraphqlEngine {
  private readonly logger = new Logger(GraphqlEngine.name);

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
    },
    endpointMapping: {
      method: string; // "query" | "mutation" | "subscription" | "static"
      path: string; // GraphQL query string, or "$paramName" to take it from a tool param, or a literal value when method is "static"
      queryParams?: Record<string, unknown>; // variable mapping
      bodyMapping?: Record<string, unknown>;
      headers?: Record<string, string>; // dynamic header mapping
      variablesFromParam?: string; // when set, the named tool param is used as the entire GraphQL variables map
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Static short-circuit: tool returns a literal value without any HTTP call.
    // Used by the auto-injected `<slug>_graphql_schema_url` tool.
    if (endpointMapping.method === 'static') {
      return endpointMapping.path;
    }

    this.logger.debug(`GraphQL ${endpointMapping.method} → ${config.baseUrl}`);
    await assertSafeOutboundUrl(config.baseUrl);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    };

    // Apply dynamic headers from endpoint mapping (resolve $param references)
    if (endpointMapping.headers) {
      for (const [key, value] of Object.entries(endpointMapping.headers)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          const paramVal = params[value.substring(1)];
          if (paramVal !== undefined) {
            headers[key] = String(paramVal);
          }
        } else {
          headers[key] = value;
        }
      }
    }

    // Inject auth
    if (config.authConfig) {
      switch (config.authType) {
        case 'BEARER_TOKEN':
          headers['Authorization'] = `Bearer ${config.authConfig.token}`;
          break;
        case 'API_KEY':
          headers[String(config.authConfig.headerName || 'X-API-Key')] =
            String(config.authConfig.apiKey);
          break;
        case 'OAUTH2': {
          const accessToken = await this.oauth2TokenService.getAccessToken(
            config.authConfig,
            config.connectorId,
          );
          headers['Authorization'] = `Bearer ${accessToken}`;
          break;
        }
        case 'BASIC_AUTH': {
          const username = String(config.authConfig.username || '');
          const password = String(config.authConfig.password || '');
          headers['Authorization'] =
            `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
          break;
        }
        case 'LOGIN_TOKEN': {
          const auth = config.authConfig as unknown as LoginTokenAuthConfig;
          const bundle = await this.loginTokenService.getToken(
            auth,
            config.connectorId,
          );
          applyLoginTokenHeaders(headers, auth, bundle.token, bundle.aud);
          break;
        }
      }
    }

    // Resolve the GraphQL document. The adapter spec can either hardcode it
    // in `path`, or use the form `$paramName` to take it from a tool param
    // (used by the generic `_graphql_query` / `_graphql_mutation` /
    // `_graphql_subscription` builtins).
    let queryDocument = endpointMapping.path;
    if (
      typeof queryDocument === 'string' &&
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(queryDocument)
    ) {
      const name = queryDocument.substring(1);
      const v = params[name];
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error(
          `GraphQL tool requires a non-empty string param "${name}" to build the operation`,
        );
      }
      queryDocument = v;
    }

    // Variables can come from (a) a single param holding the whole map, or
    // (b) the legacy per-key `queryParams` mapping.
    let variables: Record<string, unknown> = {};
    if (endpointMapping.variablesFromParam) {
      const v = params[endpointMapping.variablesFromParam];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        variables = v as Record<string, unknown>;
      }
    } else if (endpointMapping.queryParams) {
      for (const [key, value] of Object.entries(endpointMapping.queryParams)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          variables[key] = params[value.substring(1)];
        } else {
          variables[key] = value;
        }
      }
    }

    const requestConfig = {
      query: queryDocument,
      variables,
    };

    try {
      const response = await axios.post(config.baseUrl, requestConfig, {
        headers,
        timeout: 30000,
      });

      if (response.data.errors) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(response.data.errors)}`,
        );
      }

      return response.data.data;
    } catch (error) {
      // OAuth2 auto-refresh: retry once on 401
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        config.authType === 'OAUTH2' &&
        config.authConfig?.refreshToken &&
        config.authConfig?.tokenUrl
      ) {
        this.logger.debug(
          'OAuth2: access token expired, attempting refresh...',
        );
        const newToken = await this.oauth2TokenService.refreshToken(
          config.authConfig,
          config.connectorId,
        );
        if (newToken) {
          headers['Authorization'] = `Bearer ${newToken}`;
          const retryResponse = await axios.post(
            config.baseUrl,
            requestConfig,
            { headers, timeout: 30000 },
          );

          if (retryResponse.data.errors) {
            throw new Error(
              `GraphQL errors: ${JSON.stringify(retryResponse.data.errors)}`,
            );
          }

          return retryResponse.data.data;
        }
      }
      // LOGIN_TOKEN auto-relogin on 401
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        config.authType === 'LOGIN_TOKEN' &&
        (config.authConfig as Record<string, unknown> | undefined)?.refreshOn401 !==
          false
      ) {
        this.logger.debug('LOGIN_TOKEN: 401 received, re-issuing token...');
        const auth = config.authConfig as unknown as LoginTokenAuthConfig;
        const bundle = await this.loginTokenService.forceRelogin(
          auth,
          config.connectorId,
        );
        applyLoginTokenHeaders(headers, auth, bundle.token, bundle.aud);
        const retry = await axios.post(config.baseUrl, requestConfig, {
          headers,
          timeout: 30000,
        });
        if (retry.data.errors) {
          throw new Error(
            `GraphQL errors: ${JSON.stringify(retry.data.errors)}`,
          );
        }
        return retry.data.data;
      }
      throw error;
    }
  }
}

/**
 * Apply LOGIN_TOKEN headers (main bearer + extraHeaders) into a plain headers map,
 * interpolating `${token}` and `${aud}` placeholders.
 */
export function applyLoginTokenHeaders(
  headers: Record<string, string>,
  auth: LoginTokenAuthConfig,
  token: string,
  aud?: string,
): void {
  const headerName = auth.headerName || 'Authorization';
  const headerTemplate = auth.headerTemplate || 'Bearer ${token}';
  const interpolate = (s: string): string =>
    s.replace(/\$\{token\}/g, token).replace(/\$\{aud\}/g, aud || '');
  headers[headerName] = interpolate(headerTemplate);
  for (const [k, v] of Object.entries(auth.extraHeaders || {})) {
    headers[k] = interpolate(String(v));
  }
}
