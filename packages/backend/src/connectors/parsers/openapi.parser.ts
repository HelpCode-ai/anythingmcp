import { Injectable, Logger } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SwaggerParser = require('swagger-parser');
import axios from 'axios';

export interface ParsedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: {
    type: string;
    fields?: string[];
  };
}

@Injectable()
export class OpenApiParser {
  private readonly logger = new Logger(OpenApiParser.name);

  async parse(spec: string | Record<string, unknown>): Promise<ParsedTool[]> {
    this.logger.debug('Parsing OpenAPI specification...');

    const rawSpec = typeof spec === 'string' ? JSON.parse(spec) : spec;
    const api = (await SwaggerParser.validate(rawSpec as any)) as any;

    return this.extractTools(api);
  }

  async parseFromUrl(url: string): Promise<ParsedTool[]> {
    this.logger.debug(`Fetching OpenAPI spec from: ${url}`);

    const response = await axios.get(url, { timeout: 15000 });
    return this.parse(response.data);
  }

  private extractTools(api: any): ParsedTool[] {
    const tools: ParsedTool[] = [];
    const paths = api.paths || {};

    for (const [path, pathItem] of Object.entries(paths)) {
      const methods = ['get', 'post', 'put', 'patch', 'delete'];
      for (const method of methods) {
        const operation = (pathItem as any)[method];
        if (!operation) continue;

        const tool = this.operationToTool(method, path, operation, api);
        if (tool) tools.push(tool);
      }
    }

    this.logger.log(`Extracted ${tools.length} tools from OpenAPI spec`);
    return tools;
  }

  private operationToTool(
    method: string,
    path: string,
    operation: any,
    api: any,
  ): ParsedTool | null {
    const name = this.generateToolName(method, path, operation);
    const description = this.generateDescription(operation);

    const properties: Record<string, any> = {};
    const required: string[] = [];
    const queryParams: Record<string, string> = {};
    const bodyMapping: Record<string, string> = {};

    // Path parameters
    const pathParams = (operation.parameters || []).filter(
      (p: any) => p.in === 'path',
    );
    for (const param of pathParams) {
      properties[param.name] = this.paramToJsonSchema(param);
      required.push(param.name);
    }

    // Query parameters
    const queryParamsDef = (operation.parameters || []).filter(
      (p: any) => p.in === 'query',
    );
    for (const param of queryParamsDef) {
      properties[param.name] = this.paramToJsonSchema(param);
      if (param.required) required.push(param.name);
      queryParams[param.name] = `$${param.name}`;
    }

    // Header parameters (non-auth)
    const headerParams = (operation.parameters || []).filter(
      (p: any) =>
        p.in === 'header' &&
        !['authorization', 'content-type'].includes(p.name.toLowerCase()),
    );
    for (const param of headerParams) {
      properties[param.name] = this.paramToJsonSchema(param);
      if (param.required) required.push(param.name);
    }

    // Request body
    const requestBody = operation.requestBody;
    if (requestBody) {
      const content = requestBody.content;
      const jsonContent =
        content?.['application/json'] ||
        content?.['application/x-www-form-urlencoded'];
      if (jsonContent?.schema) {
        const bodyProps = this.flattenSchema(jsonContent.schema, api);
        for (const [propName, propSchema] of Object.entries(bodyProps)) {
          properties[propName] = propSchema;
          bodyMapping[propName] = `$${propName}`;
        }
        const bodyRequired = jsonContent.schema.required || [];
        for (const r of bodyRequired) {
          if (!required.includes(r)) required.push(r);
        }
      }
    }

    const parameters: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) {
      parameters.required = required;
    }

    const endpointMapping: ParsedTool['endpointMapping'] = {
      method: method.toUpperCase(),
      path,
    };
    if (Object.keys(queryParams).length > 0) {
      endpointMapping.queryParams = queryParams;
    }
    if (Object.keys(bodyMapping).length > 0) {
      endpointMapping.bodyMapping = bodyMapping;
    }

    return { name, description, parameters, endpointMapping };
  }

  private generateToolName(
    method: string,
    path: string,
    operation: any,
  ): string {
    if (operation.operationId) {
      return operation.operationId
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase();
    }

    const cleanPath = path
      .replace(/\{[^}]+\}/g, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    return `${method}_${cleanPath}`.toLowerCase();
  }

  private generateDescription(operation: any): string {
    const parts: string[] = [];
    if (operation.summary) parts.push(operation.summary);
    if (operation.description && operation.description !== operation.summary) {
      parts.push(operation.description);
    }
    return parts.join('. ') || 'No description available';
  }

  private paramToJsonSchema(param: any): Record<string, unknown> {
    const schema: Record<string, unknown> = {};

    if (param.schema) {
      schema.type = param.schema.type || 'string';
      if (param.schema.enum) schema.enum = param.schema.enum;
      if (param.schema.default !== undefined)
        schema.default = param.schema.default;
      if (param.schema.format) schema.format = param.schema.format;
    } else {
      schema.type = param.type || 'string';
    }

    if (param.description) schema.description = param.description;

    return schema;
  }

  private flattenSchema(
    schema: any,
    api: any,
  ): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};

    if (schema.$ref) {
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved = api;
      for (const segment of refPath) {
        resolved = resolved?.[segment];
      }
      if (resolved) {
        return this.flattenSchema(resolved, api);
      }
      return result;
    }

    const properties = schema.properties || {};
    for (const [name, propSchema] of Object.entries(properties)) {
      const prop = propSchema as any;
      const entry: Record<string, unknown> = { type: prop.type || 'string' };
      if (prop.description) entry.description = prop.description;
      if (prop.enum) entry.enum = prop.enum;
      if (prop.format) entry.format = prop.format;
      if (prop.default !== undefined) entry.default = prop.default;
      result[name] = entry;
    }

    return result;
  }
}
