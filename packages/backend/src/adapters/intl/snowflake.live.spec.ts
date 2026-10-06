import * as adapter from './snowflake.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    headers?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};

describe('snowflake adapter: static spec conformance', () => {
  it("bridges the Snowflake-managed MCP server with a PAT as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe(
      'https://{{SNOWFLAKE_ACCOUNT_HOST}}/api/v2/databases/{{SNOWFLAKE_DATABASE}}/schemas/{{SNOWFLAKE_SCHEMA}}/mcp-servers/{{SNOWFLAKE_MCP_SERVER}}',
    );
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SNOWFLAKE_PAT}}' });
    expect(a.connector.headers).toEqual({
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    });
    expect(a.connector.config.mcpToolPrefix).toBe('snowflake_');
    expect(a.connector.config.mcpPath).toBeUndefined();
  });

  it('accepts account hosts with hyphens and refuses underscores and https://', () => {
    const host = new RegExp(a.envVarMeta.SNOWFLAKE_ACCOUNT_HOST.pattern as string);
    expect(host.test('myorg-myaccount.snowflakecomputing.com')).toBe(true);
    expect(host.test('xy12345.eu-central-1.snowflakecomputing.com')).toBe(true);
    expect(host.test('myorg-my-account.privatelink.snowflakecomputing.com')).toBe(true);
    expect(host.test('myorg-my_account.snowflakecomputing.com')).toBe(false);
    expect(host.test('https://myorg-myaccount.snowflakecomputing.com')).toBe(false);
    expect(host.test('myorg-myaccount.snowflakecomputing.com/')).toBe(false);
    expect(a.envVarMeta.SNOWFLAKE_PAT.secret).toBe(true);
    for (const v of ['SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA', 'SNOWFLAKE_MCP_SERVER']) {
      expect(a.envVarMeta[v].kind).toBe('setting');
    }
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.description).toMatch(/^Example of the [A-Z_]+ tool type/);
    }
    expect(a.tools.map((t) => t.endpointMapping.method)).toEqual([
      'business_data_agent',
      'revenue-semantic-view',
      'product-search',
      'sql_exec_tool',
      'my_custom_tool',
    ]);
  });

  it('ships the SQL execution example switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(['sql_exec_tool']);
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });

  it('explains the server object, grants, PAT, network policy and limits', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1200);
    for (const s of [
      'CREATE OR REPLACE MCP SERVER',
      'GRANT USAGE ON MCP SERVER',
      'ROLE_RESTRICTION',
      'DAYS_TO_EXPIRY',
      'NETWORK RULE',
      'underscores',
      '250 KB',
      '50',
      'Discover tools',
    ]) {
      expect(a.instructions).toContain(s);
    }
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
