import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { RegisteredTool } from './tool-registry';
import {
  CHATGPT_APP_INSTRUCTIONS,
  CHATGPT_APP_TOOL_NAMES,
  ChatgptAppDeps,
  databaseEngine,
  registerChatgptAppToolset,
} from './chatgpt-app-toolset';

function tool(p: Partial<RegisteredTool> & { name: string; connectorId: string }): RegisteredTool {
  return {
    id: `${p.connectorId}:${p.name}`,
    organizationId: 'org-A',
    description: `${p.name} description`,
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/x' },
    ...p,
  } as RegisteredTool;
}

/** The three tools a DATABASE connector is generated with. */
function database(
  connectorId: string,
  opts: { baseUrl?: string; readOnly?: boolean; prefix?: string } = {},
): RegisteredTool[] {
  const prefix = opts.prefix ? `${opts.prefix}_` : '';
  const connectorConfig = {
    baseUrl: opts.baseUrl ?? 'postgresql://reader:s3cret@db.internal:5432/sales',
    authType: 'NONE',
    config: opts.readOnly === false ? { readOnly: false } : {},
  };
  const base = { connectorId, connectorType: 'DATABASE', connectorConfig };
  return [
    tool({ ...base, name: `${prefix}get_database_schema`, endpointMapping: { method: 'query', path: 'SELECT … FROM information_schema.columns' } }),
    tool({ ...base, name: `${prefix}get_example_queries`, endpointMapping: { method: 'static', path: '' } }),
    tool({
      ...base,
      name: `${prefix}execute_query`,
      endpointMapping: { method: 'query', path: '${query}' },
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }),
  ];
}

const SALES_DB = database('c-sales', { prefix: 'sales' });
const WRITABLE_DB = database('c-erp', { prefix: 'erp', readOnly: false, baseUrl: 'mssql://sa:pw@erp:1433/erp' });
const CRM_READ = tool({ name: 'crm_find_customer', connectorId: 'c-crm' });
const CRM_PENDING = tool({ name: 'shop_list_orders', connectorId: 'c-shop', setupStatus: 'needs_input' });
const WISE_PAY = tool({
  name: 'wise_create_transfer',
  connectorId: 'c-wise',
  endpointMapping: { method: 'POST', path: '/transfers' },
  connectorConfig: { baseUrl: 'https://api.wise.com', authType: 'BEARER_TOKEN', config: { adapterSlug: 'wise' } },
});

const NAMES: Record<string, string> = {
  'c-sales': 'Sales DB',
  'c-erp': 'ERP',
  'c-crm': 'Acme CRM',
  'c-shop': 'Shop',
  'c-wise': 'Wise',
};

function makeDeps(overrides: Partial<ChatgptAppDeps> = {}) {
  return {
    execute: jest.fn(async (t: RegisteredTool, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ran: t.id, args }) }],
    })),
    connectors: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: NAMES[id] ?? id, hasGuide: id === 'c-sales' })),
    ),
    guide: jest.fn(async () => '## Sales DB\nAmounts are in cents.'),
    connectorUrl: (id: string) => `https://cloud.example.com/connectors/${id}`,
    configuration: jest.fn(async () => ({
      dashboardUrl: 'https://cloud.example.com/connectors',
      servers: [{ name: 'Default', url: 'https://cloud.example.com/mcp/srv-1' }],
    })),
    activity: jest.fn(async () => [
      {
        connectorId: 'c-sales',
        calls: 12,
        errors: 2,
        lastCallAt: new Date('2026-10-23T10:00:00Z'),
        lastErrorAt: new Date('2026-10-22T09:00:00Z'),
      },
    ]),
    ...overrides,
  };
}

async function connect(scope: RegisteredTool[], deps = makeDeps()) {
  const server = new McpServer(
    { name: 'AnythingMCP', version: 'test' },
    { instructions: CHATGPT_APP_INSTRUCTIONS },
  );
  registerChatgptAppToolset(server, scope, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, deps };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: !!result.isError, body, text };
}

describe('/mcp/chatgpt-app tool set', () => {
  it('lists the same fixed tools and instructions whatever the caller can reach', async () => {
    const a = await connect([...SALES_DB, ...WRITABLE_DB, CRM_READ]);
    const b = await connect([]);
    const listA = (await a.client.listTools()).tools;
    const listB = (await b.client.listTools()).tools;
    expect(listA.map((t) => t.name).sort()).toEqual([...CHATGPT_APP_TOOL_NAMES].sort());
    expect(JSON.stringify(listA)).toEqual(JSON.stringify(listB));
    expect(a.client.getInstructions()).toBe(CHATGPT_APP_INSTRUCTIONS);
  });

  it('has no generic executor and sets every hint explicitly, all read-only', async () => {
    const { client } = await connect([]);
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      expect(t.name).not.toMatch(/search_tools|describe_tool|run_|kg_how_to_obtain/);
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(typeof t.annotations?.idempotentHint).toBe('boolean');
      expect(t.annotations?.title).toBeTruthy();
      // No tool takes a tool name or free-form arguments to dispatch.
      const props = Object.keys((t.inputSchema as any).properties ?? {});
      expect(props).not.toContain('tool');
      expect(props).not.toContain('arguments');
    }
  });

  it('lists only read-only databases as queryable, without connection URLs', async () => {
    const { client } = await connect([...SALES_DB, ...WRITABLE_DB, CRM_READ]);
    const { body, text } = await call(client, 'anythingmcp_list_databases');
    expect(body.databases).toEqual([{ id: 'c-sales', name: 'Sales DB', engine: 'PostgreSQL' }]);
    expect(body.notQueryable).toEqual([
      expect.objectContaining({ id: 'c-erp', engine: 'SQL Server', reason: expect.stringMatching(/write access/) }),
    ]);
    expect(text).not.toMatch(/s3cret|reader:|postgresql:\/\/|mssql:\/\//);
  });

  it('runs a query through the database\'s own query tool, by id or name', async () => {
    const { client, deps } = await connect([...SALES_DB, CRM_READ]);
    const byName = await call(client, 'anythingmcp_query_database', {
      database: 'sales db',
      query: 'SELECT count(*) FROM orders',
    });
    expect(byName.isError).toBe(false);
    expect(deps.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'c-sales:sales_execute_query' }),
      { query: 'SELECT count(*) FROM orders' },
    );
    await call(client, 'anythingmcp_query_database', { database: 'c-sales', query: 'SELECT 1' });
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('serves the schema and the dialect examples from the generated tools', async () => {
    const { client, deps } = await connect([...SALES_DB]);
    await call(client, 'anythingmcp_get_database_schema', { database: 'Sales DB' });
    expect(deps.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'c-sales:sales_get_database_schema' }),
      {},
    );
    await call(client, 'anythingmcp_get_query_examples', { database: 'Sales DB' });
    expect(deps.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'c-sales:sales_get_example_queries' }),
      {},
    );
  });

  it('refuses a database connected with write access and never runs its query tool', async () => {
    const { client, deps } = await connect([...WRITABLE_DB]);
    const { isError, body } = await call(client, 'anythingmcp_query_database', {
      database: 'ERP',
      query: 'SELECT 1',
    });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/write access/);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('never runs a non-database tool, even when its name is passed as the database', async () => {
    const { client, deps } = await connect([CRM_READ]);
    const { isError } = await call(client, 'anythingmcp_query_database', {
      database: 'Acme CRM',
      query: 'SELECT 1',
    });
    expect(isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('respects a role that hides the query tool but keeps the schema', async () => {
    const schemaOnly = SALES_DB.filter((t) => !t.name.endsWith('execute_query'));
    const { client, deps } = await connect(schemaOnly);
    const list = await call(client, 'anythingmcp_list_databases');
    expect(list.body.databases).toEqual([]);
    expect(list.body.notQueryable[0].reason).toMatch(/may not run queries/);
    const q = await call(client, 'anythingmcp_query_database', { database: 'Sales DB', query: 'SELECT 1' });
    expect(q.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
    await call(client, 'anythingmcp_get_database_schema', { database: 'Sales DB' });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('asks for an id when two databases match a name', async () => {
    const other = database('c-sales2', { prefix: 'sales2' });
    const deps = makeDeps({
      connectors: jest.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === 'c-sales' ? 'Sales DB EU' : 'Sales DB US', hasGuide: false })),
      ),
    });
    const { client } = await connect([...SALES_DB, ...other], deps);
    const { isError, body } = await call(client, 'anythingmcp_query_database', { database: 'sales', query: 'SELECT 1' });
    expect(isError).toBe(true);
    expect(body.databases.map((d: any) => d.id).sort()).toEqual(['c-sales', 'c-sales2']);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('lists connectors with their type and setup links, leaving out payment connectors', async () => {
    const { client } = await connect([...SALES_DB, CRM_READ, CRM_PENDING, WISE_PAY]);
    const { body, text } = await call(client, 'anythingmcp_list_connectors');
    expect(body.connectors).toEqual([
      { id: 'c-crm', name: 'Acme CRM', type: 'rest', hasNotes: false },
      { id: 'c-sales', name: 'Sales DB', type: 'database', queryableHere: true, hasNotes: true },
    ]);
    expect(body.needsSetup).toEqual([
      expect.objectContaining({ id: 'c-shop', finishSetupUrl: 'https://cloud.example.com/connectors/c-shop' }),
    ]);
    expect(text).not.toMatch(/Wise/);
  });

  it('reports activity per connector in scope, counts only', async () => {
    const { client, deps } = await connect([...SALES_DB, CRM_READ]);
    const { body } = await call(client, 'anythingmcp_get_connector_activity', { days: 30 });
    expect(deps.activity).toHaveBeenCalledWith(expect.arrayContaining(['c-sales', 'c-crm']), 30);
    expect(body.days).toBe(30);
    expect(body.connectors).toEqual([
      {
        id: 'c-sales',
        name: 'Sales DB',
        calls: 12,
        failedCalls: 2,
        lastCallAt: '2026-10-23T10:00:00.000Z',
        lastFailureAt: '2026-10-22T09:00:00.000Z',
      },
      { id: 'c-crm', name: 'Acme CRM', calls: 0, failedCalls: 0, lastCallAt: null, lastFailureAt: null },
    ]);
  });

  it('defaults activity to seven days and skips the lookup with no connectors', async () => {
    const withScope = await connect([CRM_READ]);
    await call(withScope.client, 'anythingmcp_get_connector_activity');
    expect(withScope.deps.activity).toHaveBeenCalledWith(['c-crm'], 7);
    const empty = await connect([]);
    const { body } = await call(empty.client, 'anythingmcp_get_connector_activity');
    expect(empty.deps.activity).not.toHaveBeenCalled();
    expect(body.connectors).toEqual([]);
  });

  it('returns the workspace notes and the dashboard link without server URLs', async () => {
    const { client, deps } = await connect([...SALES_DB]);
    const guide = await call(client, 'anythingmcp_get_workspace_guide', { connector: 'Sales DB' });
    expect(guide.text).toContain('Amounts are in cents.');
    expect(deps.guide).toHaveBeenCalledWith(['c-sales'], false);
    const cfg = await call(client, 'anythingmcp_get_configuration_url');
    expect(cfg.body.dashboardUrl).toBe('https://cloud.example.com/connectors');
    expect(cfg.text).not.toMatch(/\/mcp\//);
  });

  it('tells the user where to start when nothing is connected', async () => {
    const { client } = await connect([]);
    const connectors = await call(client, 'anythingmcp_list_connectors');
    expect(connectors.body.hint).toMatch(/anythingmcp_get_configuration_url/);
    const databases = await call(client, 'anythingmcp_list_databases');
    expect(databases.body.hint).toMatch(/dashboard/);
  });
});

describe('databaseEngine', () => {
  it.each([
    ['postgresql://u:p@h/db', 'PostgreSQL'],
    ['mysql://u:p@h/db', 'MySQL'],
    ['mariadb://u:p@h/db', 'MariaDB'],
    ['sqlserver://h;database=x', 'SQL Server'],
    ['oracle://u:p@h/x', 'Oracle'],
    ['hana://h:30015', 'SAP HANA'],
    ['sqlite:/data/app.db', 'SQLite'],
    ['mongodb+srv://u:p@cluster/x', 'MongoDB'],
  ])('%s → %s', (url, engine) => {
    expect(databaseEngine(url)).toBe(engine);
  });
});
