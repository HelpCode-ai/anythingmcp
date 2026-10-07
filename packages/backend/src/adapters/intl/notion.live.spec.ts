import * as adapter from './notion.json';
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
  envVarMeta?: Record<string, unknown>;
  prerequisites?: string;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string; mcpOAuth?: { registration?: string } };
  };
  tools: Tool[];
};

describe('notion adapter: static spec conformance', () => {
  it("bridges Notion's official MCP server with OAuth and dynamic client registration", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.notion.com/mcp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.config.mcpToolPrefix).toBe('notion_');
    expect(a.connector.config.mcpOAuth).toEqual({ registration: 'dcr' });
  });
  it('asks for no key: the user signs in with Notion after saving', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(Object.keys(a.envVarMeta ?? {})).toEqual([]);
    expect(/sign in with Notion/i.test(a.prerequisites ?? '')).toBe(true);
  });
  it('names each tool with the prefix and calls it by its remote name', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
    }
    // The prefix is not doubled: notion-search becomes notion_search.
    expect(a.tools.map((t) => t.name)).toContain('notion_search');
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });
  it('ships moves, schema changes and autonomous agents switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(
      ['notion-move-pages', 'notion-send-message-to-session', 'notion-spawn-session', 'notion-update-data-source'].sort(),
    );
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });
  it('explains the shared identity and the token lifetimes', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1200);
    expect(a.instructions).toMatch(/every caller/);
    expect(a.instructions).toMatch(/180 days/);
    expect(a.instructions).toMatch(/30 days/);
    expect(a.instructions).toMatch(/ntn_/);
    expect(a.instructions).toMatch(/Settings > Connections/);
  });
  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
