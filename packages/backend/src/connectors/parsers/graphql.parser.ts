import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import { buildSchema, introspectionFromSchema } from 'graphql';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { outboundAxiosOptions } from '../../common/outbound-http';

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        fields {
          name
          description
          type { ...TypeRef }
          args {
            name
            description
            type { ...TypeRef }
          }
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType { kind name }
          }
        }
      }
    }
  }
`;

@Injectable()
export class GraphqlParser {
  private readonly logger = new Logger(GraphqlParser.name);

  async parse(
    endpoint: string,
    headers?: Record<string, string>,
    specUrl?: string,
  ): Promise<ParsedTool[]> {
    // 1. Try standard introspection query
    try {
      this.logger.debug(`Introspecting GraphQL schema from: ${endpoint}`);
      await assertSafeOutboundUrl(endpoint);
      const response = await axios.post(
        endpoint,
        { query: INTROSPECTION_QUERY },
        {
          headers: { 'Content-Type': 'application/json', ...headers },
          timeout: 15000,
          ...outboundAxiosOptions({ credentialHeaders: Object.keys(headers ?? {}) }),
        },
      );

      if (!response.data.errors) {
        return this.extractToolsFromSchema(response.data.data.__schema);
      }

      this.logger.debug(
        `Introspection returned errors: ${JSON.stringify(response.data.errors)}`,
      );
    } catch (err: any) {
      this.logger.debug(`Introspection request failed: ${err.message}`);
    }

    // 2. Fallback: fetch SDL schema from specUrl or {endpoint}/schema
    const sdlUrl = specUrl || `${endpoint}/schema`;
    this.logger.debug(`Falling back to SDL schema from: ${sdlUrl}`);

    try {
      await assertSafeOutboundUrl(sdlUrl);
      const sdlResponse = await axios.get(sdlUrl, {
        headers,
        timeout: 30000,
        responseType: 'text',
        ...outboundAxiosOptions({ credentialHeaders: Object.keys(headers ?? {}) }),
      });
      return this.parseFromSdl(sdlResponse.data);
    } catch (err: any) {
      throw new Error(
        `GraphQL introspection failed and SDL fallback from ${sdlUrl} also failed: ${err.message}`,
      );
    }
  }

  /**
   * Parse tools from a GraphQL SDL (Schema Definition Language) string.
   * Converts SDL → GraphQLSchema → introspection result → tools.
   */
  parseFromSdl(sdl: string): ParsedTool[] {
    this.logger.debug('Parsing GraphQL SDL schema');

    const schema = buildSchema(sdl);
    const introspection = introspectionFromSchema(schema);
    const tools = this.extractToolsFromSchema(introspection.__schema as any);

    this.logger.log(`Extracted ${tools.length} tools from SDL schema`);
    return tools;
  }

  /**
   * Extract tools from an introspection schema result.
   * Shared between introspection query path and SDL path.
   */
  private extractToolsFromSchema(schema: any): ParsedTool[] {
    const tools: ParsedTool[] = [];

    const queryTypeName = schema.queryType?.name || 'Query';
    const mutationTypeName = schema.mutationType?.name || 'Mutation';

    // Index OBJECT types by name so a field's return type can be expanded into
    // its subfield names for the output schema.
    const typesByName = new Map<string, any>();
    for (const t of schema.types || []) {
      if (t?.name && t.kind === 'OBJECT') typesByName.set(t.name, t);
    }

    for (const type of schema.types) {
      if (type.name.startsWith('__')) continue;
      if (type.kind !== 'OBJECT') continue;

      const isQuery = type.name === queryTypeName;
      const isMutation = type.name === mutationTypeName;
      if (!isQuery && !isMutation) continue;

      for (const field of type.fields || []) {
        if (field.name.startsWith('__')) continue;
        const tool = this.fieldToTool(
          field,
          isQuery ? 'query' : 'mutation',
          typesByName,
        );
        tools.push(tool);
      }
    }

    this.logger.log(`Extracted ${tools.length} tools from GraphQL schema`);
    return tools;
  }

  private fieldToTool(
    field: any,
    type: 'query' | 'mutation',
    typesByName?: Map<string, any>,
  ): ParsedTool {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const variableMapping: Record<string, string> = {};

    for (const arg of field.args || []) {
      const jsonType = this.graphqlTypeToJsonType(arg.type);
      properties[arg.name] = {
        type: jsonType,
        ...(arg.description ? { description: arg.description } : {}),
      };
      variableMapping[arg.name] = `$${arg.name}`;

      if (this.isNonNull(arg.type)) {
        required.push(arg.name);
      }
    }

    // Build the GraphQL query string
    const argsDef = (field.args || [])
      .map((a: any) => `$${a.name}: ${this.typeToString(a.type)}`)
      .join(', ');
    const argsUsage = (field.args || [])
      .map((a: any) => `${a.name}: $${a.name}`)
      .join(', ');

    const queryStr =
      argsDef.length > 0
        ? `${type} ${field.name}(${argsDef}) { ${field.name}(${argsUsage}) }`
        : `${type} { ${field.name} }`;

    const tool: ParsedTool = {
      name: `graphql_${field.name}`.toLowerCase(),
      description: field.description || `GraphQL ${type}: ${field.name}`,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      endpointMapping: {
        method: type,
        path: queryStr,
        ...(Object.keys(variableMapping).length > 0
          ? { queryParams: variableMapping }
          : {}),
      },
    };

    if (typesByName) {
      const outputSchema = this.returnTypeToJsonSchema(
        field.type,
        typesByName,
        0,
        new Set(),
      );
      if (
        outputSchema &&
        (outputSchema.type === 'object' || outputSchema.type === 'array')
      ) {
        tool.outputSchema = outputSchema;
      }
    }
    return tool;
  }

  /**
   * Expand a GraphQL return type into a JSON Schema of its (sub)field names.
   * Unwraps NON_NULL/LIST, recurses into OBJECT types, and guards against
   * recursive types via a visited set + depth cap.
   */
  private returnTypeToJsonSchema(
    gqlType: any,
    typesByName: Map<string, any>,
    depth: number,
    visited: Set<string>,
  ): Record<string, unknown> | undefined {
    if (!gqlType || depth > 5) return undefined;

    // List → array of the inner type.
    if (gqlType.kind === 'LIST') {
      const items = this.returnTypeToJsonSchema(
        gqlType.ofType,
        typesByName,
        depth + 1,
        visited,
      );
      return items ? { type: 'array', items } : { type: 'array' };
    }
    if (gqlType.kind === 'NON_NULL') {
      return this.returnTypeToJsonSchema(
        gqlType.ofType,
        typesByName,
        depth,
        visited,
      );
    }

    const name = gqlType.name;
    const objType = name ? typesByName.get(name) : undefined;
    if (!objType) {
      // Scalar / enum / unresolved → primitive.
      return { type: this.graphqlTypeToJsonType(gqlType) };
    }
    if (visited.has(name)) return { type: 'object' }; // break cycles
    visited.add(name);

    const properties: Record<string, unknown> = {};
    let count = 0;
    for (const f of objType.fields || []) {
      if (f.name.startsWith('__') || count++ >= 100) continue;
      properties[f.name] =
        this.returnTypeToJsonSchema(f.type, typesByName, depth + 1, visited) ?? {
          type: 'string',
        };
    }
    visited.delete(name);
    return { type: 'object', properties, additionalProperties: true };
  }

  private graphqlTypeToJsonType(gqlType: any): string {
    const baseType = this.unwrapType(gqlType);
    const name = (baseType.name || '').toLowerCase();
    if (name === 'int' || name === 'float') return 'number';
    if (name === 'boolean') return 'boolean';
    if (name === 'id') return 'string';
    return 'string';
  }

  private unwrapType(gqlType: any): any {
    if (gqlType.ofType) return this.unwrapType(gqlType.ofType);
    return gqlType;
  }

  private isNonNull(gqlType: any): boolean {
    return gqlType.kind === 'NON_NULL';
  }

  private typeToString(gqlType: any): string {
    if (gqlType.kind === 'NON_NULL') {
      return `${this.typeToString(gqlType.ofType)}!`;
    }
    if (gqlType.kind === 'LIST') {
      return `[${this.typeToString(gqlType.ofType)}]`;
    }
    return gqlType.name || 'String';
  }
}
