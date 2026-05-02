import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import { buildSchema, introspectionFromSchema } from 'graphql';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

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
          args {
            name
            description
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
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

    for (const type of schema.types) {
      if (type.name.startsWith('__')) continue;
      if (type.kind !== 'OBJECT') continue;

      const isQuery = type.name === queryTypeName;
      const isMutation = type.name === mutationTypeName;
      if (!isQuery && !isMutation) continue;

      for (const field of type.fields || []) {
        if (field.name.startsWith('__')) continue;
        const tool = this.fieldToTool(field, isQuery ? 'query' : 'mutation');
        tools.push(tool);
      }
    }

    this.logger.log(`Extracted ${tools.length} tools from GraphQL schema`);
    return tools;
  }

  private fieldToTool(field: any, type: 'query' | 'mutation'): ParsedTool {
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

    return {
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
