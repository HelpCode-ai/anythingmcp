import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac } from 'crypto';

@Injectable()
export class WebhookEngine {
  private readonly logger = new Logger(WebhookEngine.name);

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
      headers?: Record<string, string>;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.logger.debug(`Webhook call → ${config.baseUrl}${endpointMapping.path}`);

    const url = `${config.baseUrl}${endpointMapping.path}`;

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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
      ...resolvedEndpointHeaders,
    };

    const body = endpointMapping.bodyMapping
      ? this.mapParams(endpointMapping.bodyMapping, params)
      : params;

    // Inject authentication
    this.injectAuth(headers, body, config.authType, config.authConfig);

    const response = await axios({
      method: (endpointMapping.method || 'POST').toUpperCase() as any,
      url,
      headers,
      data: body,
      timeout: 30000,
    });

    return response.data;
  }

  private injectAuth(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): void {
    if (!authConfig) return;

    switch (authType) {
      case 'HMAC': {
        const secret = String(authConfig.secret);
        const algorithm = String(authConfig.algorithm || 'sha256');
        const headerName = String(authConfig.headerName || 'X-Webhook-Signature');
        const payload = JSON.stringify(body);
        const signature = createHmac(algorithm, secret)
          .update(payload)
          .digest('hex');
        headers[headerName] = signature;
        break;
      }
      case 'BEARER_TOKEN':
        headers['Authorization'] = `Bearer ${authConfig.token}`;
        break;
      case 'API_KEY':
        headers[String(authConfig.headerName || 'X-API-Key')] = String(
          authConfig.apiKey,
        );
        break;
    }
  }

  private mapParams(
    mapping: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string' && value.startsWith('$')) {
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
