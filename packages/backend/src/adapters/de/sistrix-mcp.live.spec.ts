import * as adapter from './sistrix-mcp.json';
import * as rest from './sistrix.json';
import { needsBrowserAuthorization } from '../env-var-meta';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';

/**
 * SISTRIX's official MCP server (https://api.sistrix.com/mcp). Static: the
 * server lists its tools only after an OAuth sign-in. Checked on 20 Oct 2026
 * from the Cloud backend: POST /mcp answers 401 with
 * WWW-Authenticate resource_metadata=.../.well-known/oauth-protected-resource/mcp;
 * that document names the authorization server https://api.sistrix.com/mcp
 * with scope "sistrix", whose metadata offers dynamic client registration
 * (/mcp/register), authorization_code with PKCE S256 and client_secret_post.
 * The snapshot's tool names follow SISTRIX's view-parameter surface; the
 * live list replaces it at sign-in.
 */
type Tool = { name: string; endpointMapping: { method: string; path: string }; annotations?: Record<string, boolean>; enabled?: boolean };
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  connector: { type: string; baseUrl: string; authType: string; config: { mcpToolPrefix: string; mcpOAuth: { registration: string } } };
  tools: Tool[];
};

describe('sistrix-mcp adapter: static spec conformance', () => {
  it('bridges the official server with OAuth and dynamic client registration', () => {
    expect(a.connector).toEqual({
      name: 'SISTRIX (MCP server)',
      type: 'MCP',
      baseUrl: 'https://api.sistrix.com/mcp',
      authType: 'OAUTH2',
      config: { mcpToolPrefix: 'sistrix_mcp_', mcpOAuth: { registration: 'dcr' } },
    });
    expect(a.requiredEnvVars).toEqual([]);
    expect(needsBrowserAuthorization(a as never)).toBe(true);
  });

  it('names every tool <prefix><remote name> and keeps them read-only', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(`sistrix_mcp_${t.endpointMapping.method}`);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.enabled).toBeUndefined();
    }
  });

  it('does not collide with the REST adapter and says which one to pick', () => {
    const restNames = new Set((rest as unknown as { tools: Tool[] }).tools.map((t) => t.name));
    for (const t of a.tools) expect(restNames.has(t.name)).toBe(false);
    expect(a.instructions).toMatch(/no API key and no API credits/);
    expect(a.instructions).toMatch(/`sistrix`/);
  });

  it('takes the server list at sign-in and keeps local names', () => {
    const merged = mergeDiscoveredMcpTools(
      a.tools as never,
      [
        { name: 'domain', description: 'live', parameters: { type: 'object' }, endpointMapping: { method: 'domain', path: '/mcp' } },
        { name: 'new_dataset', description: 'new', parameters: { type: 'object' }, endpointMapping: { method: 'new_dataset', path: '/mcp' } },
      ] as never,
      a.connector.config.mcpToolPrefix,
    );
    expect(merged.map((t) => t.name)).toEqual(['sistrix_mcp_domain', 'sistrix_mcp_new_dataset']);
    expect(merged[0].annotations).toMatchObject({ readOnlyHint: true });
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});
