import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';

/**
 * Backup and restore: the file written by GET export-all must be accepted by
 * POST import-all as it is. The unit tests next to the controller call
 * importAll() directly and so never ran the global ValidationPipe, which is
 * where every restore from the UI was rejected.
 */

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);
const TOKEN = 'test-access-token-value';

/** The pipe exactly as main.ts registers it. */
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

/** The DTO class Nest hands to the pipe for the body of importAll(). */
const importAllDto = Reflect.getMetadata(
  'design:paramtypes',
  ConnectorsController.prototype,
  'importAll',
)[1];

const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: importAllDto, data: '' });

/** A stored connector row as Prisma returns it, tools included. */
const storedConnector = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'WhatsApp',
  type: 'REST',
  authType: 'BEARER_TOKEN',
  authConfig: 'ciphertext',
  userId: 'owner',
  organizationId: 'org1',
  baseUrl: 'https://graph.facebook.com/v21.0',
  isActive: true,
  specUrl: null,
  headers: { Accept: 'application/json', 'X-Api-Key': 'test-header-key' },
  config: { adapterSlug: 'whatsapp' },
  envVars: {
    WHATSAPP_ACCESS_TOKEN: TOKEN,
    WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
  },
  tools: [
    {
      id: 't1',
      connectorId: 'c1',
      name: 'whatsapp_send_message',
      description: 'Send a WhatsApp message',
      isEnabled: true,
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
      endpointMapping: { method: 'POST', path: '/{{PHONE_ID}}/messages' },
      responseMapping: null,
      outputSchema: null,
    },
  ],
  ...over,
});

function buildController(over: { prisma?: any; licenseGuard?: any } = {}) {
  const prisma = over.prisma ?? {
    connector: {
      findMany: jest.fn().mockResolvedValue([storedConnector()]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'new1', ...data })),
    },
    mcpTool: { create: jest.fn().mockResolvedValue({}) },
  };
  const mcpServer = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
  const licenseGuard = over.licenseGuard ?? {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn(() => VALID_ENCRYPTION_KEY) };

  const controller = new ConnectorsController(
    {} as any, // connectorsService
    {} as any, // openApiParser
    {} as any, // wsdlParser
    {} as any, // graphqlParser
    {} as any, // postmanParser
    {} as any, // curlParser
    {} as any, // mcpClientEngine
    {} as any, // mcpOAuthService
    {} as any, // catalogResync
    prisma as any,
    mcpServer as any,
    configService as any,
    licenseGuard as any,
    {} as any, // mcpServers
    { isCloud: () => true } as any,
  );
  return { controller, prisma, licenseGuard, mcpServer };
}

const req = (role: string, organizationId = 'org2') => ({
  user: { sub: 'restorer', organizationId, role },
});

/** What the browser downloads: the export, serialised and read back. */
async function exportFile(role: string) {
  const { controller } = buildController();
  const exported = await controller.exportAll(req(role, 'org1'));
  return JSON.parse(JSON.stringify(exported));
}

describe('POST import-all accepts the file written by GET export-all', () => {
  it.each(['ADMIN', 'EDITOR', 'VIEWER'])(
    'a backup exported by %s passes the global ValidationPipe',
    async (role) => {
      const file = await exportFile(role);
      await expect(validate(file)).resolves.toBeDefined();
    },
  );

  it.each(['ADMIN', 'EDITOR'])('%s can restore an admin backup end to end', async (role) => {
    const file = await exportFile('ADMIN');
    const body = await validate(file);
    const { controller, prisma } = buildController();

    const result: any = await controller.importAll(req(role), body);

    expect(result).toMatchObject({ created: 1, tools: 1, skipped: 0, errors: [] });
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: 'WhatsApp',
      type: 'REST',
      baseUrl: 'https://graph.facebook.com/v21.0',
      authType: 'BEARER_TOKEN',
      config: { adapterSlug: 'whatsapp' },
      envVars: { WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890' },
      headers: { Accept: 'application/json', 'X-Api-Key': 'test-header-key' },
    });
    expect(prisma.mcpTool.create.mock.calls[0][0].data).toMatchObject({
      connectorId: 'new1',
      name: 'whatsapp_send_message',
      endpointMapping: { method: 'POST', path: '/{{PHONE_ID}}/messages' },
    });
  });

  it('a non-admin backup restores without secrets, as it was exported', async () => {
    const file = await exportFile('EDITOR');
    const body = await validate(file);
    const { controller, prisma } = buildController();

    await controller.importAll(req('EDITOR'), body);

    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars).toEqual({
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
    });
    expect(data.headers).toEqual({ Accept: 'application/json', 'X-Api-Key': '' });
    expect(data).not.toHaveProperty('maskedEnvVars');
    expect(data).not.toHaveProperty('maskedHeaders');
    expect(JSON.stringify(data)).not.toContain(TOKEN);
  });

  it('never restores authConfig, which the export leaves out', async () => {
    const file = await exportFile('ADMIN');
    const { controller, prisma } = buildController();

    await controller.importAll(req('ADMIN'), await validate(file));

    expect(prisma.connector.create.mock.calls[0][0].data).not.toHaveProperty('authConfig');
  });
});

describe('POST import-all stays in the caller’s organization', () => {
  it('writes every connector into the caller’s organization and under the caller', async () => {
    const file = await exportFile('ADMIN');
    const { controller, prisma } = buildController();

    await controller.importAll(req('ADMIN', 'org2'), await validate(file));

    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.organizationId).toBe('org2');
    expect(data.userId).toBe('restorer');
  });

  it.each(['organizationId', 'userId', 'id', 'authConfig'])(
    'rejects a connector that carries %s',
    async (field) => {
      const file = await exportFile('ADMIN');
      file.connectors[0][field] = 'org1';
      await expect(validate(file)).rejects.toThrow(BadRequestException);
    },
  );

  it('rejects a tool that names another connector', async () => {
    const file = await exportFile('ADMIN');
    file.connectors[0].tools[0].connectorId = 'someone-elses-connector';
    await expect(validate(file)).rejects.toThrow(BadRequestException);
  });

  it('only creates: an existing connector with the same name is skipped, not overwritten', async () => {
    const file = await exportFile('ADMIN');
    const { controller, prisma } = buildController();
    prisma.connector.findFirst.mockResolvedValue({ id: 'existing' });

    const result: any = await controller.importAll(req('ADMIN', 'org2'), await validate(file));

    expect(prisma.connector.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org2', name: 'WhatsApp' },
      select: { id: true },
    });
    expect(prisma.connector.create).not.toHaveBeenCalled();
    expect(prisma.mcpTool.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it('VIEWER still cannot restore', async () => {
    const file = await exportFile('ADMIN');
    const { controller, prisma } = buildController();

    await expect(controller.importAll(req('VIEWER'), await validate(file))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('applies the same licence and trial limit as creating a connector', async () => {
    const file = await exportFile('ADMIN');
    const licenseGuard = {
      checkCanCreateConnector: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('Trial limit reached (3 connectors).')),
    };
    const { controller, prisma } = buildController({ licenseGuard });

    const result: any = await controller.importAll(req('EDITOR', 'org2'), await validate(file));

    expect(licenseGuard.checkCanCreateConnector).toHaveBeenCalledWith('restorer', 'org2');
    expect(prisma.connector.create).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.errors[0]).toContain('Trial limit reached');
  });
});
