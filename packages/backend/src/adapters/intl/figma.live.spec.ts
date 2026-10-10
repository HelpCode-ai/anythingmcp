import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './figma.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { assertNoResponseBodyError, describeErrorWhenProblems, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs every read tool through the real RestEngine:
 *   FIGMA_ACCESS_TOKEN=figd_... FIGMA_FILE_KEY=aBcD1234EfGh [FIGMA_TEAM_ID=1535...] \
 *     npx jest src/adapters/intl/figma.live.spec.ts
 * File reads need FIGMA_FILE_KEY, team library and project reads FIGMA_TEAM_ID.
 * figma_get_file, figma_get_file_nodes and figma_render_images count against
 * Figma's tier 1 limit, which for files on the free Starter plan is only a few
 * calls a month: run this against a file in a paid team when possible.
 * FIGMA_LIVE_WRITE=1 also posts a comment "AnythingMCP test" on the file,
 * reacts to it and deletes it, and attaches a dev resource to the first frame,
 * renames it and deletes it (dev resources need a paid plan with Dev Mode).
 */

type Mapping = { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const rules = a.connector.config.errorWhen;
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, rules);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};
const WRITES = [
  'figma_add_comment_reaction',
  'figma_create_dev_resource',
  'figma_delete_comment',
  'figma_delete_dev_resource',
  'figma_post_comment',
  'figma_update_dev_resource',
];

describe('figma adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the personal access token in X-Figma-Token', () => {
    expect(a.connector.baseUrl).toBe('https://api.figma.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Figma-Token', apiKey: '{{FIGMA_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['FIGMA_ACCESS_TOKEN']);
    expect(a.envVarMeta.FIGMA_ACCESS_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.FIGMA_ACCESS_TOKEN.pattern!);
    expect(token.test('figd_0123456789abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(token.test('Bearer figd_0123456789abcdefghij')).toBe(false);
  });

  it('probes with the current user and health-checks /v1/me', () => {
    expect(a.probe.tool).toBe('figma_get_me');
    expect(tool('figma_get_me').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/v1/me');
  });

  it('prefixes every tool with figma_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^figma_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, writes only comments and dev resources, and installs dev resource deletion off', () => {
    const writes = a.tools.filter((t) => !annotationsOf(t).readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const t of a.tools) expect(annotationsOf(t).readOnlyHint === true).toBe(t.endpointMapping.method === 'GET');
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['figma_delete_dev_resource']);
    expect(tool('figma_post_comment').description).toMatch(/confirm/i);
  });

  it('caps the large document reads and keeps file reads shallow by default', () => {
    for (const name of ['figma_get_file', 'figma_get_file_nodes']) {
      expect((tool(name) as Tool & { responseMapping: unknown }).responseMapping).toEqual({ transform: { expression: '@', maxBytes: 200000 } });
    }
    expect(tool('figma_get_file').parameters.properties!.depth.default).toBe(2);
  });

  it('turns refused dev resources and render errors in a 200 answer into failures', () => {
    expect(describeErrorWhenProblems(rules)).toEqual([]);
    expect(statusOf({ err: null, images: { '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/x.png' } })).toBeNull();
    expect(statusOf({ links_created: [{ id: 'd1' }], errors: [] })).toBeNull();
    expect(statusOf({ links_created: [], errors: [{ file_key: 'k', node_id: '1:2', error: 'Node already has 10 dev resources' }] })).toBe(400);
    expect(statusOf({ links_updated: [], errors: [{ id: 'd1', error: 'Dev resource not found' }] })).toBe(400);
    expect(statusOf({ err: 'Render timeout', images: {} })).toBe(400);
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfigma_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfigma_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('Personal access tokens');
    expect(a.instructions).toContain('file_content:read');
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toMatch(/90 days/);
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
  });
});

describe('figma adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 200, error: false }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: origin, authType: 'API_KEY', authConfig: { headerName: 'X-Figma-Token', apiKey: 'figd_test' }, headers: a.connector.headers, errorWhen: rules } as never,
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('reads a file two levels deep by default with the token header', async () => {
    await run('figma_get_file', { file_key: 'aBcD1234' });
    expect(seen[0].url).toBe('/v1/files/aBcD1234?depth=2');
    expect(seen[0].headers['x-figma-token']).toBe('figd_test');
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('renders nodes with colon ids and the chosen format', async () => {
    await run('figma_render_images', { file_key: 'aBcD1234', ids: '1:2,4:17', format: 'svg', svg_include_node_id: true });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/v1/images/aBcD1234');
    expect(url.searchParams.get('ids')).toBe('1:2,4:17');
    expect(url.searchParams.get('format')).toBe('svg');
    expect(url.searchParams.get('svg_include_node_id')).toBe('true');
  });

  it('posts a pinned comment and a reply', async () => {
    await run('figma_post_comment', { file_key: 'aBcD1234', message: 'Looks good', client_meta: { node_id: '1:2', node_offset: { x: 0, y: 0 } } });
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual({ message: 'Looks good', client_meta: { node_id: '1:2', node_offset: { x: 0, y: 0 } } });
    await run('figma_post_comment', { file_key: 'aBcD1234', message: 'Agreed', comment_id: '123' });
    expect(JSON.parse(seen[1].body)).toEqual({ message: 'Agreed', comment_id: '123' });
  });

  it('wraps a dev resource in the dev_resources list for create and update', async () => {
    await run('figma_create_dev_resource', { file_key: 'aBcD1234', node_id: '1:2', name: 'Ticket', url: 'https://example.com/T-1' });
    expect(seen[0].url).toBe('/v1/dev_resources');
    expect(JSON.parse(seen[0].body)).toEqual({ dev_resources: [{ name: 'Ticket', url: 'https://example.com/T-1', file_key: 'aBcD1234', node_id: '1:2' }] });
    await run('figma_update_dev_resource', { dev_resource_id: 'd1', name: 'Ticket T-1' });
    expect(seen[1].method).toBe('PUT');
    expect(JSON.parse(seen[1].body)).toEqual({ dev_resources: [{ id: 'd1', name: 'Ticket T-1' }] });
  });

  it('pages team components with the numeric cursor', async () => {
    await run('figma_list_team_components', { team_id: '1535', page_size: 100, after: 42 });
    expect(seen[0].url).toBe('/v1/teams/1535/components?page_size=100&after=42');
  });
});

const TOKEN = process.env.FIGMA_ACCESS_TOKEN;
const FILE = process.env.FIGMA_FILE_KEY;
const TEAM = process.env.FIGMA_TEAM_ID;
const live = TOKEN ? describe : describe.skip;
const withFile = FILE ? it : it.skip;
const withTeam = TEAM ? it : it.skip;

live('figma adapter: live calls', () => {
  const config = () => ({ baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig: { headerName: 'X-Figma-Token', apiKey: TOKEN as string }, headers: a.connector.headers, errorWhen: rules });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config() as never, tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  let frameId: string | undefined;

  it('reads the user (the probe)', async () => {
    const me = await run('figma_get_me');
    expect(typeof me.id).toBe('string');
  }, 30000);

  withFile('reads the file: metadata, tree, nodes, a render, image fills and versions', async () => {
    expect((await run('figma_get_file_meta', { file_key: FILE })).file.name).toBeDefined();
    const file = await run('figma_get_file', { file_key: FILE });
    const page = file.document.children[0];
    frameId = page.children?.[0]?.id ?? page.id;
    const nodes = await run('figma_get_file_nodes', { file_key: FILE, ids: frameId, depth: 1 });
    expect(nodes.nodes[frameId!]).toBeDefined();
    const images = await run('figma_render_images', { file_key: FILE, ids: frameId, format: 'png', scale: 0.5 });
    expect(Object.keys(images.images)).toEqual([frameId]);
    expect(await run('figma_get_image_fills', { file_key: FILE })).toHaveProperty('meta');
    expect(Array.isArray((await run('figma_list_versions', { file_key: FILE, page_size: 5 })).versions)).toBe(true);
  }, 90000);

  withFile('reads comments, reactions, the file library and dev resources', async () => {
    const comments = await run('figma_list_comments', { file_key: FILE, as_md: true });
    expect(Array.isArray(comments.comments)).toBe(true);
    if (comments.comments[0]) {
      const reactions = await run('figma_list_comment_reactions', { file_key: FILE, comment_id: comments.comments[0].id });
      expect(Array.isArray(reactions.reactions)).toBe(true);
    }
    const components = await run('figma_list_file_components', { file_key: FILE });
    expect(components.meta).toHaveProperty('components');
    expect((await run('figma_list_file_component_sets', { file_key: FILE })).meta).toHaveProperty('component_sets');
    const styles = await run('figma_list_file_styles', { file_key: FILE });
    expect(styles.meta).toHaveProperty('styles');
    if (components.meta.components[0]) {
      const key = components.meta.components[0].key;
      expect((await run('figma_get_component', { key })).meta.key).toBe(key);
    }
    const sets = (await run('figma_list_file_component_sets', { file_key: FILE })).meta.component_sets;
    if (sets[0]) expect((await run('figma_get_component_set', { key: sets[0].key })).meta.key).toBe(sets[0].key);
    if (styles.meta.styles[0]) {
      const key = styles.meta.styles[0].key;
      expect((await run('figma_get_style', { key })).meta.key).toBe(key);
    }
    const dev = await run('figma_list_dev_resources', { file_key: FILE }).catch((e) => e);
    expect(Array.isArray(dev?.dev_resources) || [400, 403].includes(dev?.response?.status)).toBe(true);
  }, 90000);

  withTeam('reads team projects, their files and the team library', async () => {
    const projects = await run('figma_list_team_projects', { team_id: TEAM });
    expect(Array.isArray(projects.projects)).toBe(true);
    if (projects.projects[0]) {
      expect(Array.isArray((await run('figma_list_project_files', { project_id: projects.projects[0].id })).files)).toBe(true);
    }
    expect((await run('figma_list_team_components', { team_id: TEAM, page_size: 5 })).meta).toHaveProperty('components');
    expect((await run('figma_list_team_component_sets', { team_id: TEAM, page_size: 5 })).meta).toHaveProperty('component_sets');
    expect((await run('figma_list_team_styles', { team_id: TEAM, page_size: 5 })).meta).toHaveProperty('styles');
  }, 60000);

  it('a wrong token is a 403', async () => {
    await expect(
      engine().execute({ ...config(), authConfig: { headerName: 'X-Figma-Token', apiKey: 'figd_wrong' } } as never, tool('figma_get_me').endpointMapping, {}),
    ).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  const writes = process.env.FIGMA_LIVE_WRITE === '1' && FILE ? it : it.skip;

  writes('posts an "AnythingMCP test" comment, reacts to it and deletes it', async () => {
    let commentId: string | undefined;
    try {
      const posted = await run('figma_post_comment', { file_key: FILE, message: 'AnythingMCP test (safe to delete)' });
      commentId = posted.id;
      expect(posted.message).toContain('AnythingMCP test');
      await run('figma_add_comment_reaction', { file_key: FILE, comment_id: commentId, emoji: ':+1:' });
      const reactions = await run('figma_list_comment_reactions', { file_key: FILE, comment_id: commentId });
      expect(reactions.reactions.some((r: { emoji: string }) => r.emoji === ':+1:')).toBe(true);
    } finally {
      if (commentId) await run('figma_delete_comment', { file_key: FILE, comment_id: commentId });
    }
    const after = await run('figma_list_comments', { file_key: FILE });
    expect(after.comments.some((c: { id: string }) => c.id === commentId)).toBe(false);
  }, 60000);

  writes('attaches a dev resource to a frame, renames it and deletes it', async () => {
    const nodeId = frameId ?? (await run('figma_get_file', { file_key: FILE, depth: 2 })).document.children[0].children[0].id;
    let resourceId: string | undefined;
    try {
      const created = await run('figma_create_dev_resource', { file_key: FILE, node_id: nodeId, name: 'AnythingMCP test', url: `https://example.com/anythingmcp-test-${Date.now()}` });
      resourceId = created.links_created[0].id;
      const updated = await run('figma_update_dev_resource', { dev_resource_id: resourceId, name: 'AnythingMCP test (updated)' });
      expect(updated.links_updated.length).toBe(1);
      const listed = await run('figma_list_dev_resources', { file_key: FILE, node_ids: nodeId });
      expect(listed.dev_resources.find((d: { id: string }) => d.id === resourceId).name).toBe('AnythingMCP test (updated)');
    } finally {
      if (resourceId) await run('figma_delete_dev_resource', { file_key: FILE, dev_resource_id: resourceId });
    }
  }, 60000);
});
