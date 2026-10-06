import * as adapter from './apify.json';
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

describe('apify adapter: static spec conformance', () => {
  it("bridges Apify's official MCP server at the host root with the token as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.apify.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{APIFY_TOKEN}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'apify_', mcpPath: '/' });
    expect(new RegExp(a.envVarMeta.APIFY_TOKEN.pattern).test('apify_api_' + 'Ab1'.repeat(12))).toBe(true);
  });

  it('names each tool with the prefix and calls it by its remote name at the root path', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/');
    }
    const byMethod = Object.fromEntries(a.tools.map((t) => [t.endpointMapping.method, t.name]));
    expect(byMethod['search-actors']).toBe('apify_search_actors');
    expect(byMethod['apify--rag-web-browser']).toBe('apify_rag_web_browser');
  });

  it("lists the server's default tool set, without add-actor", () => {
    expect(a.tools.map((t) => t.endpointMapping.method).sort()).toEqual(
      [
        'search-actors',
        'fetch-actor-details',
        'call-actor',
        'apify--rag-web-browser',
        'apify--web-fetch',
        'get-actor-run',
        'get-dataset-items',
        'get-key-value-store-record',
        'abort-actor-run',
        'search-apify-docs',
        'fetch-apify-docs',
        'report-problem',
      ].sort(),
    );
  });

  it('ships only report-problem switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(['report-problem']);
    // Apify marks every Actor run destructive (it spends credits) and abort as
    // destructive; running Actors is what the connector is for, so these stay on
    // and the instructions spell out the credit cost.
    const destructiveOn = a.tools
      .filter((t) => t.annotations?.destructiveHint === true && t.enabled !== false)
      .map((t) => t.endpointMapping.method)
      .sort();
    expect(destructiveOn).toEqual(['abort-actor-run', 'apify--rag-web-browser', 'apify--web-fetch', 'call-actor']);
  });

  it('warns about credits, call-actor and the fixed default tool set', () => {
    expect(a.instructions).toContain('credits');
    expect(a.instructions).toContain('`apify_call_actor` can run **any** Actor');
    expect(a.instructions).toContain('?tools=');
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
