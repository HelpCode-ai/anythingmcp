import * as adapter from './cloudinary.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { mergeDiscoveredMcpTools } from '../mcp-adapter.util';

/**
 * Cloudinary bridges Cloudinary's official Asset Management MCP server.
 *
 *   1. Static: always runs. Pins the bridge (OAuth with dynamic client
 *      registration, the tool prefix), the tool list, which tools install
 *      switched off and what the instructions promise.
 *
 *   2. Live: skipped unless CLOUDINARY_MCP_LIVE=1. Needs no account. The
 *      server lists its tools to any caller that sends API-key headers, and
 *      checks the key only when a tool runs, so with a made-up key it:
 *        - lists exactly the tools in this catalog snapshot, by name;
 *        - answers a real tool with Cloudinary's own credential error
 *          ("api_secret mismatch"), and an unknown tool with "not found";
 *        - publishes the OAuth metadata the engine's dynamic registration uses.
 *
 *        CLOUDINARY_MCP_LIVE=1 npx jest src/adapters/intl/cloudinary.live.spec.ts
 *
 * Verified this way on 12 Oct 2026 (server CloudinaryAssetMgmt 0.11.3, 30
 * tools). The OAuth flow was also walked by hand up to Cloudinary's sign-in:
 * dynamic registration accepts the cloud callback URL with
 * client_secret_post, and /authorize forwards to oauth.cloudinary.com.
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
  name: string;
  category: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, unknown>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string; mcpOAuth?: { registration?: string } };
  };
  tools: Tool[];
};
const tool = (method: string) => {
  const t = a.tools.find((x) => x.endpointMapping.method === method);
  if (!t) throw new Error(`missing tool ${method}`);
  return t;
};

const MCP_URL = 'https://asset-management.mcp.cloudinary.com/mcp';
const OFF = ['delete-asset', 'delete-asset-relations', 'delete-derived-assets', 'delete-folder'];

describe('cloudinary adapter: static spec conformance', () => {
  it('is listed (verified against the live server on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('is named Cloudinary in storage', () => {
    expect(a.name).toBe('Cloudinary');
    expect(a.category).toBe('storage');
  });

  it("bridges Cloudinary's official MCP server with OAuth and dynamic client registration", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe(MCP_URL);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.config.mcpToolPrefix).toBe('cloudinary_');
    expect(a.connector.config.mcpPath).toBeUndefined();
    expect(a.connector.config.mcpOAuth).toEqual({ registration: 'dcr' });
  });

  it('asks for no key: the user signs in with Cloudinary after saving', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(Object.keys(a.envVarMeta ?? {})).toEqual([]);
    expect(a.prerequisites).toMatch(/sign in with Cloudinary/);
    expect(a.prerequisites).toMatch(/product environment/);
    expect(a.instructions).toMatch(/dynamic client registration/);
    expect(a.instructions).toMatch(/No API key, client id or secret is needed/);
    // The API-key alternative uses the single header Cloudinary documents.
    expect(a.instructions).toContain('`cloudinary-url`');
    expect(a.instructions).toContain('cloudinary://<api_key>:<api_secret>@<cloud_name>');
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    expect(a.tools).toHaveLength(30);
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
      expect(t.description.length).toBeGreaterThanOrEqual(40);
      expect(t.parameters.type).toBe('object');
      expect(t.parameters).not.toHaveProperty('$schema');
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(tool('upload-asset').name).toBe('cloudinary_upload_asset');
    expect(tool('get-tx-reference').name).toBe('cloudinary_get_tx_reference');
  });

  it('uploads from a URL or a data URI and returns the public URL', () => {
    const upload = tool('upload-asset');
    expect(upload.parameters.required).toEqual(['upload_request']);
    const req = upload.parameters.properties.upload_request as { required: string[]; properties: Record<string, unknown> };
    expect(req.required).toEqual(['file']);
    expect(req.properties).toHaveProperty('asset_folder');
    expect(req.properties).toHaveProperty('public_id');
    expect(upload.description).toMatch(/secure_url/);
    expect(upload.description).toMatch(/Instagram/);
    expect(upload.enabled).not.toBe(false);
  });

  it('ships the deletes switched off, and only those', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(OFF);
    for (const m of OFF) expect(tool(m).annotations?.destructiveHint).toBe(true);
  });

  it("keeps the server's own annotations", () => {
    for (const m of ['list-images', 'list-videos', 'list-files', 'search-assets', 'get-asset-details', 'get-usage-details', 'list-tags', 'search-folders']) {
      expect(tool(m).annotations?.readOnlyHint).toBe(true);
    }
    for (const m of ['upload-asset', 'asset-update', 'asset-rename', 'create-folder', 'generate-image']) {
      expect(tool(m).annotations?.readOnlyHint).toBe(false);
      expect(tool(m).annotations?.destructiveHint).toBe(false);
    }
    expect(a.tools.filter((t) => t.annotations?.readOnlyHint === true)).toHaveLength(13);
  });

  it('keeps the deletes off when the tools are discovered from the server after sign-in', () => {
    const discovered = a.tools.map((t) => ({
      name: t.endpointMapping.method,
      description: `server ${t.endpointMapping.method}`,
      parameters: t.parameters,
      endpointMapping: t.endpointMapping,
    }));
    const merged = mergeDiscoveredMcpTools(a.tools as never, discovered as never, a.connector.config.mcpToolPrefix);
    expect(merged.map((t) => t.name).sort()).toEqual(a.tools.map((t) => t.name).sort());
    const off = merged.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(OFF.map((m) => localMcpToolName(m, 'cloudinary_')).sort());
  });

  it('explains public URLs, the shared identity and the safety defaults', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    expect(a.instructions).toMatch(/every caller/);
    expect(a.instructions).toMatch(/public to anyone who has its URL/);
    expect(a.instructions).toMatch(/Discover tools/);
    expect(a.instructions).toMatch(/f_jpg/);
    expect(a.instructions).toMatch(/Image Generation add-on/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.CLOUDINARY_MCP_LIVE === '1' ? describe : describe.skip;

live('cloudinary adapter: live server without an account', () => {
  jest.setTimeout(60_000);
  // Made up at run time: a well-formed key the server cannot match.
  const fakeUrl = `cloudinary://${'1'.repeat(15)}:${'x'.repeat(27)}@demo`;

  async function rpc(method: string, params: Record<string, unknown>, id = 1): Promise<any> {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'cloudinary-url': fakeUrl,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('');
    return JSON.parse(data || text);
  }

  it('lists exactly the tools in the catalog snapshot', async () => {
    const out = await rpc('tools/list', {});
    const names: string[] = out.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(a.tools.map((t) => t.endpointMapping.method).sort());
  });

  it("answers a real tool with Cloudinary's credential error and an unknown one with not found", async () => {
    const real = await rpc('tools/call', { name: 'list-images', arguments: { max_results: 1 } }, 2);
    expect(real.result.isError).toBe(true);
    // "api_secret mismatch" or "disabled api_key", depending on the key.
    expect(JSON.stringify(real.result.content)).toMatch(/api_secret mismatch|disabled api_key|unknown api_key/i);
    const fake = await rpc('tools/call', { name: 'no-such-tool', arguments: {} }, 3);
    expect(fake.result.isError).toBe(true);
    expect(JSON.stringify(fake.result.content)).toMatch(/not found/);
  });

  it('publishes the OAuth metadata that dynamic registration needs', async () => {
    const pr = await (await fetch('https://asset-management.mcp.cloudinary.com/.well-known/oauth-protected-resource')).json();
    expect(pr.scopes_supported).toEqual(expect.arrayContaining(['offline_access', 'asset_management', 'upload']));
    const as = await (await fetch('https://asset-management.mcp.cloudinary.com/.well-known/oauth-authorization-server')).json();
    expect(as.registration_endpoint).toBe('https://asset-management.mcp.cloudinary.com/register');
    expect(as.code_challenge_methods_supported).toContain('S256');
    expect(as.token_endpoint_auth_methods_supported).toContain('client_secret_post');
  });
});
