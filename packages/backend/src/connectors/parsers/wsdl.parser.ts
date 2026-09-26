import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import * as soap from 'soap';

@Injectable()
export class WsdlParser {
  private readonly logger = new Logger(WsdlParser.name);

  async parse(wsdlUrl: string): Promise<ParsedTool[]> {
    this.logger.debug(`Parsing WSDL from: ${wsdlUrl}`);

    const client = await soap.createClientAsync(wsdlUrl);
    const description = client.describe();
    const wsdl = client.wsdl;
    const tools: ParsedTool[] = [];

    // Extract targetNamespace from WSDL
    const targetNamespace =
      (wsdl.definitions as any)?.$?.targetNamespace ||
      (wsdl as any).xml?.match(/targetNamespace="([^"]+)"/)?.[1];

    // Build a map of SOAPAction and endpoint per port/operation
    const bindings = wsdl.definitions?.bindings || {};
    const services = wsdl.definitions?.services || {};

    // Map portName → endpoint address
    const portEndpoints: Record<string, string> = {};
    for (const service of Object.values(services) as any[]) {
      for (const [portName, portDef] of Object.entries(
        (service.ports || {}) as Record<string, any>,
      )) {
        if (portDef.location) {
          portEndpoints[portName] = portDef.location;
        }
      }
    }

    // Map bindingName → { operationName → soapAction }
    // and bindingName → { operationName → inputElementName }
    const bindingSoapActions: Record<string, Record<string, string>> = {};
    const bindingInputElements: Record<string, Record<string, string>> = {};
    for (const [bindingName, binding] of Object.entries(bindings) as any[]) {
      const methods = binding.methods || {};
      bindingSoapActions[bindingName] = {};
      bindingInputElements[bindingName] = {};
      for (const [opName, opDef] of Object.entries(methods) as any[]) {
        if (opDef.soapAction) {
          bindingSoapActions[bindingName][opName] = opDef.soapAction;
        }
        const inputName =
          opDef.input?.$name ||
          opDef.input?.name ||
          opDef.input?.parts?.[Object.keys(opDef.input?.parts || {})[0]]?.element?.$name ||
          opDef.input?.parts?.[Object.keys(opDef.input?.parts || {})[0]]?.$element;
        if (inputName) {
          const stripped = inputName.includes(':') ? inputName.split(':').pop() : inputName;
          if (stripped) {
            bindingInputElements[bindingName][opName] = stripped;
          }
        }
      }
    }

    for (const [serviceName, service] of Object.entries(description)) {
      for (const [portName, port] of Object.entries(service as any)) {
        for (const [operationName, operation] of Object.entries(port as any)) {
          const soapAction =
            bindingSoapActions[portName]?.[operationName] || '';
          const endpoint = portEndpoints[portName] || '';
          const inputElement =
            bindingInputElements[portName]?.[operationName];

          const tool = this.operationToTool(
            serviceName,
            portName,
            operationName,
            operation as any,
            soapAction,
            endpoint,
            targetNamespace,
            inputElement,
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
    soapAction: string,
    endpoint: string,
    targetNamespace?: string,
    inputElement?: string,
  ): ParsedTool {
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