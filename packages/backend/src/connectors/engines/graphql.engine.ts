import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * GraphqlEngine — executes GraphQL queries/mutations.
 * Supports query variables, custom headers, and auth injection.
 */
@Injectable()
export class GraphqlEngine {
  private readonly logger = new Logger(GraphqlEngine.name);

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
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

    const response = await axios.post(
      config.baseUrl,
      {
        query: endpointMapping.path, // The GraphQL query
        variables,
      },
      { headers, timeout: 30000 },
    );

    if (response.data.errors) {
      throw new Error(
        `GraphQL errors: ${JSON.stringify(response.data.errors)}`,
      );
    }

    return response.data.data;
  }
}
