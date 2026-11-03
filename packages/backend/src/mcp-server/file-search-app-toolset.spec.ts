import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { RegisteredTool } from './tool-registry';
import { buildFileSearchBuiltinTools, buildFileShareBuiltinTools } from '../file-search/file-search-builtins';
import {
  FILE_SEARCH_APP_INSTRUCTIONS,
  FILE_SEARCH_APP_TOOL_NAMES,
  FileSearchAppDeps,
  fileSearchOperation,
  registerFileSearchAppToolset,
} from './file-search-app-toolset';

function tool(p: Partial<RegisteredTool> & { name: string; connectorId: string }): RegisteredTool {
  return {
    id: `${p.connectorId}:${p.name}`,
    organizationId: 'org-A',
    description: `${p.name} description`,
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/x' },
    ...p,
  } as RegisteredTool;
}

/** The tools a FILE_SEARCH source connector is activated with (file-search-builtins.ts). */
function source(connectorId: string, prefix: string, protocol = 'sftp', only?: string[]): RegisteredTool[] {
  return buildFileSearchBuiltinTools({ prefix, displayName: prefix })
    .filter((b) => !only || only.some((m) => b.endpointMapping.method === m))
    .map((b) =>
      tool({
        connectorId,
        name: b.name,
        connectorType: 'FILE_SEARCH',
        connectorConfig: {
          baseUrl: `${protocol}://files.internal:22/Prices`,
          authType: 'BASIC_AUTH',
          config: { fileSearch: { protocol, host: 'files.internal', username: 'reader', toolPrefix: prefix } },
        },
        endpointMapping: b.endpointMapping as RegisteredTool['endpointMapping'],
        parameters: b.parameters,
      }),
    );
}

/** The File Share connector: a FILE_SEARCH connector with no folder. */
const FILE_SHARE = buildFileShareBuiltinTools().map((b) =>
  tool({
    connectorId: 'c-share',
    name: b.name,
    connectorType: 'FILE_SEARCH',
    connectorConfig: { baseUrl: '', authType: 'NONE', config: { fileShare: true } },
    endpointMapping: b.endpointMapping as RegisteredTool['endpointMapping'],
  }),
);
const PRICES = source('c-prices', 'prices');
const CONTRACTS = source('c-contracts', 'contracts', 'webdav');
const CRM = tool({ name: 'crm_find_customer', connectorId: 'c-crm' });
const DB = tool({
  name: 'sales_execute_query',
  connectorId: 'c-db',
  connectorType: 'DATABASE',
  endpointMapping: { method: 'query', path: '${query}' },
});

const NAMES: Record<string, string> = {
  'c-prices': 'Supplier price lists',
  'c-contracts': 'Contracts',
  'c-share': 'File Share',
};

function makeDeps(overrides: Partial<FileSearchAppDeps> = {}) {
  return {
    execute: jest.fn(async (t: RegisteredTool, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ran: t.id, args }) }],
    })),
    connectors: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: NAMES[id] ?? id, hasGuide: id === 'c-prices' })),
    ),
    guide: jest.fn(async () => 'Price lists are in one folder per supplier.'),
    setupUrl: 'https://cloud.example.com/connectors/new/file-search?from=chat',
    ...overrides,
  };
}

async function connect(scope: RegisteredTool[], deps = makeDeps()) {
  const server = new McpServer(
    { name: 'AnythingMCP File Search', version: 'test' },
    { instructions: FILE_SEARCH_APP_INSTRUCTIONS },
  );
  registerFileSearchAppToolset(server, scope, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, deps };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const texts: string[] = (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text);
  let body: any = texts[0] ?? '';
  try {
    body = JSON.parse(texts[0]);
  } catch {
    /* plain text */
  }
  return { isError: !!result.isError, body, texts };
}

describe('/mcp/file-search tool set', () => {
  it('lists the same fixed tools and instructions whatever the caller can reach', async () => {
    const a = await connect([...PRICES, ...CONTRACTS, CRM, DB, ...FILE_SHARE]);
    const b = await connect([]);
    const listA = (await a.client.listTools()).tools;
    const listB = (await b.client.listTools()).tools;
    expect(listA.map((t) => t.name).sort()).toEqual([...FILE_SEARCH_APP_TOOL_NAMES].sort());
    expect(JSON.stringify(listA)).toEqual(JSON.stringify(listB));
    expect(a.client.getInstructions()).toBe(FILE_SEARCH_APP_INSTRUCTIONS);
  });

  it('sets every hint explicitly and has no executor, share or delete tool', async () => {
    const { client } = await connect([]);
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      expect(t.name).not.toMatch(/search_tools|describe_tool|run_|share|revoke|upload|delete|code/);
      expect(typeof t.annotations?.readOnlyHint).toBe('boolean');
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(typeof t.annotations?.idempotentHint).toBe('boolean');
      expect(t.annotations?.title).toBeTruthy();
      const props = Object.keys((t.inputSchema as any).properties ?? {});
      expect(props).not.toContain('tool');
      expect(props).not.toContain('arguments');
    }
    // Only the link tool stores something; every other tool reads.
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(writes).toEqual(['get_file_link']);
  });

  it('names the protocols and products a folder can be reached with', async () => {
    const { client } = await connect([]);
    const tools = (await client.listTools()).tools;
    const sources = tools.find((t) => t.name === 'list_file_sources')!.description!;
    for (const word of ['SFTP', 'FTPS', 'FTP', 'WebDAV', 'Nextcloud', 'S3', 'Synology', 'QNAP', 'NAS']) {
      expect(sources).toContain(word);
    }
  });

  it('maps only folder sources: no File Share, no other connector, no share_file', () => {
    const ops = [...PRICES, ...FILE_SHARE, CRM, DB].map((t) => [t.name, fileSearchOperation(t)]);
    expect(ops).toEqual(
      expect.arrayContaining([
        ['prices_search', 'search'],
        ['prices_read', 'read'],
        ['prices_get_file', 'get'],
        ['prices_share_file', null],
        ['prices_guide', null],
        ['share_upload', null],
        ['share_revoke', null],
        ['crm_find_customer', null],
        ['sales_execute_query', null],
      ]),
    );
  });

  it('without a folder, says so and gives the setup link, never runs anything', async () => {
    const { client, deps } = await connect([CRM, DB, ...FILE_SHARE]);
    for (const name of ['list_file_sources', 'list_folder']) {
      const { isError, body } = await call(client, name);
      expect(isError).toBe(true);
      expect(body.setupUrl).toBe('https://cloud.example.com/connectors/new/file-search?from=chat');
      expect(body.showToTheUser).toMatch(/never ask for the server address or password/);
    }
    const search = await call(client, 'search_documents', { query: 'Nordtor' });
    expect(search.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('runs one folder through its own tool, with only the arguments passed', async () => {
    const { client, deps } = await connect([...PRICES, CRM]);
    const { body } = await call(client, 'read_document', { path: 'Nordtor/2026.pdf', pages: '4' });
    expect(body).toEqual({ ran: 'c-prices:prices_read', args: { path: 'Nordtor/2026.pdf', pages: '4' } });
    await call(client, 'search_documents', { query: 'UT601', sort: 'newest' });
    expect(deps.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'c-prices:prices_search' }),
      { query: 'UT601', sort: 'newest' },
    );
  });

  it('searches every folder when no source is given, labelling each result', async () => {
    const { client, deps } = await connect([...PRICES, ...CONTRACTS]);
    const { isError, texts } = await call(client, 'search_documents', { query: 'notice period' });
    expect(isError).toBe(false);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(texts.join('\n')).toContain('Folder "Contracts" (source id c-contracts):');
    expect(texts.join('\n')).toContain('Folder "Supplier price lists" (source id c-prices):');
    expect(texts.join('\n')).toContain('c-contracts:contracts_search');
  });

  it('needs a source for a path when more than one folder is connected', async () => {
    const { client, deps } = await connect([...PRICES, ...CONTRACTS]);
    const ambiguous = await call(client, 'read_document', { path: 'a.pdf' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.sources.map((s: any) => s.id).sort()).toEqual(['c-contracts', 'c-prices']);
    expect(deps.execute).not.toHaveBeenCalled();
    const byName = await call(client, 'read_document', { path: 'a.pdf', source: 'contracts' });
    expect(byName.body.ran).toBe('c-contracts:contracts_read');
    const unknown = await call(client, 'read_document', { path: 'a.pdf', source: 'HR' });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toMatch(/No folder 'HR'/);
  });

  it('respects a role that hides one operation of a folder', async () => {
    const searchOnly = source('c-prices', 'prices', 'sftp', ['file_search', 'file_status']);
    const { client, deps } = await connect(searchOnly);
    const read = await call(client, 'read_document', { path: 'a.pdf' });
    expect(read.isError).toBe(true);
    expect(read.body.error).toMatch(/MCP roles/);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('does not serve a folder whose setup is unfinished', async () => {
    const pending = PRICES.map((t) => ({ ...t, setupStatus: 'needs_input' as const }));
    const { client } = await connect(pending);
    const { body } = await call(client, 'list_file_sources');
    expect(body.setupUrl).toBeDefined();
  });

  it('lists folders with protocol, status and notes, never host or user name', async () => {
    const deps = makeDeps({
      execute: jest.fn(async (t: RegisteredTool) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ files: 42, of: t.connectorId }) }],
      })),
    });
    const { client } = await connect([...PRICES, ...CONTRACTS], deps);
    const { body, texts } = await call(client, 'list_file_sources');
    expect(body.sources).toEqual([
      { id: 'c-contracts', name: 'Contracts', protocol: 'webdav', status: { files: 42, of: 'c-contracts' } },
      {
        id: 'c-prices',
        name: 'Supplier price lists',
        protocol: 'sftp',
        status: { files: 42, of: 'c-prices' },
        notes: 'Price lists are in one folder per supplier.',
      },
    ]);
    expect(texts.join('')).not.toMatch(/files\.internal|reader/);
  });
});
