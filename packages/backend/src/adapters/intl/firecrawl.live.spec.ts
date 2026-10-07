import * as adapter from './firecrawl.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string }> };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern: string }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};

describe('firecrawl adapter: static spec conformance', () => {
  it("bridges Firecrawl's official MCP server with the API key as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.firecrawl.dev/v2/mcp');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{FIRECRAWL_API_KEY}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'firecrawl_' });
    expect(new RegExp(a.envVarMeta.FIRECRAWL_API_KEY.pattern).test('fc-' + '0a'.repeat(16))).toBe(true);
  });

  it('keeps the remote names, which already carry the prefix', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name).toBe(t.endpointMapping.method);
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
    }
    expect(a.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['firecrawl_scrape', 'firecrawl_search', 'firecrawl_parse', 'firecrawl_map', 'firecrawl_crawl', 'firecrawl_agent']),
    );
  });

  it('describes every top-level parameter', () => {
    for (const t of a.tools) {
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
  });

  it('ships monitor changes and feedback switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual([
      'firecrawl_feedback',
      'firecrawl_monitor_create',
      'firecrawl_monitor_delete',
      'firecrawl_monitor_update',
      'firecrawl_search_feedback',
    ]);
    // Firecrawl marks interact_stop destructive, but it only ends the caller's own
    // browser session (and stops it spending credits), so it stays on.
    const destructiveOn = a.tools
      .filter((t) => t.annotations?.destructiveHint === true && t.enabled !== false)
      .map((t) => t.name);
    expect(destructiveOn).toEqual(['firecrawl_interact_stop']);
  });

  it('mentions credits in the instructions', () => {
    expect(a.instructions).toContain('credits');
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
