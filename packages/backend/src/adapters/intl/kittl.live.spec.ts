import * as adapter from './kittl.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks for the Kittl MCP bridge. Kittl's server lists its tools
 * only after an OAuth sign-in, so the catalog ships the tools named on
 * Kittl's MCP page (https://www.kittl.com/mcp) as a snapshot; the server's
 * own list replaces it at authorization. Verified on 20 Oct 2026: the
 * protected-resource and authorization-server metadata, dynamic client
 * registration with the Cloud callback, and a 401 with resource_metadata
 * from /mcp without a token.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { type: string; required?: string[]; properties: Record<string, unknown> };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  category: string;
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

const SPENDS_CREDITS = ['generate-media', 'remove-image-background', 'render-mockup', 'run-ai-workflow', 'upscale-image', 'vectorize-image'];

describe('kittl adapter: static spec conformance', () => {
  it("bridges Kittl's official MCP server with OAuth and dynamic client registration", () => {
    expect(a.name).toBe('Kittl');
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.kittl.com/mcp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'kittl_', mcpOAuth: { registration: 'dcr' } });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
  });

  it('asks for no key: the user signs in with Kittl after saving', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(Object.keys(a.envVarMeta ?? {})).toEqual([]);
    expect(a.prerequisites).toMatch(/sign in with Kittl/);
    expect(a.instructions).toMatch(/dynamic client registration/);
    expect(a.instructions).toMatch(/no API key, client id or secret/);
  });

  it('names each tool with the prefix and calls it by its remote (hyphenated) name', () => {
    expect(a.tools).toHaveLength(8);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.endpointMapping.method).toMatch(/^[a-z]+(-[a-z]+)+$/);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.parameters.type).toBe('object');
      expect(t.description.length).toBeGreaterThanOrEqual(40);
    }
    expect(tool('generate-media').name).toBe('kittl_generate_media');
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });

  it('says that generations spend Kittl credits and need a yes, in the instructions and on each tool', () => {
    expect(a.instructions).toMatch(/Kittl credits/);
    expect(a.instructions).toMatch(/wait for a yes/);
    expect(a.instructions).toMatch(/Never start several generations in a loop/);
    for (const m of SPENDS_CREDITS) {
      expect(tool(m).description).toMatch(/credits/i);
      expect(tool(m).annotations?.readOnlyHint).toBe(false);
    }
    expect(tool('list-ai-workflow-presets').annotations?.readOnlyHint).toBe(true);
    expect(a.tools.filter((t) => t.annotations?.destructiveHint === true)).toHaveLength(0);
  });

  it('explains whose account and credits are used, and how to pick up new tools', () => {
    expect(a.instructions).toMatch(/every caller/);
    expect(a.instructions).toMatch(/Discover tools/);
  });

  it('shares no tool name with another adapter and uses no em or en dashes', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});
