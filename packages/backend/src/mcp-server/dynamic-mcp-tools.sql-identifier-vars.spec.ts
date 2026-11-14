import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';

/**
 * A DATABASE connector that lists its table-name variables
 * (config.sqlIdentifierVars) has them checked on the MCP call path before
 * {{VAR}} becomes SQL text. Without the list the call is what it always was.
 */

const SQL = 'SELECT o.order_id FROM `{{OPENCART_DB_PREFIX}}order` o WHERE o.order_id = ${order_id}';

function makeTool(prefix: string, config?: Record<string, unknown>): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    name: 'opencart_get_order',
    description: 'One order',
    parameters: { type: 'object', properties: { order_id: { type: 'integer' } }, required: ['order_id'] },
    connectorType: 'DATABASE',
    connectorConfig: {
      baseUrl: 'mysql://shop.example.com:3306/shop',
      authType: 'CONNECTION_STRING',
      envVars: { OPENCART_DB_PREFIX: prefix },
      config,
    },
    endpointMapping: { method: 'query', path: SQL },
  };
}

function build(tool: RegisteredTool) {
  const databaseEngine = { execute: jest.fn().mockResolvedValue({ rows: [], totalRows: 0 }) };
  const unexpected = (name: string) => ({ execute: jest.fn().mockRejectedValue(new Error(`Unexpected ${name} call`)) });
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() } as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    unexpected('REST') as any,
    unexpected('GraphQL') as any,
    unexpected('SOAP') as any,
    unexpected('MCP') as any,
    databaseEngine as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    unexpected('OData') as any,
  );
  return { executor, databaseEngine };
}

const GUARDED = { sqlIdentifierVars: ['OPENCART_DB_PREFIX'], deniedTables: ['*user'] };

describe('DynamicMcpTools: table-name variables of a DATABASE connector', () => {
  it('fills a safe prefix into the SQL and leaves the value to be bound', async () => {
    const { executor, databaseEngine } = build(makeTool('oc_', GUARDED));
    const res = await executor.executeTool('opencart_get_order', { order_id: 7 });
    expect(res.isError).toBeUndefined();
    expect(databaseEngine.execute).toHaveBeenCalledTimes(1);
    const [, mapping, params, options] = databaseEngine.execute.mock.calls[0];
    expect(mapping.path).toBe('SELECT o.order_id FROM `oc_order` o WHERE o.order_id = ${order_id}');
    expect(params.order_id).toBe(7);
    expect(options).toEqual({ readOnly: true, deniedTables: ['*user'] });
  });

  it.each(["oc_' OR '1'='1", 'oc_`; DROP TABLE x', 'oc_ user', 'oc_;'])(
    'refuses the prefix %p without calling the database',
    async (prefix) => {
      const { executor, databaseEngine } = build(makeTool(prefix, GUARDED));
      const res = await executor.executeTool('opencart_get_order', { order_id: 7 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('OPENCART_DB_PREFIX is used as part of a table name');
      expect(res.content[0].text).toContain('No query was sent to the database');
      expect(databaseEngine.execute).not.toHaveBeenCalled();
    },
  );

  it('changes nothing for a connector without the list', async () => {
    const value = 'legacy.schema_';
    const { executor, databaseEngine } = build(makeTool(value, { deniedTables: ['*user'] }));
    const res = await executor.executeTool('opencart_get_order', { order_id: 7 });
    expect(res.isError).toBeUndefined();
    expect(databaseEngine.execute.mock.calls[0][1].path).toBe(
      'SELECT o.order_id FROM `legacy.schema_order` o WHERE o.order_id = ${order_id}',
    );
  });

  it('changes nothing for a connector without any config', async () => {
    const { executor, databaseEngine } = build(makeTool('x y', undefined));
    const res = await executor.executeTool('opencart_get_order', { order_id: 7 });
    expect(res.isError).toBeUndefined();
    expect(databaseEngine.execute.mock.calls[0][1].path).toContain('`x yorder`');
  });
});
