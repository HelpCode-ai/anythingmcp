import * as adapter from './odoo-mcp.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';

/**
 * Static conformance of the Odoo (MCP server) adapter: a bridge to the MCP
 * endpoint Odoo serves itself at <database>/mcp (Odoo AI, Odoo Online
 * saas-19.4 and Odoo 20), authorised with an Odoo API key of scope MCP sent
 * as a Bearer token.
 *
 * Verified on 19 Oct 2026 against an Odoo Online database: tools/list
 * answered with the five tools exposed there, and Search, Get Fields, Get
 * Models and Read group answered read-only calls. The live check needs an
 * Odoo key and is not repeated here.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  verifyHints: Record<string, unknown>;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, string>; config: { mcpToolPrefix: string; mcpPath?: string; mcpOAuth?: unknown } };
  tools: Tool[];
};

describe('odoo-mcp adapter: static spec conformance', () => {
  it("bridges Odoo's own /mcp endpoint with an API key as a Bearer token", () => {
    expect(a.slug).toBe('odoo-mcp');
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('{{ODOO_URL}}/mcp');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{ODOO_MCP_API_KEY}}' });
    expect(a.connector.config.mcpToolPrefix).toBe('odoo_mcp_');
    expect(a.connector.config.mcpPath).toBeUndefined();
    // Odoo's authorization server has no dynamic registration, so no OAuth here.
    expect(a.connector.config.mcpOAuth).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['ODOO_URL', 'ODOO_MCP_API_KEY']);
  });

  it('accepts the database address up to the host, and a 40-hex Odoo API key', () => {
    const url = new RegExp(a.envVarMeta.ODOO_URL.pattern!);
    for (const ok of ['https://mycompany.odoo.com', 'https://erp.example.com']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://mycompany.odoo.com/', 'https://mycompany.odoo.com/mcp', 'https://www.odoo.com', 'http://mycompany.odoo.com', 'mycompany.odoo.com']) {
      expect(url.test(bad)).toBe(false);
    }
    const key = new RegExp(a.envVarMeta.ODOO_MCP_API_KEY.pattern!);
    expect(key.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(key.test('Bearer 0123456789abcdef0123456789abcdef01234567')).toBe(false);
    expect(a.envVarMeta.ODOO_MCP_API_KEY.secret).toBe(true);
    expect(a.envVarMeta.ODOO_URL.kind).toBe('address');
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
    }
    expect(a.tools.map((t) => t.endpointMapping.method)).toEqual([
      'ai_tool_mcp_retrieve_initial_context',
      'ai_tool_get_models',
      'ai_tool_get_fields',
      'ai_tool_search',
      'ai_tool_read_group',
      'ai_tool_create_records',
      'ai_tool_update_records',
    ]);
  });

  it('keeps the names apart from the two Odoo REST adapters', () => {
    for (const t of a.tools) expect(t.name.startsWith('odoo_mcp_')).toBe(true);
  });

  it('ships create and update switched off, also when the server exposes them', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method)).toEqual([
      'ai_tool_create_records',
      'ai_tool_update_records',
    ]);
    for (const t of a.tools.filter((x) => x.enabled !== false)) expect(t.annotations?.readOnlyHint).toBe(true);
    // The tools/list of the verified database, as the bridge discovers it.
    const discovered = ['ai_tool_create_records', 'ai_tool_get_fields', 'ai_tool_get_models', 'ai_tool_read_group', 'ai_tool_search'].map((name) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      endpointMapping: { method: name, path: '/mcp' },
    }));
    const installed = mergeDiscoveredMcpTools(a.tools as never, discovered as never, a.connector.config.mcpToolPrefix);
    expect(installed.map((t) => `${t.name}${t.enabled === false ? ' off' : ''}`)).toEqual([
      'odoo_mcp_ai_tool_create_records off',
      'odoo_mcp_ai_tool_get_fields',
      'odoo_mcp_ai_tool_get_models',
      'odoo_mcp_ai_tool_read_group',
      'odoo_mcp_ai_tool_search',
    ]);
  });

  it('explains when to pick this connector and the two Odoo REST ones', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1200);
    for (const s of ['Which Odoo connector?', '`odoo`', '`odoo-jsonrpc`', 'saas-19.4', 'Odoo 20', 'Scope', 'MCP', 'Available in MCP', 'Discover tools', 'include_description']) {
      expect(a.instructions).toContain(s);
    }
    expect(a.prerequisites).toMatch(/MCP scope/);
    expect(a.verifyHints.not_found).toMatchObject({ suggest: 'odoo' });
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of a.instructions.matchAll(/\bodoo_mcp_[a-z_]+/g)) expect(names).toContain(m[0]);
  });

  it('asks Get Fields for both arguments Odoo needs, though its server lists none', () => {
    const t = a.tools.find((x) => x.endpointMapping.method === 'ai_tool_get_fields')!;
    expect(t.parameters.required).toEqual(['model_name', 'include_description']);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});
