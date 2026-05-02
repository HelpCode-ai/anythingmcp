import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as soap from 'soap';
import { XMLParser } from 'fast-xml-parser';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

/**
 * SoapEngine — executes SOAP calls using raw HTTP via axios.
 *
 * The node `soap` library is only used for WSDL parsing (to extract metadata
 * like SOAPAction, endpoint, and namespace). The actual HTTP call is made
 * with axios to avoid the library's tendency to generate bloated envelopes
 * and hang on certain WCF services.
 */
@Injectable()
export class SoapEngine {
  private readonly logger = new Logger(SoapEngine.name);

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
      specUrl?: string;
    },
    endpointMapping: {
      method: string; // SOAP operation name
      path: string; // port name
      queryParams?: Record<string, unknown>;
      bodyMapping?: Record<string, unknown>;
      paramOrder?: string[]; // WSDL-defined parameter order (WCF is order-sensitive)
      headers?: Record<string, string>;
      soapAction?: string;
      endpoint?: string;
      targetNamespace?: string;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const operationName = endpointMapping.method;

    // Resolve SOAP metadata — prefer stored values, fall back to WSDL parsing
    let soapAction = endpointMapping.soapAction || '';
    let endpoint = endpointMapping.endpoint || '';
    let targetNamespace = endpointMapping.targetNamespace || '';
    let paramOrder = endpointMapping.paramOrder || [];

    if (!soapAction || !endpoint || !targetNamespace || paramOrder.length === 0) {
      const wsdlUrl = config.specUrl || config.baseUrl;
      this.logger.debug(`Fetching WSDL metadata from: ${wsdlUrl}`);
      const meta = await this.extractWsdlMetadata(
        wsdlUrl,
        endpointMapping.path,
        operationName,
      );
      if (!soapAction) soapAction = meta.soapAction;
      if (!endpoint) endpoint = meta.endpoint;
      if (!targetNamespace) targetNamespace = meta.targetNamespace;
      if (paramOrder.length === 0) paramOrder = meta.paramOrder;
    }

    // Use connector baseUrl as endpoint fallback (for internal vs external IPs)
    if (!endpoint) {
      endpoint = config.baseUrl;
    }

    // Override the WSDL endpoint's host with the connector's baseUrl host.
    // WSDLs often advertise external IPs that aren't reachable from internal networks.
    endpoint = this.overrideEndpointHost(endpoint, config.baseUrl);

    this.logger.debug(
      `SOAP call: ${operationName} → ${endpoint} (SOAPAction: ${soapAction})`,
    );

    // Map parameters
    const soapParams = this.mapParams(endpointMapping.bodyMapping, params);

    // Build the SOAP envelope (respecting WSDL parameter order for WCF)
    const envelope = this.buildEnvelope(
      operationName,
      targetNamespace,
      soapParams,
      paramOrder,
    );

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'text/xml; charset=utf-8',
      ...(soapAction ? { SOAPAction: soapAction } : {}),
      ...config.headers,
    };

    // Inject authentication
    this.injectAuth(headers, config.authType, config.authConfig);

    // Resolve dynamic headers from endpoint mapping
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

    try {
      await assertSafeOutboundUrl(endpoint);
      const response = await axios.post(endpoint, envelope, {
        headers,
        timeout: 30000,
        // SOAP responses may have non-2xx status (SOAP faults return 500)
        validateStatus: (status) => status < 600,
      });

      // Parse the SOAP response
      if (response.status >= 400) {
        const detail: Record<string, unknown> = {
          error: `SOAP call failed with HTTP ${response.status}`,
          status: response.status,
          statusText: response.statusText,
          endpoint,
          responseBody: response.data,
          requestBody: envelope,
        };
        const enrichedError = new Error(String(detail.error));
        (enrichedError as any).soapDetail = detail;
        throw enrichedError;
      }

      return this.parseResponse(response.data);
    } catch (err: any) {
      // Re-throw enriched errors
      if (err.soapDetail) throw err;

      // Axios network errors
      const detail: Record<string, unknown> = {
        error: err.message,
        endpoint,
        requestBody: envelope,
      };
      if (err.code) detail.code = err.code;
      if (err.response?.data) detail.responseBody = err.response.data;
      if (err.response?.status) detail.status = err.response.status;

      const enrichedError = new Error(err.message);
      (enrichedError as any).soapDetail = detail;
      throw enrichedError;
    }
  }

  /**
   * Build a SOAP 1.1 envelope with the given operation and parameters.
   * WCF services require parameters in WSDL-defined order.
   */
  private buildEnvelope(
    operationName: string,
    targetNamespace: string,
    params: Record<string, unknown>,
    paramOrder: string[] = [],
  ): string {
    const ns = targetNamespace || 'http://tempuri.org/';

    // Use paramOrder if available, otherwise fall back to object key order
    const orderedKeys =
      paramOrder.length > 0
        ? paramOrder.filter((k) => params[k] !== undefined)
        : Object.keys(params);

    const paramXml = orderedKeys
      .map((key) => `      <tns:${key}>${this.escapeXml(String(params[key]))}</tns:${key}>`)
      .join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${operationName}>
${paramXml}
    </tns:${operationName}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Parse the SOAP response XML, extracting the body content.
   */
  private parseResponse(data: unknown): unknown {
    if (typeof data !== 'string') return data;

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
      });
      const parsed = parser.parse(data);

      // Navigate: Envelope → Body → first child (operation result)
      const envelope = parsed.Envelope || parsed['soap:Envelope'] || parsed;
      const body = envelope.Body || envelope['soap:Body'];
      if (!body) return parsed;

      // Check for SOAP fault
      if (body.Fault || body['soap:Fault']) {
        const fault = body.Fault || body['soap:Fault'];
        throw new Error(
          `SOAP Fault: ${fault.faultstring || fault.Reason || JSON.stringify(fault)}`,
        );
      }

      // Return the first child of Body (the operation response)
      const keys = Object.keys(body);
      if (keys.length === 1) return body[keys[0]];
      return body;
    } catch (err: any) {
      if (err.message?.startsWith('SOAP Fault:')) throw err;
      // If XML parsing fails, return raw data
      return data;
    }
  }

  /**
   * Extract SOAP metadata from WSDL using the soap library (parsing only).
   */
  private async extractWsdlMetadata(
    wsdlUrl: string,
    portName: string,
    operationName: string,
  ): Promise<{
    soapAction: string;
    endpoint: string;
    targetNamespace: string;
    paramOrder: string[];
  }> {
    try {
      await assertSafeOutboundUrl(wsdlUrl);
      const client = await soap.createClientAsync(wsdlUrl);
      const wsdl = client.wsdl;

      const targetNamespace =
        (wsdl.definitions as any)?.$?.targetNamespace ||
        (wsdl as any).xml?.match(/targetNamespace="([^"]+)"/)?.[1] ||
        '';

      let soapAction = '';
      const bindings = wsdl.definitions?.bindings || {};
      const binding = bindings[portName];
      if (binding?.methods?.[operationName]?.soapAction) {
        soapAction = binding.methods[operationName].soapAction;
      }

      let endpoint = '';
      const services = wsdl.definitions?.services || {};
      for (const service of Object.values(services) as any[]) {
        const port = service.ports?.[portName];
        if (port?.location) {
          endpoint = port.location;
          break;
        }
      }

      // Extract parameter order from WSDL description
      const paramOrder: string[] = [];
      const description = client.describe();
      for (const svc of Object.values(description)) {
        const port = (svc as any)[portName];
        if (port?.[operationName]?.input) {
          paramOrder.push(...Object.keys(port[operationName].input));
          break;
        }
      }

      return { soapAction, endpoint, targetNamespace, paramOrder };
    } catch (err: any) {
      this.logger.warn(`Failed to extract WSDL metadata: ${err.message}`);
      return { soapAction: '', endpoint: '', targetNamespace: '', paramOrder: [] };
    }
  }

  private injectAuth(
    headers: Record<string, string>,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): void {
    if (!authConfig) return;

    switch (authType) {
      case 'BASIC_AUTH': {
        const credentials = Buffer.from(
          `${authConfig.username}:${authConfig.password}`,
        ).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
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

  /**
   * Replace the host (scheme + hostname + port) of the WSDL endpoint
   * with the host from the connector's baseUrl. This handles the common
   * case where the WSDL advertises an external/public IP but the service
   * must be reached via an internal IP.
   */
  private overrideEndpointHost(
    wsdlEndpoint: string,
    connectorBaseUrl: string,
  ): string {
    try {
      // Strip query strings (e.g. ?singleWsdl) from baseUrl
      const baseClean = connectorBaseUrl.split('?')[0];
      const base = new URL(baseClean);
      const ep = new URL(wsdlEndpoint);

      // If hosts already match, no override needed
      if (ep.host === base.host) return wsdlEndpoint;

      this.logger.debug(
        `Overriding WSDL endpoint host: ${ep.host} → ${base.host}`,
      );
      ep.protocol = base.protocol;
      ep.hostname = base.hostname;
      ep.port = base.port;
      return ep.toString();
    } catch {
      // If URL parsing fails, return as-is
      return wsdlEndpoint;
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
