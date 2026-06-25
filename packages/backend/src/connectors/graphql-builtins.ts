/**
 * Generic GraphQL helper tools that ship with every GraphQL connector — both
 * catalog adapters and user-created connectors. Five tools per connector:
 *
 *   <prefix>_graphql_schema_url    static URL of the SDL
 *   <prefix>_graphql_schema        proxy + filter the SDL (default summary,
 *                                  type: "X", search: "foo", or full: true)
 *   <prefix>_graphql_query         execute an arbitrary `query` document
 *   <prefix>_graphql_mutation      execute an arbitrary `mutation` document
 *   <prefix>_graphql_subscription  execute an arbitrary `subscription` document
 *
 * The schema tool exists so an agent can discover the upstream API even when
 * GraphQL introspection (`__schema` / `__type`) is disabled, AND without ever
 * hitting an agent-sandbox host-allowlist. The MCP server fetches the SDL
 * server-side, caches it, and returns task-sized slices.
 */
export interface GraphqlBuiltinTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
  useProxy?: boolean;
}

export interface GraphqlBuiltinOptions {
  /** Connector slug or slugified name; used as tool-name prefix. */
  prefix: string;
  /** Human-readable connector name; embedded in tool descriptions. */
  displayName: string;
  /** Connector's GraphQL endpoint URL. */
  baseUrl: string;
  /** Optional override for the SDL URL. Defaults to `${baseUrl}/schema`. */
  schemaUrl?: string;
  /**
   * When true, the generated query/mutation/subscription helpers route
   * through the proxy/unblocker by default (the static/schema helpers
   * never make a normal HTTP call so they're left off). Set by the
   * catalog when the adapter's own tools opt into proxy.
   */
  useProxy?: boolean;
}

/**
 * Slugify an arbitrary connector name into a tool-name-safe prefix:
 * lowercase, runs of non-alphanumerics → underscore, trimmed underscores.
 *
 *   slugifyForPrefix("My GraphQL Service")  → "my_graphql_service"
 *   slugifyForPrefix("foo-bar.baz / qux")   → "foo_bar_baz_qux"
 *   slugifyForPrefix("")                    → "graphql" (safe fallback)
 */
export function slugifyForPrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'graphql';
}

export function buildGraphqlBuiltinTools(
  opts: GraphqlBuiltinOptions,
): GraphqlBuiltinTool[] {
  const { prefix, displayName, baseUrl } = opts;
  const schemaUrl = opts.schemaUrl || `${baseUrl.replace(/\/+$/, '')}/schema`;

  const variablesSchema = {
    type: 'object',
    description:
      'GraphQL variables map (optional). Keys must match the $variables declared in the operation.',
    additionalProperties: true,
  };

  const buildOpTool = (
    op: 'query' | 'mutation' | 'subscription',
  ): GraphqlBuiltinTool => ({
    name: `${prefix}_graphql_${op}`,
    description:
      `Execute an arbitrary GraphQL ${op} against ${displayName}. ` +
      `Use only when no purpose-built tool covers the operation. ` +
      `Do not guess field or type names: if you are unsure, or hit a "Field '…' doesn't exist on type" error, ` +
      `call ${prefix}_graphql_schema first to confirm the exact fields before retrying. ` +
      `Authentication is injected automatically.` +
      (op === 'subscription'
        ? ' Note: subscriptions over the default HTTP transport may not be supported by the upstream API.'
        : ''),
    parameters: {
      type: 'object',
      properties: {
        [op]: {
          type: 'string',
          description: `GraphQL ${op} document. Example: \`${op} Name($a: ID!) { … }\`.`,
        },
        variables: variablesSchema,
      },
      required: [op],
      additionalProperties: false,
    },
    endpointMapping: {
      method: op,
      path: `$${op}`,
      variablesFromParam: 'variables',
    },
    useProxy: !!opts.useProxy,
  });

  return [
    {
      name: `${prefix}_graphql_schema_url`,
      description:
        `Returns the URL of the GraphQL SDL schema for ${displayName}. ` +
        `If your environment can reach external hosts, fetch this URL directly. ` +
        `Otherwise use \`${prefix}_graphql_schema\`, which proxies the schema through the MCP server (no allowlist concerns).`,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      endpointMapping: {
        method: 'static',
        path: schemaUrl,
      },
    },
    {
      name: `${prefix}_graphql_schema`,
      description:
        `Fetch a slice of the ${displayName} GraphQL SDL schema, proxied through the MCP server. ` +
        `Default (no args) returns a compact summary: the Query/Mutation/Subscription root blocks + an index of every type name (~20–30 KB). ` +
        `Pass \`type: "TypeName"\` to retrieve just one type's definition with its docblock (~1–5 KB). ` +
        `Pass \`search: "keyword"\` to return every type whose name or a field name contains the keyword (case-insensitive, capped to keep responses small). ` +
        `Pass \`full: true\` only when you really need the entire SDL — it can be very large (~200K tokens for some APIs).`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Single GraphQL type name to retrieve, e.g. "CurrentUser".',
          },
          search: {
            type: 'string',
            description:
              'Case-insensitive substring matched against type names and field names. Returns all matching type blocks.',
          },
          full: {
            type: 'boolean',
            description:
              "Return the entire SDL. Use sparingly — can blow past an agent's context window.",
          },
        },
        additionalProperties: false,
      },
      endpointMapping: {
        method: 'schema',
        path: schemaUrl,
      },
    },
    buildOpTool('query'),
    buildOpTool('mutation'),
    buildOpTool('subscription'),
  ];
}
