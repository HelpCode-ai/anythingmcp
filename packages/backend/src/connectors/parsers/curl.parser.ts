import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';

/**
 * cURL Parser.
 * Converts one or more cURL commands into MCP tool definitions.
 *
 * Supports:
 *   - Method (-X / --request)
 *   - Headers (-H / --header)
 *   - Data (-d / --data / --data-raw / --data-binary)
 *   - Basic auth (-u / --user)
 *   - URL with query parameters
 *   - Multiple cURL commands separated by newlines
 *   - Multiline commands with backslash continuation
 *
 * Variables like {{var}} in the cURL are preserved and become tool parameters.
 */
@Injectable()
export class CurlParser {
  private readonly logger = new Logger(CurlParser.name);

  parse(input: string): ParsedTool[] {
    // Normalize: join backslash-continued lines
    const normalized = input.replace(/\\\s*\n/g, ' ').trim();

    // Split on `curl ` at the beginning of lines (handles multiple commands)
    const commands = normalized
      .split(/\n\s*(?=curl\s)/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const tools: ParsedTool[] = [];
    for (const cmd of commands) {
      const tool = this.parseSingleCurl(cmd);
      if (tool) tools.push(tool);
    }

    this.logger.log(`Parsed ${tools.length} tools from cURL input`);
    return tools;
  }

  private parseSingleCurl(command: string): ParsedTool | null {
    // Remove leading "curl" keyword
    let cmd = command.replace(/^\s*curl\s+/i, '').trim();

    let method = 'GET';
    const headers: Record<string, string> = {};
    let dataBody: string | undefined;
    let basicAuth: string | undefined;
    let url = '';

    // Tokenize respecting quoted strings
    const tokens = this.tokenize(cmd);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (token === '-X' || token === '--request') {
        method = (tokens[++i] || 'GET').toUpperCase();
      } else if (token === '-H' || token === '--header') {
        const headerVal = tokens[++i] || '';
        const colonIdx = headerVal.indexOf(':');
        if (colonIdx > 0) {
          const key = headerVal.substring(0, colonIdx).trim();
          const value = headerVal.substring(colonIdx + 1).trim();
          headers[key] = value;
        }
      } else if (
        token === '-d' ||
        token === '--data' ||
        token === '--data-raw' ||
        token === '--data-binary' ||
        token === '--data-urlencode'
      ) {
        dataBody = tokens[++i] || '';
        if (method === 'GET') method = 'POST'; // curl defaults to POST with -d
      } else if (token === '-u' || token === '--user') {
        basicAuth = tokens[++i] || '';
      } else if (
        !token.startsWith('-') ||
        token.match(/^https?:\/\//) ||
        token.includes('{{')
      ) {
        // It's the URL (or starts with variable pattern)
        if (!url && (token.startsWith('http') || token.startsWith('{{') || token.includes('/'))) {
          url = token.replace(/^['"]|['"]$/g, ''); // Remove quotes
        }
      }
    }

    if (!url) {
      this.logger.warn('cURL command has no URL, skipping');
      return null;
    }

    // Parse the URL
    const { basePath, path, queryParams: urlQueryParams } = this.parseUrl(url);

    // Build parameters and mappings
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const queryParamsMapping: Record<string, string> = {};
    const bodyMapping: Record<string, string> = {};
    const headerMapping: Record<string, string> = {};

    // Extract variables from URL path
    const pathVars = path.match(/\{\{([^}]+)\}\}/g) || [];
    for (const match of pathVars) {
      const varName = match.replace(/\{\{|\}\}/g, '');
      properties[varName] = { type: 'string', description: `Path variable: ${varName}` };
      required.push(varName);
    }

    // URL query parameters
    for (const [key, value] of Object.entries(urlQueryParams)) {
      if (value.includes('{{')) {
        const varName = value.replace(/\{\{|\}\}/g, '');
        properties[varName] = { type: 'string', description: `Query parameter: ${key}` };
        required.push(varName);
        queryParamsMapping[key] = `$${varName}`;
      } else {
        // Static query param → create an optional parameter with default value
        const paramName = key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '') || 'param';
        properties[paramName] = {
          type: 'string',
          description: `Query parameter: ${key}`,
          default: value,
        };
        queryParamsMapping[key] = `$${paramName}`;
      }
    }

    // Headers with variables
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (['content-type', 'accept', 'user-agent'].includes(lowerKey)) continue;
      if (lowerKey === 'authorization') continue; // Handle separately

      if (value.includes('{{')) {
        const varName = value.replace(/.*\{\{([^}]+)\}\}.*/, '$1');
        properties[varName] = { type: 'string', description: `Header value for ${key}` };
        headerMapping[key] = `$${varName}`;
      } else {
        headerMapping[key] = value;
      }
    }

    // Parse body data
    if (dataBody) {
      try {
        // Try JSON parse
        const cleanBody = dataBody.replace(/\{\{([^}]+)\}\}/g, '"__var_$1__"');
        const parsed = JSON.parse(cleanBody);
        for (const [key, value] of Object.entries(parsed)) {
          const strVal = String(value);
          if (strVal.startsWith('__var_') && strVal.endsWith('__')) {
            const varName = strVal.replace(/^__var_|__$/g, '');
            properties[varName] = { type: 'string', description: `Body field: ${key}` };
            required.push(varName);
            bodyMapping[key] = `$${varName}`;
          } else {
            properties[key] = {
              type: this.inferType(value),
              description: `Body field: ${key}`,
              default: value,
            };
            bodyMapping[key] = `$${key}`;
          }
        }
      } catch {
        // Not JSON — treat as raw body parameter
        if (dataBody.includes('{{')) {
          const varName = dataBody.replace(/.*\{\{([^}]+)\}\}.*/, '$1');
          properties[varName] = { type: 'string', description: 'Request body' };
          required.push(varName);
          bodyMapping['__raw'] = `$${varName}`;
        } else {
          properties['body'] = { type: 'string', description: 'Raw request body', default: dataBody };
          bodyMapping['__raw'] = '$body';
        }
      }
    }

    // Auth from -u flag
    if (basicAuth) {
      // Don't expose credentials as parameters — note in description
    }

    // Auth from Authorization header
    const authHeader = headers['Authorization'] || headers['authorization'];

    // Generate tool name from path
    const name = this.generateToolName(method, path);

    // Description
    const description = `${method} ${path}${Object.keys(urlQueryParams).length > 0 ? ' (with query params)' : ''}`;

    const parameters: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) {
      parameters.required = [...new Set(required)];
    }

    // Normalize path: replace {{var}} with {var}
    const normalizedPath = path.replace(/\{\{([^}]+)\}\}/g, '{$1}');

    const endpointMapping: ParsedTool['endpointMapping'] = {
      method,
      path: normalizedPath,
    };
    if (Object.keys(queryParamsMapping).length > 0) endpointMapping.queryParams = queryParamsMapping;
    if (Object.keys(bodyMapping).length > 0) endpointMapping.bodyMapping = bodyMapping;
    if (Object.keys(headerMapping).length > 0) endpointMapping.headers = headerMapping as Record<string, string>;

    return { name, description, parameters, endpointMapping };
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        continue;
      }
      current += char;
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  private parseUrl(url: string): {
    basePath: string;
    path: string;
    queryParams: Record<string, string>;
  } {
    const queryParams: Record<string, string> = {};

    // Handle {{variable}} in URL by temporary replacement
    const safeUrl = url.replace(/\{\{([^}]+)\}\}/g, 'PLACEHOLDER_$1');

    try {
      const parsed = new URL(safeUrl);
      const basePath = `${parsed.protocol}//${parsed.host}`;

      // Restore variables in path
      let path = parsed.pathname.replace(/PLACEHOLDER_([a-zA-Z0-9_]+)/g, '{{$1}}');

      // Parse query params
      parsed.searchParams.forEach((value, key) => {
        const restoredKey = key.replace(/PLACEHOLDER_([a-zA-Z0-9_]+)/g, '{{$1}}');
        const restoredValue = value.replace(/PLACEHOLDER_([a-zA-Z0-9_]+)/g, '{{$1}}');
        queryParams[restoredKey] = restoredValue;
      });

      return { basePath, path, queryParams };
    } catch {
      // URL parsing failed — extract path manually
      const pathStart = url.indexOf('/', url.indexOf('//') + 2);
      const queryStart = url.indexOf('?');

      let path = pathStart >= 0
        ? (queryStart >= 0 ? url.substring(pathStart, queryStart) : url.substring(pathStart))
        : '/';

      if (queryStart >= 0) {
        const queryString = url.substring(queryStart + 1);
        for (const pair of queryString.split('&')) {
          const [key, ...rest] = pair.split('=');
          queryParams[key] = rest.join('=');
        }
      }

      return { basePath: '', path, queryParams };
    }
  }

  private generateToolName(method: string, path: string): string {
    const cleanPath = path
      .replace(/\{[^}]+\}/g, '')
      .replace(/\{\{[^}]+\}\}/g, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    return `${method.toLowerCase()}_${cleanPath || 'request'}`.substring(0, 64);
  }

  private inferType(value: unknown): string {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    return 'string';
  }
}
