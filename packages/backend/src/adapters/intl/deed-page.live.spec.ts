import { randomBytes } from 'crypto';
import * as adapter from './deed-page.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';
import { McpClientEngine } from '../../connectors/engines/mcp-client.engine';

/**
 * deed.page bridges deed.page's official remote MCP server.
 *
 *   1. Static: always runs. Pins the bridge (Bearer owner token, the tool
 *      prefix), the tool list, which tools install switched off and what the
 *      instructions promise.
 *
 *   2. Live: skipped unless RUN_DEED_PAGE_LIVE=1. Needs no account and no
 *      token. Through the real McpClientEngine it:
 *        - lists exactly the tools in this catalog snapshot, by name;
 *        - publishes a one-file page under a random slug with a 10-minute
 *          expiry, which mints a throwaway owner token;
 *        - reads the page back as that owner with the token sent only as a
 *          Bearer header (the connector's setup), then deletes it and checks
 *          that the URL answers 404.
 *
 *        RUN_DEED_PAGE_LIVE=1 npx jest src/adapters/intl/deed-page.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { type: string; required?: string[]; properties: Record<string, { description?: string }> };
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  name: string;
  category: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern: string; secret?: boolean }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};
const tool = (method: string) => {
  const t = a.tools.find((x) => x.endpointMapping.method === method);
  if (!t) throw new Error(`missing tool ${method}`);
  return t;
};

const MCP_URL = 'https://deed.page/mcp';
const OFF = ['agent_seats', 'delete_site', 'delete_webhook', 'remove_domain', 'revoke_token', 'rotate_token'];

describe('deed-page adapter: static spec conformance', () => {
  it("bridges deed.page's official MCP server with the owner token as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe(MCP_URL);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DEED_PAGE_TOKEN}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'deed_page_' });
    expect(a.requiredEnvVars).toEqual(['DEED_PAGE_TOKEN']);
    expect(a.envVarMeta.DEED_PAGE_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.DEED_PAGE_TOKEN.pattern);
    expect(pattern.test('deed_tok_' + 'aZ09_-'.repeat(6))).toBe(true);
    expect(pattern.test('Bearer deed_tok_abc')).toBe(false);
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    expect(a.tools).toHaveLength(27);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.parameters.type).toBe('object');
      expect(t.parameters).not.toHaveProperty('$schema');
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(tool('publish_site').name).toBe('deed_page_publish_site');
  });

  it('describes every top-level parameter', () => {
    for (const t of a.tools) {
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
    }
  });

  it('publishes from a files map and needs nothing else', () => {
    const publish = tool('publish_site');
    expect(publish.parameters.required).toEqual(['files']);
    expect(publish.parameters.properties).toHaveProperty('slug');
    expect(publish.parameters.properties).toHaveProperty('ttl_seconds');
    expect(publish.enabled).not.toBe(false);
  });

  it('ships deletes and token changes switched off, and only those', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(OFF);
  });

  it('keeps the deletes off when the tools are discovered from the server', () => {
    const discovered = a.tools.map((t) => ({
      name: t.endpointMapping.method,
      description: `server ${t.endpointMapping.method}`,
      parameters: t.parameters,
      endpointMapping: t.endpointMapping,
    }));
    const merged = mergeDiscoveredMcpTools(a.tools as never, discovered as never, a.connector.config.mcpToolPrefix);
    expect(merged.map((t) => t.name).sort()).toEqual(a.tools.map((t) => t.name).sort());
    const off = merged.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(OFF.map((m) => localMcpToolName(m, 'deed_page_')).sort());
  });

  it('says that sites are public, to ask before publishing, where the token comes from and why rotation is off', () => {
    expect(a.instructions).toMatch(/Everything published is public/);
    expect(a.instructions).toMatch(/first publish without a token/);
    expect(a.instructions).toMatch(/Leave the tools' own `token` argument empty/);
    expect(a.instructions).toMatch(/break the token stored here/);
    expect(a.instructions).toMatch(/Discover tools/);
    expect(a.instructions).toMatch(/publish or update only after the user says yes/);
    expect(a.prerequisites).toMatch(/deed_tok_/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});

const live = process.env.RUN_DEED_PAGE_LIVE === '1' ? describe : describe.skip;

live('deed-page adapter: live server without an account', () => {
  jest.setTimeout(90_000);
  const engine = new McpClientEngine({} as never);
  const slug = `anythingmcp-live-${randomBytes(4).toString('hex')}`;
  let token = '';

  const text = (r: unknown) => {
    const res = r as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    return { isError: res.isError === true, body: res.content.map((c) => c.text ?? '').join('') };
  };
  const asOwner = () => ({ baseUrl: MCP_URL, authType: 'BEARER_TOKEN', authConfig: { token } });

  afterAll(async () => {
    // Clean up if a test failed between publishing and deleting.
    if (!token) return;
    await engine.execute(asOwner(), { method: 'delete_site', path: '/mcp' }, { slug }).catch(() => undefined);
  });

  it('lists exactly the tools in the catalog snapshot', async () => {
    const tools = await engine.listTools({ baseUrl: MCP_URL, authType: 'NONE' });
    expect(tools.map((t) => t.name).sort()).toEqual(a.tools.map((t) => t.endpointMapping.method).sort());
  });

  it('publishes a page, reads it back as the Bearer owner, deletes it and gets a 404', async () => {
    const published = text(
      await engine.execute(
        { baseUrl: MCP_URL, authType: 'NONE' },
        { method: 'publish_site', path: '/mcp' },
        { slug, ttl_seconds: 600, files: { 'index.html': '<!doctype html><title>AnythingMCP live spec</title><p>Safe to delete.</p>' } },
      ),
    );
    expect(published.isError).toBe(false);
    const out = JSON.parse(published.body) as { url: string; slug: string; version: number; token?: string };
    expect(out.slug).toBe(slug);
    expect(out.url).toBe(`https://${slug}.deed.page/`);
    expect(out.token).toMatch(new RegExp(a.envVarMeta.DEED_PAGE_TOKEN.pattern));
    token = out.token as string;

    const page = await fetch(out.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('AnythingMCP live spec');

    const mine = text(await engine.execute(asOwner(), { method: 'list_sites', path: '/mcp' }, {}));
    expect(mine.isError).toBe(false);
    expect(mine.body).toContain(slug);

    const deleted = text(await engine.execute(asOwner(), { method: 'delete_site', path: '/mcp' }, { slug }));
    expect(deleted.isError).toBe(false);
    expect(deleted.body).toContain(slug);
    token = '';

    expect((await fetch(out.url)).status).toBe(404);
  });

  it("answers a taken slug with deed.page's own error", async () => {
    const taken = text(
      await engine.execute({ baseUrl: MCP_URL, authType: 'NONE' }, { method: 'publish_site', path: '/mcp' }, {
        slug: 'docs',
        files: { 'index.html': '<p>x</p>' },
      }),
    );
    expect(taken.isError).toBe(true);
    expect(taken.body).toMatch(/slug_reserved|slug_taken/);
  });
});
