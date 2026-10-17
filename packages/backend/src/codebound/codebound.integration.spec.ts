import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { RestEngine } from '../connectors/engines/rest.engine';
import { DynamicMcpTools } from '../mcp-server/dynamic-mcp-tools';
import { RegisteredTool } from '../mcp-server/tool-registry';
import { CodeboundService } from './codebound.service';

describe('Codebound through the REST executor', () => {
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          id: 1,
          title: 'Demo post',
          body: 'Intermediate data',
          private: 'Hidden by the response mapping',
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(
    () => new Promise<void>((resolve) => server?.close(() => resolve())),
  );

  it('makes a real connector read, filters its response, and audits both levels', async () => {
    const tool: RegisteredTool = {
      id: 'tool-a',
      connectorId: 'connector-a',
      organizationId: 'org-a',
      name: 'setup_demo_get_post',
      description: 'Read a demo post',
      parameters: { type: 'object', properties: {} },
      connectorType: 'REST',
      connectorConfig: { baseUrl: origin, authType: 'NONE' },
      endpointMapping: { method: 'GET', path: '/posts/1' },
      responseMapping: { transform: { exclude: ['private'] } },
    };
    const registry = {
      getAllTools: () => [tool],
      getTool: () => tool,
      getToolForOrg: () => tool,
    };
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const security = { log: jest.fn().mockResolvedValue(undefined) };
    const license = {
      checkLicenseActive: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      mcpServerConfig: {
        findFirst: jest.fn().mockResolvedValue({
          connectors: [{ connectorId: tool.connectorId }],
        }),
      },
    };
    const executor = new DynamicMcpTools(
      registry as any,
      audit as any,
      {} as any,
      license as any,
      { isCloud: () => false } as any,
      prisma as any,
      new RestEngine({} as any, {} as any),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
    );
    const service = new CodeboundService(
      prisma as any,
      { getAllowedToolIds: async () => null } as any,
      registry as any,
      executor,
      license as any,
      security as any,
    );
    const output = await service.run(
      { sub: 'user-a', email: 'a@example.com', organizationId: 'org-a' },
      'server-a',
      {
        allowedTools: [tool.name],
        input: {},
        code: `
        const post = await tools.call('setup_demo_get_post', {});
        if ('private' in post) throw new Error('Response mapping was bypassed');
        return { id: post.id, title: post.title };
      `,
      },
    );
    expect(output.result).toEqual({ id: 1, title: 'Demo post' });
    expect(requests).toEqual(['/posts/1']);
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        toolId: tool.id,
        intent: `Codebound run ${output.runId}`,
      }),
    );
    expect(security.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          runId: output.runId,
          status: 'SUCCESS',
        }),
      }),
    );
  });
});
