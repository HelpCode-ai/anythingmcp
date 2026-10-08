import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import * as soap from 'soap';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { outboundAxios } from '../../common/outbound-http';

/** What a SOAP call to one operation needs from the parsed WSDL. */
export interface WsdlOperationInfo {
  soapAction: string;
  endpoint: string;
  /**
   * Document style only: the element that wraps the parameters in the body,
   * taken from the operation's input message part. WCF and JAX-WS name it
   * after the operation, but a WSDL may declare any element
   * (`GetItemRequest` for operation `GetItem`).
   */
  inputElement?: string;
  /** Namespace of `inputElement` (its schema's targetNamespace). */
  inputNamespace?: string;
}

/** The targetNamespace of the WSDL definitions element. */
export function wsdlTargetNamespace(wsdl: any): string {
  return (
    wsdl?.definitions?.$targetNamespace ||
    wsdl?.definitions?.$?.targetNamespace ||
    wsdl?.xml?.match(/targetNamespace="([^"]+)"/)?.[1] ||
    ''
  );
}

/**
 * Find an operation of a port in a WSDL parsed by the `soap` library.
 *
 * The port is followed to its binding: bindings are keyed by their own name,
 * which only matches the port name in WCF WSDLs (`BasicHttpBinding_IService`
 * for both); JAX-WS names them `ItemPort` and `ItemBinding`.
 */
export function resolveWsdlOperation(
  wsdl: any,
  portName: string,
  operationName: string,
): WsdlOperationInfo {
  const definitions = wsdl?.definitions;
  let endpoint = '';
  let method: any;
  for (const service of Object.values(definitions?.services || {}) as any[]) {
    const port = service?.ports?.[portName];
    if (!port) continue;
    endpoint = port.location || '';
    method = port.binding?.methods?.[operationName];
    break;
  }
  method ??= definitions?.bindings?.[portName]?.methods?.[operationName];

  const info: WsdlOperationInfo = {
    soapAction: method?.soapAction || '',
    endpoint,
  };
  // Document style with an element part: the soap library resolves the
  // input to that schema element. RPC style keeps the message and its typed
  // parts, and the body wrapper stays the operation name.
  const input = method?.input;
  if (
    method?.style !== 'rpc' &&
    input?.name === 'element' &&
    typeof input.$name === 'string' &&
    input.$name
  ) {
    info.inputElement = input.$name;
    if (typeof input.targetNamespace === 'string' && input.targetNamespace) {
      info.inputNamespace = input.targetNamespace;
    }
  }
  return info;
}

@Injectable()
export class WsdlParser {
  private readonly logger = new Logger(WsdlParser.name);

  async parse(wsdlUrl: string): Promise<ParsedTool[]> {
    this.logger.debug(`Parsing WSDL from: ${wsdlUrl}`);

    // The URL comes from the user: check it, and keep checking WSDL/XSD
    // imports and redirects through the guarded client.
    await assertSafeOutboundUrl(wsdlUrl);
    const client = await soap.createClientAsync(wsdlUrl, {
      request: outboundAxios() as any,
    });
    const description = client.describe();
    const wsdl = client.wsdl;
    const tools: ParsedTool[] = [];

    const targetNamespace = wsdlTargetNamespace(wsdl) || undefined;

    for (const [serviceName, service] of Object.entries(description)) {
      for (const [portName, port] of Object.entries(service as any)) {
        for (const [operationName, operation] of Object.entries(port as any)) {
          const info = resolveWsdlOperation(wsdl, portName, operationName);

          const tool = this.operationToTool(
            serviceName,
            portName,
            operationName,
            operation as any,
            info,
            targetNamespace,
          );
          tools.push(tool);
        }
      }
    }

    this.logger.log(`Extracted ${tools.length} tools from WSDL`);
    return tools;
  }

  private operationToTool(
    serviceName: string,
    portName: string,
    operationName: string,
    operation: any,
    info: WsdlOperationInfo,
    targetNamespace?: string,
  ): ParsedTool {
    const { soapAction, endpoint } = info;
    // Stored only where they differ from what the engine assumes (the
    // operation name, the WSDL targetNamespace), so the usual WCF/JAX-WS tool
    // stays as small as before.
    const inputElement =
      info.inputElement && info.inputElement !== operationName
        ? info.inputElement
        : undefined;
    const inputNamespace =
      info.inputNamespace && info.inputNamespace !== targetNamespace
        ? info.inputNamespace
        : undefined;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const bodyMapping: Record<string, string> = {};
    const paramOrder: string[] = [];

    if (operation.input) {
      for (const [paramName, paramType] of Object.entries(operation.input)) {
        const jsonType = this.soapTypeToJsonType(paramType as string);
        properties[paramName] = {
          type: jsonType,
          description: `SOAP parameter: ${paramName} (${paramType})`,
        };
        bodyMapping[paramName] = `$${paramName}`;
        required.push(paramName);
        paramOrder.push(paramName);
      }
    }

    const name = `${serviceName}_${operationName}`
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();

    const tool: ParsedTool = {
      name,
      description: `SOAP operation: ${operationName} on ${serviceName}/${portName}`,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      endpointMapping: {
        method: operationName,
        path: portName,
        ...(Object.keys(bodyMapping).length > 0 ? { bodyMapping } : {}),
        ...(paramOrder.length > 0 ? { paramOrder } : {}),
        ...(soapAction ? { soapAction } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        ...(inputElement ? { inputElement } : {}),
        ...(inputNamespace ? { inputNamespace } : {}),
      },
    };

    const outputSchema = this.soapShapeToJsonSchema(operation.output, 0);
    if (outputSchema?.type === 'object' && outputSchema.properties &&
        Object.keys(outputSchema.properties as object).length) {
      tool.outputSchema = outputSchema;
    }
    return tool;
  }

  /**
   * Convert a soap `describe()` output shape into a JSON Schema. The library
   * represents complex types as nested objects (field → type-string or nested
   * object); scalars are type strings.
   */
  private soapShapeToJsonSchema(
    node: any,
    depth: number,
  ): Record<string, unknown> | undefined {
    if (node == null || depth > 6) return undefined;
    if (typeof node === 'string') {
      return { type: this.soapTypeToJsonType(node) };
    }
    if (typeof node !== 'object') return undefined;

    const properties: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'targetNSAlias' || key === 'targetNamespace') continue;
      if (count++ >= 200) break;
      properties[key] = this.soapShapeToJsonSchema(value, depth + 1) ?? {
        type: 'string',
      };
    }
    return { type: 'object', properties, additionalProperties: true };
  }

  private soapTypeToJsonType(soapType: string): string {
    const typeStr = String(soapType).toLowerCase();
    if (
      typeStr.includes('int') ||
      typeStr.includes('long') ||
      typeStr.includes('float') ||
      typeStr.includes('double') ||
      typeStr.includes('decimal')
    ) {
      return 'number';
    }
    if (typeStr.includes('bool')) return 'boolean';
    return 'string';
  }
}
