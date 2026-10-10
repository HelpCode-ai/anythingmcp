import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './miro.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block calls Miro with an OAuth access token of an app that has
 * boards:read and boards:write (the app page's "Install app and get OAuth
 * token" button gives one):
 *   MIRO_ACCESS_TOKEN=eyJ... [MIRO_BOARD_ID=uXjV...=] npx jest src/adapters/intl/miro.live.spec.ts
 * Reads use MIRO_BOARD_ID, or the first board the user can open.
 * MIRO_LIVE_WRITE=1 creates a board "AnythingMCP test" and on it a frame, a
 * sticky note, a shape, a text, a card, a connector and a tag; reads, changes,
 * tags, untags and deletes them, and deletes the board in `finally`.
 */

type Mapping = { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { type: string; default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
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
const OFF = ['miro_delete_board', 'miro_remove_board_member', 'miro_share_board', 'miro_update_board_member'];

describe('miro adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in through Miro OAuth with the secret in the token request body', () => {
    expect(a.connector.baseUrl).toBe('https://api.miro.com/v2');
    expect(a.connector.authType).toBe('OAUTH2');
    // Scopes are ticked on the app, not requested; Basic client auth makes Miro answer 500.
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MIRO_CLIENT_ID}}',
      clientSecret: '{{MIRO_CLIENT_SECRET}}',
      authorizationUrl: 'https://miro.com/oauth/authorize',
      tokenUrl: 'https://api.miro.com/v1/oauth/token',
    });
    expect(a.requiredEnvVars).toEqual(['MIRO_CLIENT_ID', 'MIRO_CLIENT_SECRET']);
    expect(a.envVarMeta.MIRO_CLIENT_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.MIRO_CLIENT_ID.pattern!).test('3458764512345678901')).toBe(true);
    expect(a.appRegistrationUrl).toBe('https://miro.com/app/settings/user-profile/apps');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('Expire user authorization token');
    expect(a.instructions).toMatch(/boards:read.*boards:write/);
  });

  it('probes with the token info, which lives under v1', () => {
    expect(a.probe.tool).toBe('miro_get_token_info');
    expect(tool('miro_get_token_info').endpointMapping).toEqual({ method: 'GET', path: 'https://api.miro.com/v1/oauth-token' });
    expect(a.connector.healthcheckPath).toBe('/boards?limit=1');
  });

  it('prefixes every tool with miro_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^miro_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only and installs board deletion and member management switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of ['miro_delete_board', 'miro_delete_item', 'miro_delete_tag', 'miro_delete_connector']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    expect(annotationsOf(tool('miro_copy_board')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('miro_remove_tag_from_item')).destructiveHint).toBe(false);
  });

  it('keeps every id a string, since Miro ids exceed the safe integer range', () => {
    for (const t of a.tools) {
      for (const [name, p] of Object.entries(t.parameters.properties ?? {})) {
        if (/_id$/.test(name)) expect(`${t.name}.${name}:${p.type}`).toBe(`${t.name}.${name}:string`);
      }
    }
  });

  it('never lets a tag removal turn into an item deletion', () => {
    // Removing a tag is DELETE /items/{id}?tag_id=…, the item delete with a
    // query. The tag id sits in the path template, so a missing one leaves a
    // placeholder Miro rejects instead of a bare item URL.
    expect(tool('miro_remove_tag_from_item').endpointMapping.path).toBe('/boards/{board_id}/items/{item_id}?tag_id={tag_id}');
    expect(tool('miro_remove_tag_from_item').parameters.required).toEqual(['board_id', 'item_id', 'tag_id']);
    expect(tool('miro_attach_tag').endpointMapping.path).toBe('/boards/{board_id}/items/{item_id}?tag_id={tag_id}');
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmiro_[a-z_]+\*?/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmiro_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // `miro_create_*` stands for a group of tools.
      .filter((n) => !n.endsWith('*'));
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('Read-only setup');
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
  });
});

describe('miro adapter: requests through the real engine', () => {
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
        res.end(JSON.stringify({ id: '3458764517517819000', type: 'sticky_note' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: `${origin}/v2`, authType: 'BEARER_TOKEN', authConfig: { token: 'miro-test' }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('encodes the board id and builds a sticky note body from the given parts only', async () => {
    await run('miro_create_sticky_note', { board_id: 'uXjVOD6LSME=', content: 'Idea', style: { fillColor: 'yellow' }, position: { x: 100, y: -50 } });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v2/boards/uXjVOD6LSME%3D/sticky_notes');
    expect(seen[0].headers.authorization).toBe('Bearer miro-test');
    expect(JSON.parse(seen[0].body)).toEqual({ data: { content: 'Idea' }, style: { fillColor: 'yellow' }, position: { x: 100, y: -50 } });
  });

  it('creates a rectangle shape by default and a frame as custom freeform', async () => {
    await run('miro_create_shape', { board_id: 'b', content: 'Step 1' });
    expect(JSON.parse(seen[0].body)).toEqual({ data: { shape: 'rectangle', content: 'Step 1' } });
    await run('miro_create_frame', { board_id: 'b', title: 'Sprint', geometry: { width: 1200, height: 800 } });
    expect(JSON.parse(seen[1].body)).toEqual({ data: { title: 'Sprint', format: 'custom', type: 'freeform' }, geometry: { width: 1200, height: 800 } });
  });

  it('maps card fields to Miro names', async () => {
    await run('miro_create_card', { board_id: 'b', title: 'Fix login', assignee_id: '3074457350000000000', due_date: '2026-10-31T17:00:00Z', parent: { id: '345' } });
    expect(JSON.parse(seen[0].body)).toEqual({ data: { title: 'Fix login', assigneeId: '3074457350000000000', dueDate: '2026-10-31T17:00:00Z' }, parent: { id: '345' } });
  });

  it('connects two items with snapping ends', async () => {
    await run('miro_create_connector', { board_id: 'b', start_item: { id: '1', snapTo: 'right' }, end_item: { id: '2', snapTo: 'left' }, shape: 'elbowed' });
    expect(JSON.parse(seen[0].body)).toEqual({ startItem: { id: '1', snapTo: 'right' }, endItem: { id: '2', snapTo: 'left' }, shape: 'elbowed' });
  });

  it('attaches and removes a tag with tag_id in the query, and copies a board', async () => {
    await run('miro_attach_tag', { board_id: 'b', item_id: '11', tag_id: '22' });
    expect(`${seen[0].method} ${seen[0].url}`).toBe('POST /v2/boards/b/items/11?tag_id=22');
    await run('miro_remove_tag_from_item', { board_id: 'b', item_id: '11', tag_id: '22' });
    expect(`${seen[1].method} ${seen[1].url}`).toBe('DELETE /v2/boards/b/items/11?tag_id=22');
    await run('miro_copy_board', { board_id: 'uXjVOD6LSME=', name: 'Copy' });
    expect(`${seen[2].method} ${seen[2].url}`).toBe('PUT /v2/boards?copy_from=uXjVOD6LSME%3D');
    expect(JSON.parse(seen[2].body)).toEqual({ name: 'Copy' });
  });
});

const TOKEN = process.env.MIRO_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('miro adapter: live calls', () => {
  const config = () => ({ baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  let boardId = process.env.MIRO_BOARD_ID;

  it('reads the token info (the probe) and finds boards', async () => {
    const info = await run('miro_get_token_info');
    expect(info.scopes).toEqual(expect.arrayContaining(['boards:read']));
    const boards = await run('miro_list_boards', { limit: 5 });
    expect(Array.isArray(boards.data)).toBe(true);
    boardId = boardId ?? boards.data[0]?.id;
  }, 30000);

  it('reads a board, its items, connectors, members and tags', async () => {
    if (!boardId) return;
    expect((await run('miro_get_board', { board_id: boardId })).id).toBe(boardId);
    const items = await run('miro_list_items', { board_id: boardId, limit: 10 });
    expect(Array.isArray(items.data)).toBe(true);
    if (items.data[0]) expect((await run('miro_get_item', { board_id: boardId, item_id: items.data[0].id })).id).toBe(items.data[0].id);
    const connectors = await run('miro_list_connectors', { board_id: boardId });
    if (connectors.data[0]) expect((await run('miro_get_connector', { board_id: boardId, connector_id: connectors.data[0].id })).id).toBe(connectors.data[0].id);
    const members = await run('miro_list_board_members', { board_id: boardId });
    expect(members.data.length).toBeGreaterThan(0);
    expect((await run('miro_get_board_member', { board_id: boardId, board_member_id: members.data[0].id })).id).toBe(members.data[0].id);
    const tags = await run('miro_list_tags', { board_id: boardId });
    if (tags.data[0]) {
      expect((await run('miro_get_tag', { board_id: boardId, tag_id: tags.data[0].id })).id).toBe(tags.data[0].id);
      expect(Array.isArray((await run('miro_list_items_by_tag', { board_id: boardId, tag_id: tags.data[0].id })).data)).toBe(true);
    }
  }, 60000);

  (process.env.MIRO_LIVE_WRITE === '1' ? it : it.skip)(
    'builds an "AnythingMCP test" board with every item type, changes, tags and deletes them, and deletes the board',
    async () => {
      let testBoard: string | undefined;
      try {
        const board = await run('miro_create_board', { name: 'AnythingMCP test', description: 'Created by the AnythingMCP live spec; safe to delete.' });
        testBoard = board.id;
        const renamed = await run('miro_update_board', { board_id: testBoard, name: 'AnythingMCP test (updated)' });
        expect(renamed.name).toBe('AnythingMCP test (updated)');
        const b = testBoard!;

        const frame = await run('miro_create_frame', { board_id: b, title: 'AnythingMCP frame', position: { x: 0, y: 0 }, geometry: { width: 1600, height: 900 } });
        const sticky = await run('miro_create_sticky_note', { board_id: b, content: 'AnythingMCP sticky', style: { fillColor: 'light_yellow' }, position: { x: -400, y: 0 } });
        const shape = await run('miro_create_shape', { board_id: b, content: 'AnythingMCP shape', shape: 'round_rectangle', position: { x: 0, y: 0 }, geometry: { width: 200, height: 100 } });
        const text = await run('miro_create_text', { board_id: b, content: 'AnythingMCP text', position: { x: 0, y: -300 } });
        const card = await run('miro_create_card', { board_id: b, title: 'AnythingMCP card', description: 'test', position: { x: 400, y: 0 } });
        const connector = await run('miro_create_connector', { board_id: b, start_item: { id: sticky.id, snapTo: 'right' }, end_item: { id: shape.id, snapTo: 'left' }, shape: 'straight' });

        expect((await run('miro_update_sticky_note', { board_id: b, item_id: sticky.id, content: 'AnythingMCP sticky (updated)', style: { fillColor: 'light_green' } })).data.content).toContain('updated');
        expect((await run('miro_update_shape', { board_id: b, item_id: shape.id, style: { fillColor: '#d5f692' } })).style.fillColor).toBe('#d5f692');
        expect((await run('miro_update_text', { board_id: b, item_id: text.id, content: 'AnythingMCP text (updated)' })).data.content).toContain('updated');
        expect((await run('miro_update_card', { board_id: b, item_id: card.id, title: 'AnythingMCP card (updated)' })).data.title).toContain('updated');
        expect((await run('miro_update_frame', { board_id: b, item_id: frame.id, title: 'AnythingMCP frame (updated)' })).data.title).toContain('updated');
        expect((await run('miro_update_connector', { board_id: b, connector_id: connector.id, shape: 'elbowed' })).shape).toBe('elbowed');
        const moved = await run('miro_move_item', { board_id: b, item_id: card.id, position: { x: 100, y: 100 }, parent: { id: frame.id } });
        expect(moved.parent.id).toBe(frame.id);

        const items = await run('miro_list_items', { board_id: b, limit: 50 });
        expect(items.data.length).toBeGreaterThanOrEqual(5);
        expect((await run('miro_list_items', { board_id: b, parent_item_id: frame.id })).data.map((i: { id: string }) => i.id)).toContain(card.id);
        expect((await run('miro_get_item', { board_id: b, item_id: sticky.id })).type).toBe('sticky_note');
        expect((await run('miro_list_connectors', { board_id: b })).data[0].id).toBe(connector.id);
        expect((await run('miro_get_connector', { board_id: b, connector_id: connector.id })).startItem.id).toBe(sticky.id);

        const tag = await run('miro_create_tag', { board_id: b, title: 'anythingmcp-test', fill_color: 'cyan' });
        expect((await run('miro_get_tag', { board_id: b, tag_id: tag.id })).title).toBe('anythingmcp-test');
        expect((await run('miro_update_tag', { board_id: b, tag_id: tag.id, title: 'anythingmcp-test-2' })).title).toBe('anythingmcp-test-2');
        await run('miro_attach_tag', { board_id: b, item_id: sticky.id, tag_id: tag.id });
        expect((await run('miro_get_item_tags', { board_id: b, item_id: sticky.id })).tags.map((t: { id: string }) => t.id)).toContain(tag.id);
        expect((await run('miro_list_items_by_tag', { board_id: b, tag_id: tag.id })).data.map((i: { id: string }) => i.id)).toContain(sticky.id);
        await run('miro_remove_tag_from_item', { board_id: b, item_id: sticky.id, tag_id: tag.id });
        // The note itself must survive the tag removal.
        expect((await run('miro_get_item', { board_id: b, item_id: sticky.id })).id).toBe(sticky.id);
        await run('miro_delete_tag', { board_id: b, tag_id: tag.id });

        const members = await run('miro_list_board_members', { board_id: b });
        expect(members.data.some((m: { role: string }) => m.role === 'owner')).toBe(true);

        await run('miro_delete_connector', { board_id: b, connector_id: connector.id });
        for (const item of [sticky, shape, text, card, frame]) await run('miro_delete_item', { board_id: b, item_id: item.id });
        expect((await run('miro_list_items', { board_id: b })).data).toEqual([]);
      } finally {
        if (testBoard) await run('miro_delete_board', { board_id: testBoard });
      }
    },
    180000,
  );
});
