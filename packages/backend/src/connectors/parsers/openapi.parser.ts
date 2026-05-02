import { Injectable, Logger } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SwaggerParser = require('swagger-parser');
import axios from 'axios';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

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

    await assertSafeOutboundUrl(url);
    const response = await axios.get(url, { timeout: 15000 });

    // If the response is already a valid spec object, parse directly
    if (typeof response.data === 'object' && response.data !== null) {
      return this.parse(response.data);
    }

    const text = typeof response.data === 'string' ? response.data : '';

    // If it looks like JSON or YAML, try parsing directly
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('openapi') || trimmed.startsWith('swagger')) {
      return this.parse(text);
    }

    // Response is likely HTML (Swagger UI page) — try to resolve the actual spec
    if (text.includes('<html') || text.includes('swagger-ui') || text.includes('<!DOCTYPE')) {
      this.logger.debug('Detected Swagger UI HTML page, attempting to resolve spec URL...');
      const spec = await this.resolveSpecFromSwaggerUi(url, text);
      if (spec) {
        return this.parse(spec);
      }
    }

    // Fallback: try parsing as-is (will throw a descriptive error)
    return this.parse(response.data);
  }

  /**
   * When a user provides a Swagger UI page URL instead of the raw spec URL,
   * attempt to find and fetch the actual OpenAPI spec by:
   *   1. Extracting the spec URL from the HTML (e.g. SwaggerUIBundle({ url: "..." }))
   *   2. Fetching swagger-ui-init.js for embedded specs (swagger-ui-express / NestJS)
   *   3. Trying common spec endpoint paths relative to the base URL
   */
  private async resolveSpecFromSwaggerUi(
    pageUrl: string,
    html: string,
  ): Promise<Record<string, unknown> | string | null> {
    const base = new URL(pageUrl);

    // 1. Try to extract a spec URL from the HTML (SwaggerUIBundle({ url: "..." }))
    const urlMatch = html.match(
      /SwaggerUIBundle\s*\(\s*\{[^}]*url\s*:\s*["']([^"']+)["']/s,
    );
    if (urlMatch?.[1]) {
      const specUrl = new URL(urlMatch[1], pageUrl).href;
      this.logger.debug(`Found spec URL in HTML: ${specUrl}`);
      try {
        await assertSafeOutboundUrl(specUrl);
        const specResp = await axios.get(specUrl, { timeout: 15000 });
        return specResp.data;
      } catch {
        this.logger.debug(`Failed to fetch spec from extracted URL: ${specUrl}`);
      }
    }

    // 2. Try swagger-ui-init.js (swagger-ui-express embeds the spec inline)
    const initJsUrl = new URL('swagger-ui-init.js', pageUrl.endsWith('/') ? pageUrl : pageUrl + '/').href;
    try {
      await assertSafeOutboundUrl(initJsUrl);
      const initResp = await axios.get(initJsUrl, { timeout: 15000 });
      const initJs = typeof initResp.data === 'string' ? initResp.data : '';
      // The spec is embedded as: let defined = { ... "swaggerDoc": { <the spec> }, ... }
      const docMatch = initJs.match(/"swaggerDoc"\s*:\s*(\{[\s\S]+\})\s*,\s*"customOptions"/);
      if (docMatch?.[1]) {
        this.logger.debug('Extracted embedded spec from swagger-ui-init.js');
        return JSON.parse(docMatch[1]);
      }
      // Alternative pattern: spec property in options
      const specMatch = initJs.match(/"spec"\s*:\s*(\{[\s\S]+\})\s*,\s*"customOptions"/);
      if (specMatch?.[1]) {
        this.logger.debug('Extracted embedded spec from swagger-ui-init.js (spec field)');
        return JSON.parse(specMatch[1]);
      }
    } catch {
      this.logger.debug('No swagger-ui-init.js found');
    }

    // 3. Try common spec endpoint paths
    const origin = base.origin;
    const commonPaths = [
      '/openapi.json',
      '/swagger.json',
      '/api-docs',
      '/docs-json',
      '/docs-yaml',
      '/api/swagger.json',
      '/v1/openapi.json',
      '/v2/openapi.json',
      '/v3/openapi.json',
      '/docs/openapi.json',
      '/swagger/v1/swagger.json',
      '/api-docs.json',
    ];
    for (const path of commonPaths) {
      try {
        const candidate = `${origin}${path}`;
        await assertSafeOutboundUrl(candidate);
        const resp = await axios.get(candidate, { timeout: 5000 });
        if (
          typeof resp.data === 'object' &&
          resp.data !== null &&
          (resp.data.openapi || resp.data.swagger)
        ) {
          this.logger.debug(`Found spec at common path: ${origin}${path}`);
          return resp.data;
        }
      } catch {
        // continue to next path
      }
    }

    this.logger.warn(
      'Could not resolve OpenAPI spec from Swagger UI page. ' +
        'Please provide the direct URL to the JSON/YAML spec instead of the Swagger UI page.',
    );
    return null;
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
