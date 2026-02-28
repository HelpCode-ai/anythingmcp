import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosError, Method } from 'axios';
import FormData from 'form-data';

/**
 * RestEngine — executes HTTP calls to REST APIs.
 * Handles path parameter interpolation, query params, body mapping, and auth injection.
 * Supports OAuth2 token refresh: if a request returns 401 and a refreshToken + tokenUrl
 * are available, it will attempt to refresh the access token and retry the request once.
 */
@Injectable()
export class RestEngine {
  private readonly logger = new Logger(RestEngine.name);

  // In-memory cache for refreshed tokens (keyed by tokenUrl)
  private tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
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
    await this.injectAuth(axiosConfig, config.authType, config.authConfig);

    // Query parameters
    if (endpointMapping.queryParams) {
      axiosConfig.params = this.mapParams(
        endpointMapping.queryParams,
        params,
      );
    }

    // Request body
    if (['POST', 'PUT', 'PATCH'].includes(endpointMapping.method.toUpperCase())) {
      if (endpointMapping.bodyTemplate) {
        // Template mode: interpolate ${paramName} placeholders, then parse as JSON
        let rendered = endpointMapping.bodyTemplate;
        for (const [key, value] of Object.entries(params)) {
          const placeholder = '${' + key + '}';
          if (rendered.includes(placeholder)) {
            const replacement = typeof value === 'string' ? value : JSON.stringify(value);
            rendered = rendered.split(placeholder).join(replacement);
          }
        }
        try {
          axiosConfig.data = JSON.parse(rendered);
        } catch (e: any) {
          throw new Error(`bodyTemplate produced invalid JSON after interpolation: ${e.message}`);
        }
      } else if (endpointMapping.bodyMapping) {
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
        const newToken = await this.refreshOAuth2Token(config.authConfig);
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
    config: AxiosRequestConfig,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): Promise<void> {
    if (!authConfig) return;

    switch (authType) {
      case 'API_KEY':
        config.headers = {
          ...config.headers,
          [String(authConfig.headerName || 'X-API-Key')]: String(
            authConfig.apiKey,
          ),
        };
        break;
      case 'BEARER_TOKEN':
        config.headers = {
          ...config.headers,
          Authorization: `Bearer ${authConfig.token}`,
        };
        break;
      case 'BASIC_AUTH':
        config.auth = {
          username: String(authConfig.username),
          password: String(authConfig.password),
        };
        break;
      case 'OAUTH2': {
        let accessToken = String(authConfig.accessToken || '');

        // Check if we have a cached (refreshed) token
        const tokenUrl = String(authConfig.tokenUrl || '');
        if (tokenUrl) {
          const cached = this.tokenCache.get(tokenUrl);
          if (cached && cached.expiresAt > Date.now()) {
            accessToken = cached.accessToken;
          }
        }

        config.headers = {
          ...config.headers,
          Authorization: `Bearer ${accessToken}`,
        };
        break;
      }
    }
  }

  private async refreshOAuth2Token(
    authConfig: Record<string, unknown>,
  ): Promise<string | null> {
    const tokenUrl = String(authConfig.tokenUrl);
    const refreshToken = String(authConfig.refreshToken);
    const clientId = authConfig.clientId ? String(authConfig.clientId) : undefined;
    const clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;

    try {
      const body: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      };
      if (clientId) body.client_id = clientId;
      if (clientSecret) body.client_secret = clientSecret;

      const response = await axios.post(tokenUrl, new URLSearchParams(body).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });

      const { access_token, expires_in } = response.data;
      if (!access_token) return null;

      // Cache the new token (default 1 hour if no expires_in)
      const expiresInMs = (expires_in || 3600) * 1000;
      this.tokenCache.set(tokenUrl, {
        accessToken: access_token,
        expiresAt: Date.now() + expiresInMs - 60000, // refresh 1 min early
      });

      this.logger.debug('OAuth2: token refreshed successfully');
      return access_token;
    } catch (err: any) {
      this.logger.warn(`OAuth2 token refresh failed: ${err.message}`);
      return null;
    }
  }

  private mapParams(
    mapping: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        // Reference to a param: "$paramName" → params.paramName
        const paramName = value.substring(1);
        if (params[paramName] !== undefined) {
          result[key] = params[paramName];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
