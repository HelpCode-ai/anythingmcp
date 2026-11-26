import * as adapter from './poyo.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';
import { getAdapter, listAdapters } from '../catalog';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
  omitParameters?: string[];
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret: boolean; pattern: string }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const PAID = ['poyo_chat', 'poyo_run_model', 'poyo_submit_job'];

// Static checks only. PoYo's server lists its tools without a key; calling
// any tool that runs a model spends credits, so nothing here goes live.
describe('poyo adapter: static MCP bridge conformance', () => {
  it('is listed under intl/data with its own icon', () => {
    expect(a.slug).toBe('poyo');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('data');
    expect(a.icon).toBe('poyo');
    expect(getAdapter('poyo')).toBeDefined();
  });

  it("bridges PoYo's official MCP server with the API key as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://api.poyo.ai/mcp');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{POYO_API_KEY}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'poyo_' });
    expect(a.requiredEnvVars).toEqual(['POYO_API_KEY']);
    expect('probe' in adapter).toBe(false);
  });

  it('asks for the key as a secret and refuses a pasted Bearer prefix', () => {
    const meta = a.envVarMeta.POYO_API_KEY;
    expect(meta.kind).toBe('credential');
    expect(meta.secret).toBe(true);
    const re = new RegExp(meta.pattern);
    // Built at run time so no literal here looks like a real credential.
    const key = ['sk', '-', '0a1b2c3d'.repeat(4)].join('');
    expect(re.test(key)).toBe(true);
    for (const bad of [`Bearer ${key}`, 'sk-short', `${key} x`, '0a1b2c3d'.repeat(4)]) expect(re.test(bad)).toBe(false);
  });

  it('keeps the remote names, which already carry the prefix, and shares none with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name).toBe(t.endpointMapping.method);
      expect(t.endpointMapping.path).toBe('/mcp');
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('describes every top-level parameter', () => {
    for (const t of a.tools) {
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
  });

  it('marks only the credit-spending tools as writes, each asking for a confirmation', () => {
    const writes = a.tools
      .filter((t) => deriveToolAnnotations({ name: t.name, connectorType: 'MCP', endpointMapping: t.endpointMapping, annotations: t.annotations }).readOnlyHint !== true)
      .map((t) => t.name);
    expect(writes.sort()).toEqual([...PAID].sort());
    for (const name of PAID) {
      expect(tool(name).description).toMatch(/SPENDS CREDITS/);
      expect(tool(name).description).toContain('poyo_get_pricing');
      expect(tool(name).description).toMatch(/wait for a yes/);
    }
    expect(a.tools.some((t) => t.annotations?.destructiveHint === true)).toBe(false);
  });

  it("drops the server's internal _request_source parameter from the installed schemas", () => {
    for (const name of PAID) expect(tool(name).omitParameters).toEqual(['_request_source']);
    const discovered = [
      {
        name: 'poyo_chat',
        description: 'Run non-streaming chat.',
        parameters: {
          type: 'object',
          properties: { model: { type: 'string' }, input: { type: 'object' }, _request_source: { type: 'string', enum: ['skill'] } },
          required: ['model', 'input'],
        },
        endpointMapping: { method: 'poyo_chat', path: '/mcp' },
        outputSchema: null,
        annotations: null,
      },
    ];
    const [installed] = mergeDiscoveredMcpTools(a.tools as never, discovered as never, a.connector.config.mcpToolPrefix);
    expect(Object.keys((installed.parameters as { properties: object }).properties)).toEqual(['model', 'input']);
    expect(installed.annotations).toMatchObject({ readOnlyHint: false });
  });

  it('only points the model at tools that exist, mentions credits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpoyo_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpoyo_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## PoYo\n')).toBe(true);
    expect(a.instructions).toContain('credits');
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});
