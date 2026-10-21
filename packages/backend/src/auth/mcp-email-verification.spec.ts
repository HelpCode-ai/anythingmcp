import { ForbiddenException, Logger } from '@nestjs/common';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  emailVerificationNotice,
  maskEmail,
  McpEmailVerificationFilter,
  McpEmailVerificationRequiredException,
  VERIFY_EMAIL_TOOL,
} from './mcp-email-verification';

describe('maskEmail', () => {
  it('keeps enough to recognise the address and no more', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('ja***@example.com');
    expect(maskEmail('jo@example.com')).toBe('j***@example.com');
    expect(maskEmail('j@example.com')).toBe('j***@example.com');
  });

  it('gives nothing for what is not an address', () => {
    expect(maskEmail(undefined)).toBeUndefined();
    expect(maskEmail('no-at-sign')).toBeUndefined();
    expect(maskEmail('@example.com')).toBeUndefined();
  });
});

describe('emailVerificationNotice', () => {
  it('says what is missing, where the email went, and how to get a new code', () => {
    const text = emailVerificationNotice('https://cloud.anythingmcp.com/', 'jane.doe@example.com');
    expect(text).toMatch(/email address has not been verified/);
    expect(text).toContain('ja***@example.com');
    expect(text).toContain('https://cloud.anythingmcp.com/login');
    expect(text).not.toContain('jane.doe');
  });
});

/**
 * The guard's refusal, as an MCP client receives it. A plain 403 reads as a
 * broken connection; this answers the protocol so the notice reaches the
 * person and the model, with nothing of the workspace in it.
 */
describe('McpEmailVerificationFilter', () => {
  const NOTICE = emailVerificationNotice('https://cloud.example.com', 'jane.doe@example.com');
  let server: Server;
  let base: string;
  const savedJson = process.env.MCP_STREAMABLE_JSON_RESPONSE;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const filter = new McpEmailVerificationFilter();
    const app = express();
    app.use(express.json());
    // Stands in for Nest: the guard throws, the filter gets the exception.
    app.all('/mcp', (req, res) => {
      const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any;
      filter.catch(new McpEmailVerificationRequiredException(NOTICE), host);
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    process.env.MCP_STREAMABLE_JSON_RESPONSE = savedJson;
    jest.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
  });

  const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) =>
    fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  /** The JSON-RPC message of a JSON or SSE-framed answer. */
  const message = async (res: Response) => {
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const data = text.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(data!.slice(6));
    }
    return JSON.parse(text);
  };

  const initialize = () =>
    rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });

  for (const json of [true, false]) {
    describe(json ? 'with JSON responses' : 'with SSE responses', () => {
      beforeAll(() => {
        process.env.MCP_STREAMABLE_JSON_RESPONSE = json ? 'true' : 'false';
      });

      it('lets the client connect and carries the notice in the instructions', async () => {
        const res = await initialize();
        expect(res.status).toBe(200);
        const msg = await message(res);
        expect(msg.result.instructions).toBe(NOTICE);
        expect(msg.result.serverInfo.name).toBe('AnythingMCP');
      });

      it('lists only the verification tool', async () => {
        const msg = await message(await rpc('tools/list'));
        expect(msg.result.tools.map((t: { name: string }) => t.name)).toEqual([VERIFY_EMAIL_TOOL]);
      });

      it('answers any tool call with the notice as an error the model reads', async () => {
        const msg = await message(await rpc('tools/call', { name: 'crm_list_customers', arguments: {} }));
        const text = JSON.stringify(msg);
        expect(text).toContain('ja***@example.com');
        expect(text).not.toContain('jane.doe');
        const call = await message(await rpc('tools/call', { name: VERIFY_EMAIL_TOOL, arguments: {} }));
        expect(call.result.isError).toBe(true);
        expect(call.result.content[0].text).toBe(NOTICE);
      });
    });
  }

  it('works for the current SDK client, whatever protocol revision it negotiates', async () => {
    delete process.env.MCP_STREAMABLE_JSON_RESPONSE;
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base)));
    try {
      expect(client.getInstructions()).toBe(NOTICE);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([VERIFY_EMAIL_TOOL]);
      const result: any = await client.callTool({ name: 'crm_list_customers', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(NOTICE);
    } finally {
      await client.close();
    }
  });

  it('refuses a GET and a listen stream with the notice as a JSON-RPC error', async () => {
    const get = await fetch(base, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(403);
    expect((await get.json()).error.message).toBe(NOTICE);

    const listen = await rpc('subscriptions/listen');
    expect(listen.status).toBe(403);
    expect((await listen.json()).error).toEqual({ code: -32001, message: NOTICE });
  });

  it('is still a 403 with the notice wherever the filter is not in play', () => {
    const err = new McpEmailVerificationRequiredException(NOTICE);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.message).toBe(NOTICE);
  });
});
