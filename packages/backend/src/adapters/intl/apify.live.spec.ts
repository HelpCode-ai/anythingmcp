import * as adapter from './apify.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
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
    expect(byMethod['apify--web-fetch']).toBe('apify_web_fetch');
    expect(byMethod['apify--web-search']).toBe('apify_web_search');
    expect(byMethod['send-server-actor-request']).toBe('apify_send_server_actor_request');
  });

  it("lists the server's default tool set (server 0.21), without add-actor or the RAG Web Browser", () => {
    expect(a.tools.map((t) => t.endpointMapping.method).sort()).toEqual(
      [
        'search-actors',
        'fetch-actor-details',
        'call-actor',
        'get-actor-run',
        'get-dataset-items',
        'get-key-value-store-record',
        'abort-actor-run',
        'fetch-actor-mcp-tool-list',
        'call-actor-mcp-tool',
        'send-server-actor-request',
        'search-apify-docs',
        'fetch-apify-docs',
        'report-problem',
        'apify--web-search',
        'apify--web-fetch',
      ].sort(),
    );
    // Apify dropped apify--rag-web-browser in 0.21; it is now reached through
    // send-server-actor-request like any other Server Actor.
    expect(a.tools.some((t) => /rag/.test(t.name) || /rag-web-browser/.test(t.endpointMapping.method))).toBe(false);
  });

  it('takes web fetch and web search as an HTTP request to the Actor server', () => {
    // Since 0.21 both are served through the Actor's server interface: the
    // old flat {url} / {query} arguments fail with -32602 "must have required
    // property 'method'".
    for (const name of ['apify_web_fetch', 'apify_web_search']) {
      const t = a.tools.find((x) => x.name === name)!;
      expect(t.parameters?.required).toEqual(['method', 'path']);
      expect(Object.keys(t.parameters?.properties ?? {}).sort()).toEqual(['body', 'method', 'path', 'query']);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    const send = a.tools.find((x) => x.name === 'apify_send_server_actor_request')!;
    expect(send.parameters?.required).toEqual(['actor', 'method', 'path']);
    expect(a.instructions).toContain('"query": {"url": "https://example.com", "formats": ["markdown"]}');
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
    expect(destructiveOn).toEqual(
      ['abort-actor-run', 'call-actor', 'call-actor-mcp-tool', 'send-server-actor-request'].sort(),
    );
  });

  it('installs from discovery under the same names, with report-problem still off', () => {
    // What an install (or "Discover from MCP Server") stores when the server
    // lists exactly this snapshot: the remote names come back prefixed, the
    // call stays on the remote name at "/", and the catalog policy holds.
    const discovered = a.tools.map((t) => ({
      name: t.endpointMapping.method,
      description: t.description,
      parameters: (t.parameters ?? {}) as Record<string, unknown>,
      endpointMapping: { method: t.endpointMapping.method, path: '/' },
      outputSchema: null,
      annotations: t.annotations ?? null,
    }));
    const merged = mergeDiscoveredMcpTools(a.tools as never, discovered, a.connector.config.mcpToolPrefix);
    expect(merged.map((t) => t.name)).toEqual(a.tools.map((t) => t.name));
    expect(merged.map((t) => t.endpointMapping)).toEqual(a.tools.map((t) => t.endpointMapping));
    expect(merged.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['apify_report_problem']);
  });

  it('warns about credits, call-actor and the fixed default tool set', () => {
    expect(a.instructions).toContain('credits');
    expect(a.instructions).toContain('`apify_call_actor` can run **any** Actor');
    expect(a.instructions).toContain('?tools=');
    expect(a.instructions).toContain('**Discover from MCP Server**');
    expect(a.instructions).not.toMatch(/rag_web_browser|RAG Web Browser/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
