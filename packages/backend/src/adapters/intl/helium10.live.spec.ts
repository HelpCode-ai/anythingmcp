import * as adapter from './helium10.json';
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
  prerequisites: string[];
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string; mcpOAuth?: { registration?: string } };
  };
  tools: Tool[];
};

describe('helium10 adapter: static spec conformance', () => {
  it("bridges Helium 10's official MCP server with OAuth and dynamic client registration", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.helium10.com/mcp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.config.mcpToolPrefix).toBe('helium10_');
    expect(a.connector.config.mcpOAuth).toEqual({ registration: 'dcr' });
  });
  it('asks for no key: the user signs in with Helium 10 after saving', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(Object.keys(a.envVarMeta ?? {})).toEqual([]);
    expect(a.prerequisites.some((p) => /sign in with Helium 10/i.test(p))).toBe(true);
    expect(a.prerequisites.some((p) => /Diamond/.test(p))).toBe(true);
  });
  it('names each tool with the prefix and calls it by its remote name', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });
  it('ships listing pushes, ad changes and deletes switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(
      expect.arrayContaining([
        'sync_listing_to_amazon',
        'execute_ads_campaign_mgmt_actions',
        'manage_ads_rule',
        'delete_amazon_cogs',
        'delete_amazon_indirect_costs',
        'delete_wmt_cogs',
        'delete_wmt_indirect_costs',
        'delete_tracked_keywords',
        'delete_tracked_product',
        'remove_keyword_note',
      ]),
    );
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });
  it('keeps every read-only research tool switched on', () => {
    for (const t of a.tools.filter((x) => x.annotations?.readOnlyHint === true)) {
      expect(t.enabled).not.toBe(false);
    }
  });
  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
