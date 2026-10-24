import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import * as yaml from 'js-yaml';
import { ConnectorsController } from './connectors.controller';
import { exportFileName } from './connector-export.util';

/**
 * Single-connector export (GET :id/export, JSON or YAML) and file import
 * (POST import). The file must round-trip into another organization, and a
 * YAML file must be validated exactly like a JSON body sent to import-all.
 */

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);
const TOKEN = 'test-access-token-value';
const CLIENT_SECRET = 'oauth-client-secret-value';

/** The pipe exactly as main.ts registers it. */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

const paramType = (method: string, index: number) =>
  Reflect.getMetadata('design:paramtypes', ConnectorsController.prototype, method)[index];

const validateImportAll = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: paramType('importAll', 1), data: '' });
const validateImportFile = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: paramType('importFile', 1), data: '' });

/** An OAuth connector with tool-level settings, as Prisma returns it. */
const oauthConnector = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Acme CRM (EU)',
  type: 'REST',
  authType: 'OAUTH2',
  authConfig: {
    clientId: 'acme-client',
    clientSecret: CLIENT_SECRET,
    tokenUrl: 'https://auth.acme.test/token',
  },
  userId: 'owner',
  organizationId: 'org1',
  baseUrl: 'https://api.acme.test/v2',
  isActive: true,
  specUrl: 'https://api.acme.test/openapi.json',
  headers: { Accept: 'application/json', 'X-Api-Key': 'test-header-key' },
  config: { region: 'eu', retries: 2 },
  envVars: { ACME_ACCESS_TOKEN: TOKEN, ACME_TENANT_ID: '42' },
  tools: [
    {
      id: 't1',
      connectorId: 'c1',
      name: 'acme_list_contacts',
      description: 'List contacts',
      isEnabled: false,
      useProxy: true,
      annotations: { readOnlyHint: true },
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      endpointMapping: {
        method: 'GET',
        path: '/contacts',
        headers: { 'X-Tenant': '{{ACME_TENANT_ID}}' },
      },
      responseMapping: { path: 'data.items' },
      outputSchema: { type: 'object', properties: { items: { type: 'array' } } },
    },
  ],
  ...over,
});

function buildController(over: { stored?: any; licenseGuard?: any } = {}) {
  const stored = over.stored === undefined ? oauthConnector() : over.stored;
  const prisma = {
    connector: {
      findMany: jest.fn().mockResolvedValue(stored ? [stored] : []),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        where.id ? stored : null,
      ),
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
    {} as any, // harParser
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
  return { controller, prisma, licenseGuard };
}

const req = (role: string, organizationId = 'org2') => ({
  user: { sub: 'importer', organizationId, role },
});

const fakeRes = () => {
  const headers: Record<string, string> = {};
  return { headers, setHeader: jest.fn((k: string, v: string) => (headers[k] = v)) };
};

/** Export connector c1 from org1 and return the raw file text and headers. */
async function exportText(format: 'json' | 'yaml' | undefined, role = 'ADMIN') {
  const { controller } = buildController();
  const res = fakeRes();
  const text = await controller.exportOne(req(role, 'org1'), 'c1', format, res as any);
  return { text: text as string, headers: res.headers };
}

const parse = (text: string, format: 'json' | 'yaml') =>
  format === 'json' ? JSON.parse(text) : (yaml.load(text, { schema: yaml.CORE_SCHEMA }) as any);

/** Import a file's text through the whole path the HTTP request takes. */
async function importText(content: string, role = 'ADMIN', org = 'org2') {
  const built = buildController({ stored: null });
  const dto = await validateImportFile({ content });
  const result: any = await built.controller.importFile(req(role, org), dto);
  return { ...built, result };
}

const EXPORTED_TOOL_FIELDS = [
  'name',
  'description',
  'isEnabled',
  'parameters',
  'endpointMapping',
  'responseMapping',
  'outputSchema',
];

describe('GET :id/export', () => {
  it.each(['json', 'yaml'] as const)('writes a %s file with one connector', async (format) => {
    const { text, headers } = await exportText(format);
    const file = parse(text, format);

    expect(file).toMatchObject({ version: '1.0', secretsIncluded: true });
    expect(file.connectors).toHaveLength(1);
    expect(file.connectors[0].name).toBe('Acme CRM (EU)');
    expect(headers['Content-Type']).toBe(
      format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8',
    );
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="acme-crm-eu.anythingmcp.${format}"`,
    );
  });

  it('defaults to JSON and rejects an unknown format', async () => {
    const { headers } = await exportText(undefined);
    expect(headers['Content-Type']).toContain('application/json');
    await expect(exportText('xml' as any)).rejects.toThrow(BadRequestException);
  });

  it('keeps exportedAt a string in YAML (core schema, no timestamp type)', async () => {
    const { text } = await exportText('yaml');
    expect(typeof parse(text, 'yaml').exportedAt).toBe('string');
  });

  it.each(['json', 'yaml'] as const)('never writes authConfig (%s)', async (format) => {
    const { text } = await exportText(format);
    expect(parse(text, format).connectors[0]).not.toHaveProperty('authConfig');
    expect(text).not.toContain('authConfig');
    expect(text).not.toContain(CLIENT_SECRET);
  });

  it.each(['json', 'yaml'] as const)(
    'masks secrets for a non-admin and names them (%s)',
    async (format) => {
      const { text } = await exportText(format, 'EDITOR');
      const entry = parse(text, format).connectors[0];

      expect(parse(text, format).secretsIncluded).toBe(false);
      expect(entry.envVars).toEqual({ ACME_ACCESS_TOKEN: '', ACME_TENANT_ID: '42' });
      expect(entry.maskedEnvVars).toEqual(['ACME_ACCESS_TOKEN']);
      expect(entry.headers['X-Api-Key']).toBe('');
      expect(entry.maskedHeaders).toEqual(['X-Api-Key']);
      expect(text).not.toContain(TOKEN);
    },
  );

  it('refuses a connector of another organization with 403', async () => {
    const { controller } = buildController();
    await expect(
      controller.exportOne(req('ADMIN', 'org2'), 'c1', 'json', fakeRes() as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns 404 for an unknown connector', async () => {
    const { controller } = buildController({ stored: null });
    await expect(
      controller.exportOne(req('ADMIN', 'org1'), 'missing', 'json', fakeRes() as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('builds a safe ASCII file name', () => {
    expect(exportFileName('Ünïcode "quoted"/name', 'yaml')).toBe(
      'unicode-quoted-name.anythingmcp.yaml',
    );
    expect(exportFileName('日本語', 'json')).toBe('connector.anythingmcp.json');
  });
});

describe('round trip: export from one organization, import into another', () => {
  it.each(['json', 'yaml'] as const)(
    'an OAuth connector with tool settings survives (%s)',
    async (format) => {
      const { text } = await exportText(format);
      const { prisma, result } = await importText(text);
      const source = oauthConnector();

      expect(result).toMatchObject({ created: 1, tools: 1, skipped: 0, errors: [] });
      const data = prisma.connector.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        organizationId: 'org2',
        userId: 'importer',
        name: source.name,
        type: source.type,
        baseUrl: source.baseUrl,
        authType: 'OAUTH2',
        specUrl: source.specUrl,
        config: source.config,
        headers: source.headers,
        envVars: source.envVars,
      });
      // OAuth client settings live in authConfig, which is never exported:
      // the imported connector has to be authorized again.
      expect(data).not.toHaveProperty('authConfig');

      const tool = prisma.mcpTool.create.mock.calls[0][0].data;
      for (const field of EXPORTED_TOOL_FIELDS) {
        expect(tool[field]).toEqual((source.tools[0] as any)[field]);
      }
      // Known limit: per-tool proxy and annotation overrides are not exported.
      expect(tool).not.toHaveProperty('useProxy');
      expect(tool).not.toHaveProperty('annotations');
    },
  );

  it('a single-connector file is accepted by import-all as well', async () => {
    const { text } = await exportText('json');
    const { controller, prisma } = buildController({ stored: null });
    const result: any = await controller.importAll(
      req('ADMIN'),
      await validateImportAll(JSON.parse(text)),
    );
    expect(result.created).toBe(1);
    expect(prisma.connector.create.mock.calls[0][0].data.organizationId).toBe('org2');
  });

  it('a non-admin export imports with secrets left empty', async () => {
    const { text } = await exportText('yaml', 'EDITOR');
    const { prisma } = await importText(text, 'EDITOR');
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars).toEqual({ ACME_ACCESS_TOKEN: '', ACME_TENANT_ID: '42' });
    expect(JSON.stringify(data)).not.toContain(TOKEN);
  });
});

describe('POST import', () => {
  it('VIEWER gets 403 and nothing is parsed or created', async () => {
    const { text } = await exportText('yaml');
    const { controller, prisma } = buildController({ stored: null });
    await expect(
      controller.importFile(req('VIEWER'), await validateImportFile({ content: text })),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.importFile(req('VIEWER'), { content: 'not: [valid' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.connector.create).not.toHaveBeenCalled();
  });

  it('reports a YAML syntax error with 400 and its line and column', async () => {
    const content = 'version: "1.0"\nconnectors:\n  - name: [unclosed\n';
    const err: any = await importText(content).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/at line \d+, column \d+/);
  });

  it.each(['json', 'yaml'] as const)(
    'accepts a bare connector object in a %s file',
    async (format) => {
      const { text } = await exportText(format);
      const bare = parse(text, format).connectors[0];
      const content = format === 'json' ? JSON.stringify(bare) : yaml.dump(bare);
      const { result } = await importText(content);
      expect(result.created).toBe(1);
    },
  );

  it.each(['json', 'yaml'] as const)(
    'accepts a bare array of connectors in a %s file',
    async (format) => {
      const { text } = await exportText(format);
      const bare = parse(text, format).connectors;
      const content = format === 'json' ? JSON.stringify(bare) : yaml.dump(bare);
      const { result } = await importText(content);
      expect(result.created).toBe(1);
    },
  );

  it.each(['json', 'yaml'] as const)(
    'rejects an unknown property in a bare %s connector',
    async (format) => {
      const { text } = await exportText(format);
      const bare = parse(text, format).connectors[0];
      bare.tools[0].useProxy = true;
      const content = format === 'json' ? JSON.stringify(bare) : yaml.dump(bare);
      const err: any = await importText(content).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err.getResponse())).toContain('useProxy');
    },
  );

  it('rejects a billion-laughs style alias bomb with 400, quickly', async () => {
    const levels = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i <= 6; i++) {
      levels.push(`l${i}: &l${i} [${Array(10).fill(`*l${i - 1}`).join(', ')}]`);
    }
    const content = `name: Bomb\ntype: REST\nbaseUrl: https://x.test\nconfig:\n${levels
      .map((l) => `  ${l}`)
      .join('\n')}\n`;
    const started = Date.now();
    const err: any = await importText(content).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/aliases/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a self-referencing anchor with 400, not a stack overflow', async () => {
    const content = 'name: Loop\ntype: REST\nbaseUrl: https://x.test\nconfig: &c\n  self: *c\n';
    const err: any = await importText(content).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/aliases/);
  });

  it.each(['config', 'envVars', 'tool endpointMapping'])(
    'rejects an anchored string repeated through aliases in %s with 400, quickly',
    async (where) => {
      const big = 'a'.repeat(100_000);
      const refs = Array(60).fill('*s').join(', ');
      const head = 'name: StrBomb\ntype: REST\nbaseUrl: https://x.test\n';
      const content =
        where === 'config'
          ? `${head}config:\n  s: &s ${big}\n  list: [${refs}]\n`
          : where === 'envVars'
            ? `${head}config:\n  s: &s ${big}\nenvVars:\n${Array.from(
                { length: 60 },
                (_, i) => `  V${i}: *s`,
              ).join('\n')}\n`
            : `${head}config:\n  s: &s ${big}\ntools:\n  - name: t\n    endpointMapping:\n      method: GET\n      path: /x\n      queryParams: [${refs}]\n`;
      const started = Date.now();
      const err: any = await importText(content).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/aliases are expanded/);
      expect(Date.now() - started).toBeLessThan(2000);
    },
  );

  it('rejects an unusable baseUrl with 400 naming the connector and imports nothing', async () => {
    const { text } = await exportText('yaml');
    const file = parse(text, 'yaml');
    file.connectors[0].baseUrl = 'ftp://files.acme.test';
    const err: any = await importText(yaml.dump(file)).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('connectors[0].baseUrl');
  });

  it('turns number and boolean envVars and headers into strings', async () => {
    const { text } = await exportText('yaml');
    const file = parse(text, 'yaml');
    file.connectors[0].envVars = { PORT: 5432, DEBUG: true, NAME: 'db' };
    file.connectors[0].headers = { 'X-Version': 2 };
    const content = yaml.dump(file);
    expect(content).toContain('PORT: 5432');
    const { result, prisma } = (await importText(content)) as any;
    expect(result.created).toBe(1);
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars).toEqual({ PORT: '5432', DEBUG: 'true', NAME: 'db' });
    expect(data.headers).toEqual({ 'X-Version': '2' });
  });

  it('rejects an object value in envVars with 400', async () => {
    const { text } = await exportText('yaml');
    const file = parse(text, 'yaml');
    file.connectors[0].envVars = { NESTED: { a: 1 } };
    const err: any = await importText(yaml.dump(file)).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('envVars.NESTED');
  });

  it.each(['42', '- a\n- b', '""'])('rejects a file that is not an object: %j', async (content) => {
    await expect(importText(content)).rejects.toThrow(BadRequestException);
  });

  it.each(['json', 'yaml'] as const)(
    'rejects an unknown property in a %s file, as import-all does',
    async (format) => {
      const { text } = await exportText(format);
      const file = parse(text, format);
      file.connectors[0].tools[0].useProxy = true;
      const content = format === 'json' ? JSON.stringify(file) : yaml.dump(file);
      const err: any = await importText(content).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err.getResponse())).toContain('useProxy');
    },
  );

  it.each(['organizationId', 'authConfig'])('rejects a connector carrying %s', async (field) => {
    const { text } = await exportText('yaml');
    const file = parse(text, 'yaml');
    file.connectors[0][field] = 'org1';
    await expect(importText(yaml.dump(file))).rejects.toThrow(BadRequestException);
  });

  it('writes into the caller organization and skips duplicate names', async () => {
    const { text } = await exportText('yaml');
    const { controller, prisma } = buildController({ stored: null });
    prisma.connector.findFirst.mockResolvedValue({ id: 'existing' });

    const result: any = await controller.importFile(
      req('EDITOR', 'org3'),
      await validateImportFile({ content: text }),
    );

    expect(prisma.connector.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org3', name: 'Acme CRM (EU)' },
      select: { id: true },
    });
    expect(prisma.connector.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it('applies the licence and trial limit', async () => {
    const { text } = await exportText('json');
    const licenseGuard = {
      checkCanCreateConnector: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('Trial limit reached (3 connectors).')),
    };
    const { controller, prisma } = buildController({ stored: null, licenseGuard });

    const result: any = await controller.importFile(
      req('EDITOR', 'org2'),
      await validateImportFile({ content: text }),
    );

    expect(licenseGuard.checkCanCreateConnector).toHaveBeenCalledWith('importer', 'org2');
    expect(prisma.connector.create).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain('Trial limit reached');
  });
});
