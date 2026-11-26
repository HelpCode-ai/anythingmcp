import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';

/**
 * Code tools that arrive through an import (JSON tool definitions, a backup
 * file) get the same save-time checks and plan cap as a single create: every
 * connector in `uses` must belong to the caller's workspace, definer rights are
 * admin-only, writes need Enterprise. Nothing is written when a check fails.
 */

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);

const codeTool = (over: Record<string, unknown> = {}) => ({
  name: 'summary',
  description: 'A code tool',
  parameters: { type: 'object', properties: {} },
  endpointMapping: {
    method: 'code',
    code: 'return 1;',
    uses: [{ connectorId: 'own-1' }],
    runAs: 'invoker',
    allowWrites: false,
    ...over,
  },
});

/** Connectors that exist, by organization. */
const CONNECTORS = [
  { id: 'own-1', name: 'Own', organizationId: 'org1' },
  { id: 'foreign-1', name: 'Foreign', organizationId: 'org2' },
];

function build(over: { existingTools?: any[]; licenseGuard?: any; edition?: any } = {}) {
  const prisma = {
    connector: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        CONNECTORS.filter(
          (c) =>
            c.organizationId === where.organizationId &&
            (where.id ? where.id.in.includes(c.id) : where.name.in.includes(c.name)),
        ).map((c) => ({ id: c.id, name: c.name })),
      ),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        CONNECTORS.find((c) => c.organizationId === where.organizationId && c.name === where.name) ?? null,
      ),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'new-1', ...data })),
      update: jest.fn(),
    },
    mcpTool: {
      findMany: jest.fn().mockResolvedValue(over.existingTools ?? []),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'tool-new', ...data })),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
  };
  const mcpServer = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
  const licenseGuard = over.licenseGuard ?? {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
    checkCanCreateCodeTool: jest.fn().mockResolvedValue(undefined),
  };
  const connectorsService = {
    findById: jest.fn().mockResolvedValue({
      id: 'own-1',
      name: 'Own',
      type: 'REST',
      organizationId: 'org1',
      userId: 'u1',
      envVars: null,
    }),
  };
  const edition = over.edition ?? { assertEnterprise: jest.fn().mockResolvedValue(undefined) };
  const controller = new ConnectorsController(
    connectorsService as any,
    {} as any, // openApiParser
    {} as any, // wsdlParser
    {} as any, // graphqlParser
    {} as any, // postmanParser
    {} as any, // curlParser
    {} as any, // harParser
    {} as any, // mcpClientEngine
    {} as any, // mcpOAuthService
    {} as any, // catalogResync
    prisma as any,
    mcpServer as any,
    { get: jest.fn(() => VALID_ENCRYPTION_KEY) } as any,
    licenseGuard as any,
    {} as any, // mcpServers
    { isCloud: () => true } as any,
    { recentEvents: jest.fn().mockResolvedValue([]) } as any, // webhookEvents
    edition as any,
  );
  return { controller, prisma, mcpServer, licenseGuard, edition };
}

const req = (role = 'ADMIN') => ({ user: { sub: 'u1', organizationId: 'org1', role } });

const importJson = (controller: ConnectorsController, tools: unknown[], role = 'ADMIN') =>
  controller.importTools(req(role), 'own-1', { source: 'json', content: JSON.stringify(tools) } as any);

describe('POST :id/import (JSON) — code tools', () => {
  it('refuses a code tool whose uses names a connector of another workspace, and writes nothing', async () => {
    const { controller, prisma, mcpServer } = build();
    const err = await importJson(controller, [codeTool({ uses: [{ connectorId: 'foreign-1' }] })]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(
      'Tool summary: A code tool can only use connectors from its own workspace. Unknown or foreign connector(s): foreign-1.',
    );
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    expect(prisma.mcpTool.update).not.toHaveBeenCalled();
    expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
  });

  it('refuses definer rights for a connector owner who is not an admin', async () => {
    const { controller, prisma } = build();
    await expect(importJson(controller, [codeTool({ runAs: 'definer' })], 'EDITOR')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('requires Enterprise for a code tool that writes', async () => {
    const edition = { assertEnterprise: jest.fn().mockRejectedValue(new ForbiddenException('Enterprise only')) };
    const { controller, prisma } = build({ edition });
    await expect(importJson(controller, [codeTool({ allowWrites: true })])).rejects.toThrow(/Tool summary: Enterprise only/);
    expect(edition.assertEnterprise).toHaveBeenCalledWith('org1', 'Code tools that write');
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('applies the plan cap to the code tools it creates', async () => {
    const licenseGuard = {
      checkCanCreateCodeTool: jest.fn().mockRejectedValue(new ForbiddenException('Plan limit reached')),
    };
    const { controller, prisma } = build({ licenseGuard });
    await expect(importJson(controller, [codeTool()])).rejects.toThrow(/Plan limit reached/);
    expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1', 1);
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('imports a same-workspace code tool as before', async () => {
    const { controller, prisma, licenseGuard } = build();
    const out: any = await importJson(controller, [codeTool()]);
    expect(out.created).toBe(1);
    expect(prisma.mcpTool.create.mock.calls[0][0].data.endpointMapping).toEqual(codeTool().endpointMapping);
    expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1', 1);
  });

  it('does not count a code tool that updates an existing tool of the same name', async () => {
    const existing = [
      { id: 't1', name: 'summary', operationId: null, endpointMapping: codeTool().endpointMapping, deprecatedAt: null, isEnabled: true },
    ];
    const { controller, prisma, licenseGuard } = build({ existingTools: existing });
    await importJson(controller, [codeTool({ code: 'return 2;' })]);
    expect(licenseGuard.checkCanCreateCodeTool).not.toHaveBeenCalled();
    expect(prisma.mcpTool.update).toHaveBeenCalledTimes(1);
  });

  it('leaves imports without code tools unchanged', async () => {
    const { controller, prisma, licenseGuard } = build();
    await importJson(controller, [
      { name: 'get_orders', description: 'd', parameters: {}, endpointMapping: { method: 'GET', path: '/orders' } },
    ]);
    expect(licenseGuard.checkCanCreateCodeTool).not.toHaveBeenCalled();
    expect(prisma.connector.findMany).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).toHaveBeenCalledTimes(1);
  });
});

describe('POST import-all — code tools', () => {
  const backup = (connectorName: string, tools: unknown[]) =>
    ({
      connectors: [
        { name: connectorName, type: 'REST', baseUrl: 'https://api.example.test', authType: 'NONE', tools },
      ],
    }) as any;

  it('refuses a code tool whose uses names a connector of another workspace, and writes nothing', async () => {
    const { controller, prisma } = build();
    const err = await controller
      .importAll(req(), backup('Restored', [codeTool({ uses: [{ connectorId: 'foreign-1' }] })]))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/^connectors\[0\]\.tools\[0\]: A code tool can only use connectors from its own workspace/);
    expect(prisma.connector.create).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
  });

  it('applies the plan cap to code tools of connectors it creates', async () => {
    const { controller, prisma, licenseGuard } = build();
    const result: any = await controller.importAll(req(), backup('Restored', [codeTool()]));
    expect(licenseGuard.checkCanCreateCodeTool).toHaveBeenCalledWith('org1', 1);
    expect(result).toMatchObject({ created: 1, tools: 1, errors: [] });
    expect(prisma.mcpTool.create.mock.calls[0][0].data.endpointMapping.method).toBe('code');
  });

  it('does not count code tools of a connector skipped as a duplicate', async () => {
    const { controller, licenseGuard } = build();
    const result: any = await controller.importAll(req(), backup('Own', [codeTool()]));
    expect(licenseGuard.checkCanCreateCodeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });
});
