import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Kind, OperationDefinitionNode, parse } from 'graphql';
import * as adapterJson from './monday.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';

/**
 * Static checks and one request against a local server always run. Every
 * operation was also validated against the published 2026-07 schema
 * (https://api.monday.com/v2/get_schema?format=sdl&version=2026-07) when the
 * adapter was written. The live block runs read-only queries with a token:
 *   MONDAY_API_TOKEN=xxx npx jest src/adapters/intl/monday.live.spec.ts
 * MONDAY_LIVE_WRITE=1 with MONDAY_TEST_BOARD_ID=<board id> also creates an
 * item named "AnythingMCP test", comments on it, renames it and archives it.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapterJson as unknown as {
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    schemaUrl: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const operation = (t: Tool) =>
  parse(t.endpointMapping.path).definitions.find(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  )!;
const engine = () => new GraphqlEngine({} as OAuth2TokenService, {} as LoginTokenService, {} as GraphqlSchemaService);

describe('monday adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('calls the v2 GraphQL endpoint with the raw token in Authorization and a pinned API version', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.monday.com/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{MONDAY_API_TOKEN}}' });
    expect(a.connector.headers['API-Version']).toBe('2026-07');
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.connector.schemaUrl).toBe('https://api.monday.com/v2/get_schema?format=sdl&version=2026-07');
    expect(a.requiredEnvVars).toEqual(['MONDAY_API_TOKEN']);
  });

  it('probes with me, which takes no argument', () => {
    expect(a.probe.tool).toBe('monday_get_me');
    expect(operation(tool('monday_get_me')).variableDefinitions ?? []).toHaveLength(0);
  });

  it('every operation parses, and parameters and variables match one to one', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('monday_')).toBe(true);
      const op = operation(t);
      expect(`${t.name}:${op.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      const mapped = Object.keys(t.endpointMapping.queryParams ?? {}).sort();
      expect(`${t.name}:${mapped.join(',')}`).toBe(`${t.name}:${declared.join(',')}`);
      const used = Object.values(t.endpointMapping.queryParams ?? {}).map((v) => v.slice(1)).sort();
      const params = Object.keys(t.parameters.properties ?? {}).sort();
      expect(`${t.name}:${used.join(',')}`).toBe(`${t.name}:${params.join(',')}`);
      for (const r of t.parameters.required ?? []) expect(params).toContain(r);
    }
  });

  it('has the expected writes, none of them deleting, and installs archive switched off', () => {
    const mutations = a.tools.filter((t) => t.endpointMapping.method === 'mutation').map((t) => t.name).sort();
    expect(mutations).toEqual([
      'monday_archive_item',
      'monday_change_column_values',
      'monday_create_group',
      'monday_create_item',
      'monday_create_update',
      'monday_move_item_to_group',
    ]);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/delete_/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['monday_archive_item']);
    for (const name of mutations.filter((n) => n !== 'monday_archive_item')) expect(tool(name).description).toMatch(/confirm/i);
  });

  it('pages items with items_page and next_items_page cursors', () => {
    expect(tool('monday_get_items_page').endpointMapping.path).toContain('items_page(limit: $limit, query_params: $queryParams) { cursor items');
    expect(tool('monday_next_items_page').endpointMapping.path).toContain('next_items_page(cursor: $cursor, limit: $limit) { cursor items');
    expect(a.instructions).toMatch(/60 minutes/);
  });

  it('takes column values as a JSON string, as the JSON scalar expects', () => {
    for (const name of ['monday_create_item', 'monday_change_column_values']) {
      const props = tool(name).parameters.properties as Record<string, { type: string }>;
      expect(props.column_values.type).toBe('string');
    }
  });

  it('documents setup, the read-only setup and the generic mutation tool', () => {
    expect(a.instructions).toMatch(/Developers/);
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toContain('monday_graphql_mutation');
    expect(JSON.stringify(adapterJson)).not.toContain('—');
  });
});

describe('monday adapter: request through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { create_item: { id: '1' } } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends the token without Bearer, the API version and the mapped variables', async () => {
    const result = await engine().execute(
      { baseUrl: origin, authType: 'API_KEY', authConfig: { headerName: 'Authorization', apiKey: 'tok123' }, headers: a.connector.headers },
      tool('monday_create_item').endpointMapping,
      { board_id: '42', item_name: 'AnythingMCP test', column_values: '{"status":{"label":"Done"}}' },
    );
    expect(result).toEqual({ create_item: { id: '1' } });
    const [req] = seen;
    expect(req.headers.authorization).toBe('tok123');
    expect(req.headers['api-version']).toBe('2026-07');
    const body = JSON.parse(req.body);
    expect(body.query).toMatch(/^mutation CreateItem/);
    expect(body.variables).toEqual({ boardId: '42', itemName: 'AnythingMCP test', columnValues: '{"status":{"label":"Done"}}' });
  });
});

const TOKEN = process.env.MONDAY_API_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('monday adapter: live calls', () => {
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'API_KEY',
        authConfig: { headerName: 'Authorization', apiKey: TOKEN as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  let boardId: string | undefined;

  it('reads me (the probe), workspaces and users', async () => {
    const me = await run('monday_get_me');
    expect(me.me.id).toBeTruthy();
    const ws = await run('monday_list_workspaces', { limit: 5 });
    expect(Array.isArray(ws.workspaces)).toBe(true);
    const users = await run('monday_list_users', { limit: 5 });
    expect(Array.isArray(users.users)).toBe(true);
  }, 30000);

  it('lists boards, reads one and pages its items', async () => {
    const boards = await run('monday_list_boards', { limit: 5, order_by: 'used_at' });
    expect(Array.isArray(boards.boards)).toBe(true);
    boardId = process.env.MONDAY_TEST_BOARD_ID || boards.boards.find((b: { items_count: number }) => b.items_count > 0)?.id;
    if (!boardId) return;
    const board = await run('monday_get_board', { board_id: boardId });
    expect(board.boards[0].id).toBe(boardId);
    const page = await run('monday_get_items_page', { board_id: boardId, limit: 2 });
    const items = page.boards[0].items_page.items;
    expect(Array.isArray(items)).toBe(true);
    if (items[0]) {
      const got = await run('monday_get_items', { item_ids: [items[0].id] });
      expect(got.items[0].id).toBe(items[0].id);
      const updates = await run('monday_list_updates', { item_id: items[0].id, limit: 2 });
      expect(Array.isArray(updates.items[0].updates_page.updates)).toBe(true);
    }
    const cursor = page.boards[0].items_page.cursor;
    if (cursor) {
      const next = await run('monday_next_items_page', { cursor, limit: 2 });
      expect(Array.isArray(next.next_items_page.items)).toBe(true);
    }
  }, 60000);

  const BOARD = process.env.MONDAY_TEST_BOARD_ID;
  (process.env.MONDAY_LIVE_WRITE === '1' && BOARD ? it : it.skip)(
    'creates, comments, renames and archives an "AnythingMCP test" item',
    async () => {
      let itemId: string | undefined;
      try {
        const created = await run('monday_create_item', { board_id: BOARD, item_name: 'AnythingMCP test' });
        itemId = created.create_item.id;
        const update = await run('monday_create_update', { item_id: itemId, body: 'AnythingMCP test update' });
        expect(update.create_update.id).toBeTruthy();
        const renamed = await run('monday_change_column_values', {
          board_id: BOARD,
          item_id: itemId,
          column_values: JSON.stringify({ name: 'AnythingMCP test (renamed)' }),
        });
        expect(renamed.change_multiple_column_values.name).toBe('AnythingMCP test (renamed)');
      } finally {
        if (itemId) await run('monday_archive_item', { item_id: itemId });
      }
    },
    60000,
  );
});
