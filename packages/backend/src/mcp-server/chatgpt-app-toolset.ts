import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { RegisteredTool, isListable } from './tool-registry';
import type { ToolResultContent } from './dynamic-mcp-tools';
import {
  ConnectorSummary,
  SharedToolsetDeps,
  excludedOnSharedEndpoint,
} from './shared-toolset';

/**
 * The tool set of `/mcp/chatgpt-app`, the endpoint behind the AnythingMCP
 * plugin in OpenAI's plugin directory.
 *
 * OpenAI's plugin guidelines require every model-callable operation to be its
 * own tool, and forbid "discovery, operation selection, or schema fetching
 * with a generic executor". The meta-tools of the shared `/mcp` (search a
 * workspace's tools, describe one, run it) are exactly that, so this endpoint
 * serves a different, fixed set instead: each tool below is one operation, the
 * same for every user, and none of them runs a workspace tool chosen by name.
 *
 * What it does:
 *   - read-only SQL (or MongoDB find) queries against the databases the
 *     workspace connected, with the schema and the dialect's examples;
 *   - the workspace's connectors and their setup state, recent activity
 *     (calls and failures per connector), its notes, and the dashboard link.
 *
 * A database is only offered when its connector is read-only: the query tool
 * is annotated read-only, so a connector that allows writes is listed as not
 * available here instead of being queried. The database engine enforces the
 * read-only rule as well (SELECT / WITH only, no stacked statements).
 *
 * Every call goes through `deps.execute`, i.e. the same path, scope, licence
 * check and audit row as any other call: nothing here widens what the caller
 * may reach. `scopeTools` is already narrowed by the controller to the
 * connection grant and the caller's MCP roles.
 *
 * Kept free of Nest, like shared-toolset.ts, so every rule is testable with
 * plain objects. `/mcp` and `/mcp/<serverId>` are unaffected.
 */

export const CHATGPT_APP_TOOL_NAMES = [
  'anythingmcp_list_connectors',
  'anythingmcp_list_databases',
  'anythingmcp_get_database_schema',
  'anythingmcp_get_query_examples',
  'anythingmcp_query_database',
  'anythingmcp_get_connector_activity',
  'anythingmcp_get_workspace_guide',
  'anythingmcp_get_configuration_url',
] as const;

// Only rules that span tools, the important part first (OpenAI's guidance for
// server instructions).
export const CHATGPT_APP_INSTRUCTIONS = [
  "Rules for working with the user's AnythingMCP workspace:",
  '- Before the first query on a database, call anythingmcp_get_database_schema and use only the table and column names it returns.',
  '- Queries are read-only and return at most 1000 rows: filter and aggregate in the query instead of reading whole tables.',
  '- Never ask for passwords, connection strings or API keys in the chat. The user adds and changes databases in the dashboard (anythingmcp_get_configuration_url).',
].join('\n');

export interface ConnectorActivity {
  connectorId: string;
  calls: number;
  errors: number;
  lastCallAt: Date | null;
  lastErrorAt: Date | null;
}

export type ChatgptAppDeps = Pick<
  SharedToolsetDeps,
  'execute' | 'connectors' | 'guide' | 'connectorUrl' | 'configuration'
> & {
  /** Calls and failures per connector over the last `days` days. */
  activity(connectorIds: string[], days: number): Promise<ConnectorActivity[]>;
};

type TextResult = {
  content: ToolResultContent[number][];
  isError?: boolean;
};

const GUIDE_MAX_CHARS = 100_000;
const ACTIVITY_DEFAULT_DAYS = 7;
const ACTIVITY_MAX_DAYS = 90;

function json(value: unknown, isError = false): TextResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** True when `name` is the generated tool `base`, with or without a prefix. */
function isGenerated(tool: RegisteredTool, base: string): boolean {
  return tool.name === base || tool.name.endsWith(`_${base}`);
}

function isQueryTool(tool: RegisteredTool): boolean {
  return (
    isGenerated(tool, 'execute_query') &&
    tool.endpointMapping?.method === 'query' &&
    tool.endpointMapping?.path === '${query}'
  );
}

function isSchemaTool(tool: RegisteredTool): boolean {
  return (
    isGenerated(tool, 'get_database_schema') &&
    (tool.endpointMapping?.method === 'query' || tool.endpointMapping?.method === 'mongo_schema')
  );
}

function isExamplesTool(tool: RegisteredTool): boolean {
  return isGenerated(tool, 'get_example_queries') && tool.endpointMapping?.method === 'static';
}

/**
 * The database engine from the connection URL's scheme. Only the scheme is
 * read: the URL itself can carry credentials and never leaves the server.
 */
export function databaseEngine(baseUrl: string | undefined): string {
  const url = (baseUrl ?? '').trim().toLowerCase();
  if (url.startsWith('mongodb://') || url.startsWith('mongodb+srv://')) return 'MongoDB';
  if (url.startsWith('hana://') || url.startsWith('saphana://')) return 'SAP HANA';
  if (url.startsWith('mssql://') || url.startsWith('sqlserver://')) return 'SQL Server';
  if (url.startsWith('mysql://')) return 'MySQL';
  if (url.startsWith('mariadb://')) return 'MariaDB';
  if (url.startsWith('oracle://') || url.startsWith('oracledb://')) return 'Oracle';
  if (url.startsWith('sqlite:')) return 'SQLite';
  return 'PostgreSQL';
}

function isReadOnlyConnector(tool: RegisteredTool): boolean {
  return (tool.connectorConfig?.config as { readOnly?: unknown } | undefined)?.readOnly !== false;
}

interface Database {
  connectorId: string;
  engine: string;
  readOnly: boolean;
  query?: RegisteredTool;
  schema?: RegisteredTool;
  examples?: RegisteredTool;
}

const databaseInput = {
  database: z
    .string()
    .min(1)
    .describe('Database id or name, as returned by anythingmcp_list_databases.'),
};

/**
 * Registers the fixed tool set on a per-request server. Every caller gets the
 * same names, descriptions, schemas and annotations; only the answers depend
 * on the caller's scope.
 */
export function registerChatgptAppToolset(
  mcpServer: McpServer,
  scopeTools: RegisteredTool[],
  deps: ChatgptAppDeps,
): void {
  const served = scopeTools.filter((t) => !excludedOnSharedEndpoint(t, 'chatgpt'));
  const ready = served.filter(isListable);
  const pending = served.filter((t) => !isListable(t));
  const connectorIds = [...new Set(ready.map((t) => t.connectorId))];

  // Database connectors in scope, by connector. A role can hide single tools,
  // so a database may have a schema tool but no query tool, or the reverse.
  const databases = new Map<string, Database>();
  for (const t of ready) {
    if (t.connectorType !== 'DATABASE') continue;
    const db = databases.get(t.connectorId) ?? {
      connectorId: t.connectorId,
      engine: databaseEngine(t.connectorConfig?.baseUrl),
      readOnly: isReadOnlyConnector(t),
    };
    if (isQueryTool(t)) db.query ??= t;
    else if (isSchemaTool(t)) db.schema ??= t;
    else if (isExamplesTool(t)) db.examples ??= t;
    databases.set(t.connectorId, db);
  }

  let summaries: Promise<Map<string, ConnectorSummary>> | null = null;
  const connectorsById = () => {
    summaries ??= deps
      .connectors([...new Set(scopeTools.map((t) => t.connectorId))])
      .then((list) => new Map(list.map((c) => [c.id, c])));
    return summaries;
  };
  const nameOf = (byId: Map<string, ConnectorSummary>, id: string) => byId.get(id)?.name ?? id;

  /** Connector ids matching an id or a name; an exact match wins over a partial one. */
  const matchIn = async (ids: string[], value: string): Promise<string[]> => {
    const byId = await connectorsById();
    const raw = value.trim();
    const wanted = raw.toLowerCase();
    const exact = ids.filter((id) => id === raw || nameOf(byId, id).toLowerCase() === wanted);
    if (exact.length > 0 || !wanted) return exact;
    return ids.filter((id) => nameOf(byId, id).toLowerCase().includes(wanted));
  };

  /** The one queryable database a value names, or an error result. */
  const resolveDatabase = async (
    value: string,
    need: 'query' | 'schema' | 'examples',
  ): Promise<{ db: Database; name: string } | { error: TextResult }> => {
    const byId = await connectorsById();
    const matches = await matchIn([...databases.keys()], value);
    if (matches.length === 0) {
      return {
        error: json(
          {
            error: `No database '${value}' on this connection. Call anythingmcp_list_databases for the available ones.`,
          },
          true,
        ),
      };
    }
    if (matches.length > 1) {
      return {
        error: json(
          {
            error: `More than one database matches '${value}'. Pass one of these ids.`,
            databases: matches.map((id) => ({ id, name: nameOf(byId, id) })),
          },
          true,
        ),
      };
    }
    const db = databases.get(matches[0])!;
    const name = nameOf(byId, db.connectorId);
    if (!db.readOnly) {
      return {
        error: json(
          {
            error: `'${name}' is connected with write access, so it is not queried from here. A workspace admin can switch the connector to read-only in the dashboard.`,
            dashboardUrl: deps.connectorUrl(db.connectorId),
          },
          true,
        ),
      };
    }
    if (!db[need]) {
      return {
        error: json(
          { error: `This connection may not ${need === 'query' ? 'run queries on' : 'read the structure of'} '${name}'. A workspace admin decides this with the MCP roles.` },
          true,
        ),
      };
    }
    return { db, name };
  };

  mcpServer.registerTool(
    'anythingmcp_list_connectors',
    {
      description:
        "List the connectors of the user's AnythingMCP workspace that this connection can reach (databases, APIs and business applications), with their type and whether their setup is complete. Connectors whose setup is unfinished come with the link where the user completes it.",
      inputSchema: {},
      annotations: {
        title: 'List connectors',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const byId = await connectorsById();
      const typeOf = (id: string) =>
        (ready.find((t) => t.connectorId === id) ?? pending.find((t) => t.connectorId === id))
          ?.connectorType ?? 'REST';
      const connectors = connectorIds
        .map((id) => ({
          id,
          name: nameOf(byId, id),
          type: typeOf(id).toLowerCase(),
          ...(databases.has(id) ? { queryableHere: databases.get(id)!.readOnly } : {}),
          hasNotes: byId.get(id)?.hasGuide ?? false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const needsSetup = [...new Map(pending.map((t) => [t.connectorId, t])).values()]
        .map((t) => ({
          id: t.connectorId,
          name: nameOf(byId, t.connectorId),
          whatIsMissing:
            t.setupStatus === 'needs_authorization'
              ? 'it has to be authorized with the provider'
              : 'a credential or setting is still empty',
          finishSetupUrl: deps.connectorUrl(t.connectorId),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json({
        connectors,
        ...(needsSetup.length ? { needsSetup } : {}),
        ...(connectors.length === 0 && needsSetup.length === 0
          ? { hint: 'This connection reaches no connectors yet. The user adds them in the dashboard: call anythingmcp_get_configuration_url.' }
          : {}),
      });
    },
  );

  mcpServer.registerTool(
    'anythingmcp_list_databases',
    {
      description:
        'List the databases of the workspace that can be queried from here: their id, name and engine (PostgreSQL, MySQL, SQL Server, Oracle, SAP HANA, SQLite or MongoDB). Only read-only connections are queryable.',
      inputSchema: {},
      annotations: {
        title: 'List databases',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const byId = await connectorsById();
      const all = [...databases.values()].sort((a, b) =>
        nameOf(byId, a.connectorId).localeCompare(nameOf(byId, b.connectorId)),
      );
      const queryable = all
        .filter((d) => d.readOnly && d.query)
        .map((d) => ({ id: d.connectorId, name: nameOf(byId, d.connectorId), engine: d.engine }));
      const notQueryable = all
        .filter((d) => !d.readOnly || !d.query)
        .map((d) => ({
          id: d.connectorId,
          name: nameOf(byId, d.connectorId),
          engine: d.engine,
          reason: !d.readOnly
            ? 'connected with write access; only read-only connections are queried from here'
            : 'this connection may not run queries on it',
        }));
      return json({
        databases: queryable,
        ...(notQueryable.length ? { notQueryable } : {}),
        ...(all.length === 0
          ? { hint: 'No database is connected yet. The user adds one in the dashboard: call anythingmcp_get_configuration_url.' }
          : {}),
      });
    },
  );

  mcpServer.registerTool(
    'anythingmcp_get_database_schema',
    {
      description:
        'The structure of one database: its tables and columns with data types, nullability and primary keys (for MongoDB: its collections and the fields seen in sample documents). Call it before writing a query.',
      inputSchema: databaseInput,
      annotations: {
        title: 'Get database schema',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { database: string }) => {
      const found = await resolveDatabase(args.database, 'schema');
      if ('error' in found) return found.error;
      return deps.execute(found.db.schema!, {});
    },
  );

  mcpServer.registerTool(
    'anythingmcp_get_query_examples',
    {
      description:
        "Example queries in the database's own dialect (how to limit rows, quote names, filter dates), so a query works on the first try. Runs nothing against the database.",
      inputSchema: databaseInput,
      annotations: {
        title: 'Get query examples',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { database: string }) => {
      const found = await resolveDatabase(args.database, 'examples');
      if ('error' in found) return found.error;
      return deps.execute(found.db.examples!, {});
    },
  );

  mcpServer.registerTool(
    'anythingmcp_query_database',
    {
      description:
        'Run one read-only query on a database and return the rows (at most 1000). SQL databases take a single SELECT (or WITH … SELECT) statement; MongoDB takes a JSON find query such as {"collection":"orders","filter":{"status":"open"},"limit":20}. Statements that change data are refused.',
      inputSchema: {
        ...databaseInput,
        query: z
          .string()
          .min(1)
          .describe('The SELECT statement, or for MongoDB the JSON find query.'),
      },
      annotations: {
        title: 'Query database',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { database: string; query: string }) => {
      const found = await resolveDatabase(args.database, 'query');
      if ('error' in found) return found.error;
      return deps.execute(found.db.query!, { query: args.query });
    },
  );

  mcpServer.registerTool(
    'anythingmcp_get_connector_activity',
    {
      description:
        "How the workspace's connectors have been used recently: calls, failed calls and the time of the last call and of the last failure, per connector. Counts only, no request contents.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(ACTIVITY_MAX_DAYS)
          .optional()
          .describe(`Period in days, 1 to ${ACTIVITY_MAX_DAYS}. Default ${ACTIVITY_DEFAULT_DAYS}.`),
      },
      annotations: {
        title: 'Connector activity',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { days?: number }) => {
      const days = args.days ?? ACTIVITY_DEFAULT_DAYS;
      const ids = [...new Set(served.map((t) => t.connectorId))];
      const [byId, rows] = await Promise.all([
        connectorsById(),
        ids.length ? deps.activity(ids, days) : Promise.resolve([]),
      ]);
      const byConnector = new Map(rows.map((r) => [r.connectorId, r]));
      const connectors = ids
        .map((id) => {
          const r = byConnector.get(id);
          return {
            id,
            name: nameOf(byId, id),
            calls: r?.calls ?? 0,
            failedCalls: r?.errors ?? 0,
            lastCallAt: r?.lastCallAt ? r.lastCallAt.toISOString() : null,
            lastFailureAt: r?.lastErrorAt ? r.lastErrorAt.toISOString() : null,
          };
        })
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
      return json({ days, connectors });
    },
  );

  mcpServer.registerTool(
    'anythingmcp_get_workspace_guide',
    {
      description:
        "The workspace's own notes on its connectors: what the tables and fields mean, naming conventions and the approved ways to answer common questions. Read it before the first query on a connector.",
      inputSchema: {
        connector: z.string().optional().describe('Only this connector (id or name).'),
      },
      annotations: {
        title: 'Workspace guide',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { connector?: string }) => {
      const ids = args.connector ? await matchIn(connectorIds, args.connector) : connectorIds;
      if (args.connector && ids.length === 0) {
        return json({ error: `No connector '${args.connector}' on this connection.` }, true);
      }
      const guide = ids.length ? await deps.guide(ids, !args.connector) : undefined;
      if (!guide) return json({ guide: null, note: 'The workspace has no notes for these connectors.' });
      const text =
        guide.length > GUIDE_MAX_CHARS
          ? `${guide.slice(0, GUIDE_MAX_CHARS)}\n\n[truncated: pass "connector" for one connector's notes]`
          : guide;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  mcpServer.registerTool(
    'anythingmcp_get_configuration_url',
    {
      description:
        'Link to the AnythingMCP dashboard, where the user adds a database or another connector, enters its credentials, switches it to read-only and decides who may use it.',
      inputSchema: {},
      annotations: {
        title: 'Configuration link',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const cfg = await deps.configuration();
      return json({
        dashboardUrl: cfg.dashboardUrl,
        note: 'Credentials are entered only in the dashboard, never in the chat. Changes there are available here right away.',
      });
    },
  );
}
