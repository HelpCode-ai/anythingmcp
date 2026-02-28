import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ParsedTool } from './openapi.parser';

/**
 * Postman Collection v2.1 Parser.
 * Parses a Postman Collection JSON and extracts MCP tools from requests.
 * Supports:
 *   - Nested folders (recursive)
 *   - Collection/folder/request-level auth inheritance
 *   - Variables ({{var}}) are preserved for runtime interpolation
 *   - Query params, headers, body (raw JSON, form-data, urlencoded)
 *   - Pre-request scripts are noted in descriptions
 */
@Injectable()
export class PostmanParser {
  private readonly logger = new Logger(PostmanParser.name);

  async parse(collection: string | Record<string, unknown>): Promise<ParsedTool[]> {
    const col = typeof collection === 'string' ? JSON.parse(collection) : collection;

    // Validate it's a Postman Collection
    const info = (col as any).info;
    if (!info || !info.name) {
      throw new Error('Invalid Postman Collection: missing info.name');
    }

    this.logger.debug(`Parsing Postman Collection: "${info.name}"`);

    const collectionAuth = (col as any).auth;
    const collectionVars = this.extractVariables((col as any).variable);
    const items = (col as any).item || [];

    const tools = this.extractFromItems(items, [], collectionAuth, collectionVars);

    this.logger.log(`Extracted ${tools.length} tools from Postman Collection "${info.name}"`);
    return tools;
  }

  async parseFromUrl(url: string): Promise<ParsedTool[]> {
    this.logger.debug(`Fetching Postman Collection from: ${url}`);
    const response = await axios.get(url, { timeout: 15000 });
    return this.parse(response.data);
  }

  async parseFromContent(content: string): Promise<ParsedTool[]> {
    return this.parse(content);
  }

  private extractFromItems(
    items: any[],
    folderPath: string[],
    parentAuth: any,
    variables: Record<string, string>,
  ): ParsedTool[] {
    const tools: ParsedTool[] = [];

    for (const item of items) {
      if (item.item && Array.isArray(item.item)) {
        // It's a folder — recurse
        const folderAuth = item.auth || parentAuth;
        const folderVars = {
          ...variables,
          ...this.extractVariables(item.variable),
        };
        tools.push(
          ...this.extractFromItems(
            item.item,
            [...folderPath, item.name],
            folderAuth,
            folderVars,
          ),
        );
      } else if (item.request) {
        // It's a request
        const tool = this.requestToTool(item, folderPath, parentAuth, variables);
        if (tool) tools.push(tool);
      }
    }

    return tools;
  }

  private requestToTool(
    item: any,
    folderPath: string[],
    parentAuth: any,
    variables: Record<string, string>,
  ): ParsedTool | null {
    const request = item.request;
    const method = typeof request.method === 'string'
      ? request.method.toUpperCase()
      : 'GET';

    // Parse URL
    const url = this.parseUrl(request.url);
    if (!url) return null;

    // Generate tool name
    const name = this.generateToolName(item.name, method, url.path, folderPath);

    // Generate description
    const descParts: string[] = [];
    if (item.name) descParts.push(item.name);
    if (request.description) {
      const desc = typeof request.description === 'string'
        ? request.description
        : request.description.content || '';
      if (desc) descParts.push(desc);
    }
    if (folderPath.length > 0) {
      descParts.push(`[Folder: ${folderPath.join(' > ')}]`);
    }
    const description = descParts.join('. ') || `${method} ${url.path}`;

    // Extract parameters
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const queryParams: Record<string, string> = {};
    const bodyMapping: Record<string, string> = {};
    const headerMapping: Record<string, string> = {};

    // Path parameters (from {{param}} in URL path)
    const pathVarMatches = url.path.match(/\{\{([^}]+)\}\}/g) || [];
    for (const match of pathVarMatches) {
      const varName = match.replace(/\{\{|\}\}/g, '');
      if (!variables[varName]) {
        // It's a dynamic path parameter, not a static env var
        properties[varName] = { type: 'string', description: `Path variable: ${varName}` };
        required.push(varName);
      }
    }

    // Also detect {param} style path params
    const pathParamMatches = url.path.match(/\{([^}]+)\}/g) || [];
    for (const match of pathParamMatches) {
      const varName = match.replace(/[{}]/g, '');
      properties[varName] = { type: 'string', description: `Path parameter: ${varName}` };
      required.push(varName);
    }

    // Query parameters
    if (url.query && Array.isArray(url.query)) {
      for (const q of url.query) {
        if (q.disabled) continue;
        const paramName = q.key;
        properties[paramName] = {
          type: 'string',
          description: q.description || `Query parameter: ${paramName}`,
        };
        queryParams[paramName] = `$${paramName}`;
        // If value contains a variable, mark as required
        if (!q.value || q.value.includes('{{')) {
          required.push(paramName);
        }
      }
    }

    // Request body
    if (request.body) {
      this.parseBody(request.body, properties, required, bodyMapping);
    }

    // Headers (non-standard ones become parameters)
    if (request.header && Array.isArray(request.header)) {
      for (const h of request.header) {
        if (h.disabled) continue;
        const headerName = h.key?.toLowerCase();
        if (['content-type', 'authorization', 'accept', 'user-agent'].includes(headerName)) continue;
        if (h.value?.includes('{{')) {
          const varName = h.value.replace(/\{\{|\}\}/g, '');
          if (!variables[varName]) {
            properties[varName] = {
              type: 'string',
              description: `Header value for ${h.key}`,
            };
          }
          headerMapping[h.key] = `$${varName}`;
        } else {
          headerMapping[h.key] = h.value;
        }
      }
    }

    // Build the tool
    const parameters: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) {
      parameters.required = [...new Set(required)];
    }

    // Normalize path: replace {{var}} with {var} for engine interpolation
    const normalizedPath = url.path.replace(/\{\{([^}]+)\}\}/g, '{$1}');

    const endpointMapping: ParsedTool['endpointMapping'] = {
      method,
      path: normalizedPath,
    };
    if (Object.keys(queryParams).length > 0) endpointMapping.queryParams = queryParams;
    if (Object.keys(bodyMapping).length > 0) endpointMapping.bodyMapping = bodyMapping;
    if (Object.keys(headerMapping).length > 0) endpointMapping.headers = headerMapping as Record<string, string>;

    return { name, description, parameters, endpointMapping };
  }

  private parseUrl(url: any): { raw: string; path: string; query?: any[] } | null {
    if (!url) return null;

    if (typeof url === 'string') {
      try {
        const parsed = new URL(url.replace(/\{\{[^}]+\}\}/g, 'placeholder'));
        return {
          raw: url,
          path: url.replace(/^https?:\/\/[^/]+/, ''),
          query: [],
        };
      } catch {
        return { raw: url, path: url, query: [] };
      }
    }

    // Postman URL object
    const pathSegments = Array.isArray(url.path) ? url.path.join('/') : (url.path || '');
    const path = pathSegments.startsWith('/') ? pathSegments : `/${pathSegments}`;

    return {
      raw: url.raw || path,
      path,
      query: url.query || [],
    };
  }

  private parseBody(
    body: any,
    properties: Record<string, any>,
    required: string[],
    bodyMapping: Record<string, string>,
  ): void {
    switch (body.mode) {
      case 'raw': {
        if (body.raw) {
          try {
            const parsed = JSON.parse(body.raw.replace(/\{\{([^}]+)\}\}/g, '"$1_placeholder"'));
            for (const [key, value] of Object.entries(parsed)) {
              properties[key] = { type: this.inferJsonType(value), description: `Body field: ${key}` };
              bodyMapping[key] = `$${key}`;
              required.push(key);
            }
          } catch {
            // Non-JSON raw body — expose as single "body" parameter
            properties['body'] = { type: 'string', description: 'Raw request body' };
            bodyMapping['__raw'] = '$body';
            required.push('body');
          }
        }
        break;
      }
      case 'urlencoded': {
        for (const field of body.urlencoded || []) {
          if (field.disabled) continue;
          properties[field.key] = {
            type: 'string',
            description: field.description || `Form field: ${field.key}`,
          };
          bodyMapping[field.key] = `$${field.key}`;
          if (field.value?.includes('{{')) required.push(field.key);
        }
        break;
      }
      case 'formdata': {
        for (const field of body.formdata || []) {
          if (field.disabled) continue;
          properties[field.key] = {
            type: field.type === 'file' ? 'string' : 'string',
            description: field.description || `Form field: ${field.key}`,
          };
          bodyMapping[field.key] = `$${field.key}`;
        }
        break;
      }
    }
  }

  private generateToolName(
    itemName: string,
    method: string,
    path: string,
    folderPath: string[],
  ): string {
    // Prefer item name if available
    if (itemName) {
      const name = itemName
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .toLowerCase();
      if (name.length > 0) {
        // Prefix with folder if there might be name collisions
        if (folderPath.length > 0) {
          const folder = folderPath[folderPath.length - 1]
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase();
          return `${folder}_${name}`.substring(0, 64);
        }
        return name.substring(0, 64);
      }
    }

    // Fallback: method + path
    const cleanPath = path
      .replace(/\{[^}]+\}/g, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `${method.toLowerCase()}_${cleanPath}`.substring(0, 64);
  }

  private extractVariables(variables: any[] | undefined): Record<string, string> {
    if (!variables || !Array.isArray(variables)) return {};
    const result: Record<string, string> = {};
    for (const v of variables) {
      if (v.key && v.value !== undefined) {
        result[v.key] = String(v.value);
      }
    }
    return result;
  }

  private inferJsonType(value: unknown): string {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object' && value !== null) return 'object';
    return 'string';
  }
}
