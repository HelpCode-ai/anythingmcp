import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { OAuth2TokenService } from './oauth2-token.service';

/**
 * GraphqlEngine — executes GraphQL queries/mutations.
 * Supports query variables, custom headers, auth injection, and OAuth2 token refresh.
 */
@Injectable()
export class GraphqlEngine {
  private readonly logger = new Logger(GraphqlEngine.name);

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
      method: string; // "query" or "mutation"
      path: string; // GraphQL query string
      queryParams?: Record<string, unknown>; // variable mapping
      bodyMapping?: Record<string, unknown>;
      headers?: Record<string, string>; // dynamic header mapping
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.logger.debug(`GraphQL ${endpointMapping.method} → ${config.baseUrl}`);

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
          const accessToken = this.oauth2TokenService.getAccessToken(
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
      }
    }

    // Map variables from params using queryParams mapping
    const variables: Record<string, unknown> = {};
    if (endpointMapping.queryParams) {
      for (const [key, value] of Object.entries(endpointMapping.queryParams)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          variables[key] = params[value.substring(1)];
        } else {
          variables[key] = value;
        }
      }
    }

    const requestConfig = {
      query: endpointMapping.path,
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
      throw error;
    }
  }
}
