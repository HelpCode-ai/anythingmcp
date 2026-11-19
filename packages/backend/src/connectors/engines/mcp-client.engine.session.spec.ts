import { createServer, type Server } from 'node:http';
import { McpClientEngine } from './mcp-client.engine';
import { OAuth2TokenService } from './oauth2-token.service';

// Skip the SSRF preflight for this loopback fixture. The SDK and HTTP transport
// are real, including the engine's guarded fetch (there are no redirects).
jest.mock('../../common/ssrf.util', () => ({
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

describe('McpClientEngine remote session lifecycle (real HTTP transport)', () => {
  let server: Server;
  let baseUrl: string;
  let engine: McpClientEngine;
  let sessions: Set<string>;
  let requests: Array<{ method: string; session?: string; authorization?: string }>;
  let sessionNumber: number;
  let stateful: boolean;
  let deleteStatus: number;
  let deleteHangs: boolean;
  let deleteClosures: Promise<void>[];
  let callStatus: number;
  let listStatus: number;
  let responseMode: 'json' | 'sse';
  let unauthorizedCalls: number;
  let renewAfterRejection: jest.Mock;

  const result = { content: [{ type: 'text', text: 'Tool completed' }] };
  const mapping = { method: 'echo', path: '/mcp' };
  const config = () => ({ baseUrl, authType: 'NONE' });

  // execute/listTools now finish before the background DELETE reaches HTTP.
  async function waitForDeletes(count = 1): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (requests.filter((r) => r.method === 'DELETE').length < count) {
      if (Date.now() >= deadline) throw new Error(`Expected ${count} background DELETE request(s)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function withoutWaitingForCleanup<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Operation waited for session cleanup')), 2_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  beforeEach(async () => {
    sessions = new Set();
    requests = [];
    sessionNumber = 0;
    stateful = true;
    deleteStatus = 200;
    deleteHangs = false;
    deleteClosures = [];
    callStatus = 200;
    listStatus = 200;
    responseMode = 'json';
    unauthorizedCalls = 0;
    renewAfterRejection = jest.fn().mockResolvedValue('renewed-test-token');
    engine = new McpClientEngine({
      getAccessToken: jest.fn().mockResolvedValue('old-test-token'),
      renewAfterRejection,
    } as unknown as OAuth2TokenService);

    server = createServer(async (req, res) => {
      const session = req.headers['mcp-session-id'] as string | undefined;
      requests.push({ method: req.method!, session, authorization: req.headers.authorization });
      if (req.method === 'GET') { res.writeHead(405).end(); return; }
      if (req.method === 'DELETE') {
        if (deleteHangs) {
          deleteClosures.push(new Promise<void>((resolve) => { res.once('close', resolve); }));
          return;
        }
        if (deleteStatus === 200 && session) sessions.delete(session);
        res.writeHead(deleteStatus).end();
        return;
      }

      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let response: unknown;
      let createdSession: string | undefined;
      if (message.method === 'initialize') {
        if (stateful) {
          createdSession = `bridge-test-${++sessionNumber}`;
          sessions.add(createdSession);
        }
        response = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'session-fixture', version: '1' },
        };
      } else if (message.method === 'tools/list') {
        if (listStatus !== 200) { res.writeHead(listStatus).end('discovery fixture failure'); return; }
        response = { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      } else if (message.method === 'tools/call') {
        if (unauthorizedCalls > 0) {
          unauthorizedCalls--;
          res.writeHead(401).end('token refused');
          return;
        }
        if (callStatus !== 200) { res.writeHead(callStatus).end('upstream fixture failure'); return; }
        response = result;
      } else { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': responseMode === 'json' ? 'application/json' : 'text/event-stream',
        ...(createdSession ? { 'Mcp-Session-Id': createdSession } : {}),
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response });
      res.end(responseMode === 'json' ? payload : `event: message\ndata: ${payload}\n\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });

  it.each(['json', 'sse'] as const)('terminates the upstream session after a successful %s tool call', async (mode) => {
    responseMode = mode;
    await expect(engine.execute(config(), mapping, {})).resolves.toEqual(result);
    await waitForDeletes();
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.session)).toEqual(['bridge-test-1']);
    expect(sessions.size).toBe(0);
  });

  it('terminates the discovery session after listing tools', async () => {
    await expect(engine.listTools(config())).resolves.toEqual([
      { name: 'echo', description: '', inputSchema: { type: 'object' } },
    ]);
    await waitForDeletes();
    expect(sessions.size).toBe(0);
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('terminates the upstream session when a tool request fails', async () => {
    callStatus = 500;
    await expect(engine.execute(config(), mapping, {})).rejects.toThrow(/upstream fixture failure/);
    await waitForDeletes();
    expect(sessions.size).toBe(0);
  });

  it('terminates the discovery session when tools/list fails', async () => {
    listStatus = 500;
    await expect(engine.listTools(config())).rejects.toThrow(/discovery fixture failure/);
    await waitForDeletes();
    expect(sessions.size).toBe(0);
  });

  it('cleans up both sessions after an OAuth retry, using each session\'s own headers', async () => {
    unauthorizedCalls = 1;
    await expect(engine.execute({
      baseUrl,
      authType: 'OAUTH2',
      authConfig: { tokenUrl: `${baseUrl}/token`, refreshToken: 'test-refresh-token' },
      connectorId: 'test-connector',
    }, mapping, {})).resolves.toEqual(result);
    await waitForDeletes(2);
    expect(renewAfterRejection).toHaveBeenCalledTimes(1);
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual(expect.arrayContaining([
      { method: 'DELETE', session: 'bridge-test-1', authorization: 'Bearer old-test-token' },
      { method: 'DELETE', session: 'bridge-test-2', authorization: 'Bearer renewed-test-token' },
    ]));
    expect(sessions.size).toBe(0);
  });

  it.each([405, 500])('keeps the tool result when the server refuses termination with HTTP %s', async (status) => {
    deleteStatus = status;
    await expect(engine.execute(config(), mapping, {})).resolves.toEqual(result);
    await waitForDeletes();
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('aborts a hanging DELETE after the cleanup deadline and preserves the result', async () => {
    deleteHangs = true;
    await expect(withoutWaitingForCleanup(engine.execute(config(), mapping, {}))).resolves.toEqual(result);
    await waitForDeletes();
    expect(sessions.size).toBe(1);
    await Promise.all(deleteClosures);
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  }, 15_000);

  it('returns an OAuth retry result while both session DELETEs are hanging', async () => {
    deleteHangs = true;
    unauthorizedCalls = 1;
    await expect(withoutWaitingForCleanup(engine.execute({
      baseUrl,
      authType: 'OAUTH2',
      authConfig: { tokenUrl: `${baseUrl}/token`, refreshToken: 'test-refresh-token' },
      connectorId: 'test-connector',
    }, mapping, {}))).resolves.toEqual(result);
    await waitForDeletes(2);
    expect(sessions.size).toBe(2);
    await Promise.all(deleteClosures);
  }, 15_000);

  it('sends no DELETE when the upstream is stateless', async () => {
    stateful = false;
    await expect(engine.execute(config(), mapping, {})).resolves.toEqual(result);
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });
});
