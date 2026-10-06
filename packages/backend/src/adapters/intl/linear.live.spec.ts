import * as adapter from './linear.json';
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

describe('linear adapter: static spec conformance', () => {
  it("bridges Linear's official MCP server with the API key as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.linear.app/mcp');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{LINEAR_API_KEY}}' });
    expect(a.connector.config.mcpToolPrefix).toBe('linear_');
    expect(a.requiredEnvVars).toEqual(['LINEAR_API_KEY']);
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
    expect([...names]).toEqual(expect.arrayContaining(['linear_list_issues', 'linear_get_issue', 'linear_save_issue', 'linear_save_comment']));
  });

  it('ships the destructive tools switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(
      expect.arrayContaining([
        'delete_attachment',
        'delete_comment',
        'delete_diff_comment',
        'delete_status_update',
        'merge_diff',
        'retire_initiative_label',
        'retire_issue_label',
        'retire_project_label',
        'share_issue',
        'unshare_issue',
      ]),
    );
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
    for (const t of a.tools.filter((x) => /^(delete|retire)_/.test(x.endpointMapping.method))) {
      expect(t.enabled).toBe(false);
    }
  });

  it('points to the read-only endpoint and says whose identity the key carries', () => {
    expect(a.instructions).toContain('https://mcp.linear.app/mcp/readonly');
    expect(a.instructions).toMatch(/acts as the Linear user who created it/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
