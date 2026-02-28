import { Injectable, Logger } from '@nestjs/common';
import * as soap from 'soap';

@Injectable()
export class SoapEngine {
  private readonly logger = new Logger(SoapEngine.name);

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
    endpointMapping: {
      method: string; // SOAP operation name
      path: string; // WSDL URL or port name
      queryParams?: Record<string, unknown>;
      bodyMapping?: Record<string, unknown>;
      headers?: Record<string, string>; // dynamic header mapping
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.logger.debug(
      `SOAP call: ${endpointMapping.method} → ${config.baseUrl}`,
    );

    const client = await soap.createClientAsync(config.baseUrl);

    // Inject authentication
    this.injectAuth(client, config.authType, config.authConfig);

    // Add custom headers from connector config
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        client.addHttpHeader(key, value);
      }
    }

    // Add dynamic headers from endpoint mapping (resolve $param references)
    if (endpointMapping.headers) {
      for (const [key, value] of Object.entries(endpointMapping.headers)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          const paramVal = params[value.substring(1)];
          if (paramVal !== undefined) {
            client.addHttpHeader(key, String(paramVal));
          }
        } else {
          client.addHttpHeader(key, value);
        }
      }
    }

    // Map parameters using bodyMapping
    const soapParams = this.mapParams(endpointMapping.bodyMapping, params);

    const methodName = endpointMapping.method;
    const asyncMethod = `${methodName}Async`;

    if (typeof client[asyncMethod] !== 'function') {
      throw new Error(`SOAP operation '${methodName}' not found on service`);
    }

    const [result] = await client[asyncMethod](soapParams);
    return result;
  }

  private injectAuth(
    client: any,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): void {
    if (!authConfig) return;

    switch (authType) {
      case 'BASIC_AUTH':
        client.setSecurity(
          new soap.BasicAuthSecurity(
            String(authConfig.username),
            String(authConfig.password),
          ),
        );
        break;
      case 'WS_SECURITY':
        client.setSecurity(
          new soap.WSSecurity(
            String(authConfig.username),
            String(authConfig.password),
          ),
        );
        break;
      case 'BEARER_TOKEN':
        client.addHttpHeader(
          'Authorization',
          `Bearer ${authConfig.token}`,
        );
        break;
    }
  }

  private mapParams(
    bodyMapping: Record<string, unknown> | undefined,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!bodyMapping) return params;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bodyMapping)) {
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
