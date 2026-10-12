import * as adapter from './tradingview.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { type: string; required?: string[]; properties: Record<string, unknown> };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  name: string;
  category: string;
  unlisted?: boolean;
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
const tool = (method: string) => a.tools.find((t) => t.endpointMapping.method === method)!;

describe('tradingview adapter: static spec conformance', () => {
  it('is unlisted until verified live', () => {
    expect(a.unlisted).toBe(true);
    expect(a.name).toBe('TradingView');
    expect(a.category).toBe('finance');
  });

  it("bridges TradingView's official MCP server with OAuth and dynamic client registration", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.tradingview.com/mcp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.config.mcpToolPrefix).toBe('tradingview_');
    expect(a.connector.config.mcpPath).toBeUndefined();
    expect(a.connector.config.mcpOAuth).toEqual({ registration: 'dcr' });
  });

  it('asks for no key: the user signs in with a paid TradingView plan after saving', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(Object.keys(a.envVarMeta ?? {})).toEqual([]);
    expect(a.prerequisites).toMatch(/sign in with TradingView/i);
    expect(a.prerequisites).toMatch(/Essential/);
    expect(a.prerequisites).toMatch(/trial/);
    expect(a.instructions).toMatch(/dynamic client registration/);
    expect(a.instructions).toMatch(/no API key, client id or secret/);
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    expect(a.tools).toHaveLength(35);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(40);
      expect(t.parameters.type).toBe('object');
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(tool('search_symbols').name).toBe('tradingview_search_symbols');
  });

  it('ships deletes and symbol removal switched off, and only those', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(['delete_alert', 'delete_watchlist', 'remove_from_watchlist']);
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });

  it('marks market data and research read-only, and watchlist and alert changes as writes', () => {
    for (const m of ['search_symbols', 'get_ohlcv', 'run_screener', 'get_news_story', 'get_document_view', 'list_alerts']) {
      expect(tool(m).annotations?.readOnlyHint).toBe(true);
      expect(tool(m).enabled).not.toBe(false);
    }
    for (const m of ['create_watchlist', 'add_to_watchlist', 'update_watchlist', 'create_alert', 'update_alert', 'stop_alerts', 'restart_alerts']) {
      expect(tool(m).annotations?.readOnlyHint).toBe(false);
      expect(tool(m).annotations?.destructiveHint).toBe(false);
      expect(tool(m).enabled).not.toBe(false);
    }
    expect(a.tools.filter((t) => t.annotations?.readOnlyHint === true)).toHaveLength(25);
  });

  it('explains the shared identity, the beta limits and the safety defaults', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    expect(a.instructions).toMatch(/every caller/);
    expect(a.instructions).toMatch(/100 a minute/);
    expect(a.instructions).toMatch(/delayed market data/);
    expect(a.instructions).toMatch(/Discover tools/);
    expect(a.instructions).toMatch(/EXCHANGE:TICKER/);
    expect(a.instructions).toMatch(/not as investment advice/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});
