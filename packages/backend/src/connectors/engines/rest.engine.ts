import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosError, Method } from 'axios';
import FormData from 'form-data';
import { OAuth2TokenService } from './oauth2-token.service';

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
        const paramValue = params[paramName];
        if (paramValue !== undefined && paramValue !== '') {
          result[key] = paramValue;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
