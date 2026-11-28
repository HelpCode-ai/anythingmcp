import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  InMemoryTransport, McpServer, SERVER_INFO_META_KEY, WebStandardStreamableHTTPServerTransport,
  type CallToolResult, type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createQuietMcpHandler } from './mcp-handler.util';
import { enableToolProgress } from './tool-progress';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const output: CallToolResult = { content: [{ type: 'text', text: 'finished' }] };
const fakeClock = () => jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });

function slowServer(enabled: boolean, schema = true) {
  const work = deferred<CallToolResult>();
  const started = deferred<ServerContext>();
  const server = new McpServer({ name: 'progress-spec', version: '1' });
  const tool = schema
    ? server.registerTool('slow', { inputSchema: { query: z.string().optional() } }, (_args, context) => {
        started.resolve(context);
        return work.promise;
      })
    : server.registerTool('slow', {}, (context) => {
        started.resolve(context);
        return work.promise;
      });
  enableToolProgress(tool, enabled);
  return { server, started, work };
}

function legacyRequest(token?: string | number): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'slow', arguments: {}, ...(token !== undefined ? { _meta: { progressToken: token } } : {}) },
    }),
  });
}

describe('progress through real SDK transports', () => {
  afterEach(() => jest.useRealTimers());

  it.each([true, false])('reports legacy SSE progress with input schema=%p', async (schema) => {
    fakeClock();
    const fixture = slowServer(true, schema);
    const handler = createQuietMcpHandler(() => fixture.server, { legacy: 'stateless', responseMode: 'sse' });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const responsePending = handler.fetch(legacyRequest(0));
      const context = await fixture.started.promise;
      expect(context.mcpReq._meta?.progressToken).toBe(0);
      await jest.advanceTimersByTimeAsync(5_000);
      const response = await responsePending;
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('notifications/progress');
      expect(first).toContain('"progressToken":0');
      expect(first).toContain('"progress":5');
      expect(first).not.toContain('finished');
      fixture.work.resolve(output);
      let rest = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).toContain('finished');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      fixture.work.resolve(output);
      await reader?.cancel();
      await handler.close();
    }
  });

  it('keeps legacy JSON a single final response with no timer despite a token', async () => {
    fakeClock();
    const fixture = slowServer(false);
    // The production legacy JSON path uses this transport with the same options.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await fixture.server.connect(transport);
    try {
      const responsePending = transport.handleRequest(legacyRequest('json-call'));
      await fixture.started.promise;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(jest.getTimerCount()).toBe(0);
      fixture.work.resolve(output);
      const response = await responsePending;
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: output });
    } finally {
      fixture.work.resolve(output);
      await transport.close();
      await fixture.server.close();
    }
  });

  it.each([
    ['sse', false], ['json', false], ['sse', true], ['json', true],
  ] as const)('preserves modern HTTP %s framing (cancel=%p)', async (mode, cancel) => {
    const work = deferred<CallToolResult>(), started = deferred<ServerContext>();
    const framing: string[] = [];
    const handler = createQuietMcpHandler(() => {
      const server = new McpServer({ name: 'modern-progress', version: '1' });
      const tool = server.registerTool('slow', { inputSchema: {} }, (_args, context) => {
        started.resolve(context);
        return work.promise;
      });
      enableToolProgress(tool, mode === 'sse');
      return server;
    }, { legacy: 'stateless', responseMode: mode });
    const client = new Client({ name: 'progress-client', version: '1' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        const response = await handler.fetch(request);
        if (request.headers.get('mcp-method') === 'tools/call') framing.push(response.headers.get('content-type') ?? '');
        return response;
      },
    });
    try {
      await client.connect(transport);
      fakeClock();
      const progress = jest.fn();
      const controller = new AbortController();
      const call = client.callTool({ name: 'slow', arguments: {} }, { onprogress: progress, signal: controller.signal });
      // A failing assertion must not turn fixture cleanup into an unhandled rejection.
      void call.catch(() => undefined);
      const context = await started.promise;
      expect(context.mcpReq.envelope).toBeDefined();
      await jest.advanceTimersByTimeAsync(5_000);
      if (mode === 'sse') expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 5 }));
      else expect(progress).not.toHaveBeenCalled();
      if (cancel) {
        controller.abort();
        await expect(call).rejects.toBeDefined();
        await jest.advanceTimersByTimeAsync(0);
        expect(context.mcpReq.signal.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        return;
      }
      work.resolve(output);
      await expect(call).resolves.toEqual({
        ...output,
        _meta: { [SERVER_INFO_META_KEY]: { name: 'modern-progress', version: '1' } },
      });
      expect(framing).toEqual([expect.stringContaining(mode === 'sse' ? 'text/event-stream' : 'application/json')]);
    } finally {
      work.resolve(output);
      await client.close();
      await handler.close();
    }
  });

  it('cleans up on an SDK cancellation while the tool remains unresolved', async () => {
    const fixture = slowServer(true);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cancelling-client', version: '1' });
    await fixture.server.connect(serverSide);
    await client.connect(clientSide);
    try {
      fakeClock();
      const controller = new AbortController();
      const call = client.callTool({ name: 'slow', arguments: {} }, { signal: controller.signal, onprogress: jest.fn() });
      const rejected = expect(call).rejects.toBeDefined();
      const context = await fixture.started.promise;
      await jest.advanceTimersByTimeAsync(5_000);
      controller.abort();
      await rejected;
      await jest.advanceTimersByTimeAsync(0);
      expect(context.mcpReq.signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      fixture.work.resolve(output);
      await client.close();
      await fixture.server.close();
    }
  });
});
