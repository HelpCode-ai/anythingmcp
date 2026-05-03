/**
 * Type contracts for connector engines.
 *
 * `endpointMapping` is stored as a `Json` column in Prisma so the wire shape
 * is `Record<string, unknown>` — this file describes what each engine
 * actually accepts, so the engines can drop their internal `as any` casts
 * and the surrounding code is type-checked.
 *
 * Runtime behaviour is unchanged: the engine code already validates each
 * field at use time. These types document the contract.
 */

export interface RestEndpointMapping {
  method: string; // GET / POST / PUT / PATCH / DELETE
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  bodyTemplate?: string;
  bodyEncoding?: 'json' | 'form-urlencoded' | 'form-data' | string;
  headers?: Record<string, string>;
}

export interface GraphqlEndpointMapping {
  method: 'query' | 'mutation' | string;
  path: string; // the GraphQL document
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface SoapEndpointMapping {
  method: string; // SOAP operation name
  path: string; // port name
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  paramOrder?: string[];
  headers?: Record<string, string>;
  soapAction?: string;
  endpoint?: string;
  targetNamespace?: string;
}

export interface DatabaseEndpointMapping {
  method:
    | 'query'
    | 'static'
    | 'mongo_schema'
    | string;
  path: string;
  staticResponse?: string;
}

export interface McpEndpointMapping {
  method: string; // remote tool name
  path: string; // remote MCP path (e.g. /mcp)
}

export type AnyEndpointMapping =
  | RestEndpointMapping
  | GraphqlEndpointMapping
  | SoapEndpointMapping
  | DatabaseEndpointMapping
  | McpEndpointMapping;

/**
 * Common metadata that may appear on responseMapping. We only use cacheTtl
 * for the moment (used by dynamic-mcp-tools to short-circuit re-execution).
 */
export interface ResponseMapping {
  cacheTtl?: number;
  type?: string;
  fields?: string[];
  [k: string]: unknown;
}

export interface ConnectorEngineConfig {
  baseUrl: string;
  authType: string;
  authConfig?: Record<string, unknown>;
  headers?: Record<string, string>;
  connectorId?: string;
  specUrl?: string;
}
