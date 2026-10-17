import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { ForbiddenException } from '@nestjs/common';
import {
  CODEBOUND_TOOLS,
  CodeboundConnection,
  CodeboundRegistry,
  codeboundEntries,
} from './codebound-tools';

const connection: CodeboundConnection = {
  userId: 'u1',
  email: 'a@example.com',
  organizationId: 'o1',
  authMethod: 'jwt',
  endpointServerId: 's1',
  oauthClientId: 'client-a',
};

describe('Codebound MCP tool contracts', () => {
  it('publishes real SDK schemas and separates execution from persistence annotations', async () => {
    const call = jest.fn().mockResolvedValue({ result: { answer: 42 } });
    const server = new McpServer({ name: 'spec', version: '1' });
    for (const entry of codeboundEntries({ call }, connection))
      entry.register(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' });
    await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(
        CODEBOUND_TOOLS.map((tool) => tool.name),
      );
      expect(
        tools.find((tool) => tool.name === 'codebound_run')?.annotations
          ?.readOnlyHint,
      ).toBe(true);
      expect(
        tools.find((tool) => tool.name === 'codebound_save_script')?.annotations
          ?.readOnlyHint,
      ).toBe(false);
      const result: any = await client.callTool({
        name: 'codebound_run',
        arguments: { code: 'return 42;', allowedTools: [] },
      });
      expect(JSON.parse(result.content[0].text)).toEqual({
        result: { answer: 42 },
      });
      expect(call).toHaveBeenCalledWith(
        connection,
        'codebound_run',
        expect.objectContaining({ code: 'return 42;' }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns bounded errors without serializing raw host exceptions', async () => {
    for (const error of [
      new Error('password=private-secret'),
      new ForbiddenException('Tool access denied'),
    ]) {
      const entry = codeboundEntries(
        {
          call: async () => {
            throw error;
          },
        },
        connection,
      )[0];
      const result = await entry.call({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('private-secret');
      expect(result.content[0].text).toContain(
        error instanceof ForbiddenException
          ? 'Tool access denied'
          : 'Codebound request failed',
      );
    }
    const result = await codeboundEntries(
      { call: async () => 'x'.repeat(262144) },
      connection,
    )[0].call({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('256 KiB');
  });

  it('binds reused session handlers to the current client without leaking concurrent scopes', async () => {
    const registry = new CodeboundRegistry();
    const call = jest.fn(async (ctx: CodeboundConnection) => {
      await Promise.resolve();
      return ctx.oauthClientId;
    });
    registry.register({ call });
    const reused = codeboundEntries(registry.get()!, connection)[0];
    const results = await Promise.all([
      registry.withConnection(
        { ...connection, oauthClientId: 'client-b' },
        () => reused.call({}),
      ),
      registry.withConnection(
        { ...connection, oauthClientId: 'client-c' },
        () => reused.call({}),
      ),
    ]);
    expect(results.map((result) => JSON.parse(result.content[0].text))).toEqual(
      ['client-b', 'client-c'],
    );
    expect(JSON.parse((await reused.call({})).content[0].text)).toBe(
      'client-a',
    );
  });
});
