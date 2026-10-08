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
  bodyEncoding?: 'json' | 'form-urlencoded' | 'form-data' | 'xml' | string;
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
  /**
   * Element that wraps the parameters in the body, when the WSDL's input
   * message part names one other than the operation (`GetItemRequest` for
   * `GetItem`). Absent: the operation name.
   */
  inputElement?: string;
  /** Namespace of the body element and its parameters, when it differs from `targetNamespace`. */
  inputNamespace?: string;
  /**
   * Child element order of complex (nested) parameters, from the schema, by
   * path of element names: `{ "address": ["street", "city"] }`. Needed
   * because a JSON column does not keep object key order and an xs:sequence
   * is order-sensitive. Fields not listed follow in the order given. Set on
   * import; absent: the order of the value's keys.
   */
  elementOrder?: Record<string, string[]>;
  /**
   * `false`: the parameter elements, and those nested in them, are written
   * without a prefix, i.e. in no namespace, as the schema's
   * elementFormDefault="unqualified" (the XSD default) and RPC message parts
   * require. Set on import; absent: qualified (`tns:`), as before.
   */
  childElementsQualified?: boolean;
  /**
   * `'1.2'` for an operation of a SOAP 1.2 port: the envelope is in the SOAP
   * 1.2 namespace and the action travels in the Content-Type
   * (`application/soap+xml; action="…"`) instead of a SOAPAction header.
   * Set on import; absent: SOAP 1.1.
   */
  soapVersion?: '1.1' | '1.2';
}

export interface DatabaseEndpointMapping {
  method:
    | 'query'
    | 'static'
    | 'mongo_schema'
    | string;
  path: string;
  staticResponse?: string;
  /** Topic → text; see static-response.util.ts. */
  staticResponses?: Record<string, string>;
  topicParam?: string;
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
 * Metadata that may appear on a tool's responseMapping.
 *
 * `cacheTtl`  — Redis response cache TTL in seconds (DynamicMcpTools).
 * `followUp`  — workflow hint appended to the tool result: tells the calling
 *               agent what to do next, to drive multi-step tool chains.
 * `transform` — optional response shaping applied before the result reaches the
 *               MCP client (see response-transform.util).
 * `fields`    — legacy include list, kept working as a shorthand for
 *               `transform.include`.
 */
export interface ResponseMapping {
  cacheTtl?: number;
  type?: string;
  fields?: string[];
  followUp?: string;
  transform?: Record<string, unknown>;
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
