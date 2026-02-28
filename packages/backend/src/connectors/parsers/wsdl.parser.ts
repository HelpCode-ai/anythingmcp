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
    const tools: ParsedTool[] = [];

    for (const [serviceName, service] of Object.entries(description)) {
      for (const [portName, port] of Object.entries(service as any)) {
        for (const [operationName, operation] of Object.entries(port as any)) {
          const tool = this.operationToTool(
            serviceName,
            portName,
            operationName,
            operation as any,
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
  ): ParsedTool {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const bodyMapping: Record<string, string> = {};

    if (operation.input) {
      for (const [paramName, paramType] of Object.entries(operation.input)) {
        const jsonType = this.soapTypeToJsonType(paramType as string);
        properties[paramName] = {
          type: jsonType,
          description: `SOAP parameter: ${paramName} (${paramType})`,
        };
        bodyMapping[paramName] = `$${paramName}`;
        required.push(paramName);
      }
    }

    const name = `${serviceName}_${operationName}`
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();

    return {
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
      },
    };
  }

  private soapTypeToJsonType(soapType: string): string {
    const typeStr = String(soapType).toLowerCase();
    if (typeStr.includes('int') || typeStr.includes('long') || typeStr.includes('float') || typeStr.includes('double') || typeStr.includes('decimal')) {
      return 'number';
    }
    if (typeStr.includes('bool')) return 'boolean';
    return 'string';
  }
}
