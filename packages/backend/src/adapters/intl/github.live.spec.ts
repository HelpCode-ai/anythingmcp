import * as adapter from './github.json';
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
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};

describe('github adapter: static spec conformance', () => {
  it("bridges GitHub's official remote MCP server with the PAT as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://api.githubcopilot.com/mcp/');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GITHUB_PAT}}' });
    expect(a.connector.config.mcpToolPrefix).toBe('github_');
    expect(a.requiredEnvVars).toEqual(['GITHUB_PAT']);
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    const names = new Set<string>();
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      names.add(t.name);
    }
    expect(names.size).toBe(a.tools.length);
    expect([...names]).toEqual(
      expect.arrayContaining(['github_get_me', 'github_get_file_contents', 'github_issue_read', 'github_pull_request_read', 'github_search_users']),
    );
  });

  it('ships the destructive tools switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(
      expect.arrayContaining(['merge_pull_request', 'delete_file', 'push_files', 'create_or_update_file', 'delete_repository']),
    );
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });

  it('explains token scopes, org approval, Copilot policy, EMU and the toolset headers', () => {
    for (const s of ['Fine-grained tokens', 'approve the token', 'MCP servers in Copilot', 'Enterprise Managed Users', 'X-MCP-Toolsets', 'X-MCP-Readonly: true', 'Discover tools']) {
      expect(a.instructions).toContain(s);
    }
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
