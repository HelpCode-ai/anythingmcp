import * as adapter from './cohesivity.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { McpClientEngine } from '../../connectors/engines/mcp-client.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';

/** Live: RUN_COHESIVITY_LIVE=1 npx jest src/adapters/intl/cohesivity.live.spec.ts */

type Tool = {
  name: string;
  enabled?: boolean;
  endpointMapping: { method: string; path: string };
};
const a = adapter as unknown as {
  instructions: string;
  category: string;
  requiredEnvVars: string[];
  connector: { type: string; baseUrl: string; authType: string; config: { mcpToolPrefix: string } };
  tools: Tool[];
};
const remoteNames = [
  'get_cohesivity_documentation',
  'create_tenant',
  'provision_resource',
  'tenant_status',
  'claim_tenant',
  'give_feedback',
];

describe('cohesivity adapter: static spec conformance', () => {
  it("bridges Cohesivity's hosted MCP server with no credentials", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://cohesivity.ai/mcp');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'cohesivity_' });
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.category).toBe('infrastructure');
  });

  it('names each tool with the prefix and calls it by its remote name on /mcp', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
    }
    expect(a.tools.map((t) => t.endpointMapping.method).sort()).toEqual([...remoteNames].sort());
  });

  it('ships the feedback tool switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method)).toEqual(['give_feedback']);
  });

  it('documents the tenant keys, the audit log and the creation rate limit in the instructions', () => {
    expect(a.instructions).toContain('audit log');
    expect(a.instructions).toContain('72 hours');
    expect(a.instructions).toContain('10 calls per 60 seconds');
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

// Read-only on purpose: every create_tenant call creates a tenant and counts
// against the per-IP creation limit.
const maybe = process.env.RUN_COHESIVITY_LIVE ? describe : describe.skip;
maybe('cohesivity adapter - live', () => {
  const engine = new McpClientEngine({} as OAuth2TokenService);
  const config = { baseUrl: a.connector.baseUrl, authType: 'NONE' };

  it('lists every tool of the snapshot without credentials', async () => {
    const tools = await engine.listTools(config);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(remoteNames));
  }, 30000);

  it('reads the offerings catalog without a tenant', async () => {
    const doc = a.tools.find((t) => t.endpointMapping.method === 'get_cohesivity_documentation')!;
    const res: any = await engine.execute(config, doc.endpointMapping, { document: 'offerings' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('postgres');
  }, 30000);
});
