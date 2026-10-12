import { ConnectorsController } from './connectors.controller';
import { ToolsController } from './tools.controller';
import { CurlParser } from './parsers/curl.parser';
import { PostmanParser } from './parsers/postman.parser';
import { AdaptersService } from '../adapters/adapters.service';
import { ConnectorSetupService } from '../adapters/connector-setup.service';
import { getAdapter } from '../adapters/catalog';
import { rebuildCatalogCredentials, storableBaseUrl } from './catalog-env-rebuild.util';
import { DynamicMcpTools } from '../mcp-server/dynamic-mcp-tools';
import { stripQuery, cutQueries } from '../common/sentry-scrub';
import type { RegisteredTool } from '../mcp-server/tool-registry';

/**
 * A secret typed into a URL, a header or a tool ends up in an encrypted
 * variable on every way in: the connector form (create, update), the tool
 * editor, the imports (cURL, Postman, JSON, backup restore), the catalog
 * install, and never in a chat setting. Logs and Sentry redact it.
 */

const KEY = 'a'.repeat(48);
const TG_SECRET = ['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('');
const TG = `7123456789:${TG_SECRET}`;
const GOOGLE = ['AI', 'zaSyB1x2y3z4A5B6C7D8E9F0gHiJkLmNoPqRs'].join('');

const req = (role = 'ADMIN') => ({ user: { sub: 'u1', organizationId: 'org1', role } });

function noSecret(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TG_SECRET);
  expect(text).not.toContain(GOOGLE);
}

function buildConnectors(stored: Record<string, any> = {}) {
  const connector = {
    id: 'c1',
    name: 'Telegram',
    type: 'REST',
    userId: 'u1',
    organizationId: 'org1',
    authType: 'NONE',
    authConfig: null,
    baseUrl: 'https://api.telegram.org',
    headers: null,
    envVars: {},
    config: null,
    tools: [],
    ...stored,
  };
  const connectorsService = {
    create: jest.fn(async (_u: string, _o: string, data: any) => ({ id: 'c1', ...data })),
    update: jest.fn(async (id: string, data: any) => ({ ...connector, ...data, id })),
    findById: jest.fn().mockResolvedValue(connector),
    addEnvVars: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    connector: {
      create: jest.fn(async ({ data }: any) => ({ id: 'new1', ...data })),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    mcpTool: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: `t-${data.name}`, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
  };
  const controller = new ConnectorsController(
    connectorsService as any,
    {} as any,
    {} as any,
    {} as any,
    new PostmanParser(),
    new CurlParser(),
    {} as any, // harParser
    {} as any,
    {} as any,
    {} as any,
    prisma as any,
    { reloadConnectorTools: jest.fn() } as any,
    { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) } as any,
    { checkCanCreateConnector: jest.fn() } as any,
    { attachToDefaultServer: jest.fn().mockResolvedValue(null) } as any,
    { isCloud: () => true } as any,
  );
  return { controller, connectorsService, prisma, connector };
}

describe('connector form: create', () => {
  it('moves a bot token out of the base URL into a variable', async () => {
    const { controller, connectorsService } = buildConnectors();
    const out: any = await controller.create(req(), {
      name: 'My Bot',
      type: 'REST' as any,
      baseUrl: `https://api.telegram.org/bot${TG}`,
      envVars: { CHAT_ID: '42' },
    });
    const data = connectorsService.create.mock.calls[0][2];
    expect(data.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(data.envVars).toEqual({ CHAT_ID: '42', TELEGRAM_BOT_TOKEN: TG });
    expect(out.secretsMoved).toEqual([
      expect.objectContaining({ variable: 'TELEGRAM_BOT_TOKEN', field: 'baseUrl' }),
    ]);
    expect(out.secretsNotice).toMatch(/moved into the encrypted variable TELEGRAM_BOT_TOKEN/);
    noSecret(out);
  });

  it('moves a literal credential header', async () => {
    const { controller, connectorsService } = buildConnectors();
    await controller.create(req(), {
      name: 'Acme',
      type: 'REST' as any,
      baseUrl: 'https://api.acme.example',
      headers: { Authorization: 'Bearer abcDEF123456ghi' },
    });
    const data = connectorsService.create.mock.calls[0][2];
    expect(data.headers).toEqual({ Authorization: 'Bearer {{ACME_TOKEN}}' });
    expect(data.envVars).toEqual({ ACME_TOKEN: 'abcDEF123456ghi' });
  });

  it('leaves a clean connector and a DATABASE connection string alone', async () => {
    const { controller, connectorsService } = buildConnectors();
    const out: any = await controller.create(req(), {
      name: 'Clean',
      type: 'REST' as any,
      baseUrl: 'https://api.example.com/v1',
    });
    expect(connectorsService.create.mock.calls[0][2]).toEqual({
      name: 'Clean',
      type: 'REST',
      baseUrl: 'https://api.example.com/v1',
      headers: undefined,
    });
    expect(out.secretsMoved).toBeUndefined();
  });
});

describe('connector form: update', () => {
  it('moves a key typed into the base URL and keeps the other variables', async () => {
    const { controller, connectorsService } = buildConnectors({ envVars: { CHAT_ID: '42' } });
    const out: any = await controller.update(req(), 'c1', {
      baseUrl: `https://api.telegram.org/bot${TG}`,
    } as any);
    expect(connectorsService.update).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        baseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
        envVars: { CHAT_ID: '42', TELEGRAM_BOT_TOKEN: TG },
      }),
    );
    noSecret(out);
  });

  it('reuses the variable a catalog install already holds the token in', async () => {
    const { controller, connectorsService } = buildConnectors({
      baseUrl: `https://api.telegram.org/bot${TG}`,
      envVars: { TELEGRAM_BOT_TOKEN: TG },
      config: { adapterSlug: 'telegram-bot' },
    });
    await controller.update(req(), 'c1', { baseUrl: `https://api.telegram.org/bot${TG}` } as any);
    const data = connectorsService.update.mock.calls[0][1];
    expect(data.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(data.envVars).toBeUndefined();
  });

  it('does not touch stored headers the form sends back unchanged', async () => {
    const { controller, connectorsService } = buildConnectors({
      headers: { 'X-Api-Key': 'k1k2k3k4k5' },
    });
    await controller.update(req(), 'c1', { headers: { 'X-Api-Key': '' } } as any);
    expect(connectorsService.update.mock.calls[0][1].headers).toEqual({ 'X-Api-Key': 'k1k2k3k4k5' });
  });
});

describe('imports', () => {
  it('cURL: path, name, description and query key all land in variables', async () => {
    const { controller, connectorsService, prisma } = buildConnectors();
    const out: any = await controller.importTools(req(), 'c1', {
      source: 'curl',
      content: `curl -X POST "https://api.telegram.org/bot${TG}/sendMessage?key=${GOOGLE}" -d '{"chat_id":"1","text":"hi"}'`,
    } as any);
    const created = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(created.name).toBe('post_bot_sendMessage');
    expect(created.endpointMapping.path).toBe('/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect(created.endpointMapping.queryParams).toEqual({ key: '{{TELEGRAM_API_KEY}}' });
    expect(connectorsService.addEnvVars).toHaveBeenCalledWith('c1', {
      TELEGRAM_BOT_TOKEN: TG,
      TELEGRAM_API_KEY: GOOGLE,
    });
    // The parser already built the name without the token.
    expect(out.renamedTools).toBeUndefined();
    expect(out.secretsMoved.map((m: any) => m.variable)).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_KEY']);
    noSecret(created);
    noSecret(out);
  });

  it('Postman: a literal key in the query is moved, not asked of the AI client', async () => {
    const { controller, connectorsService, prisma } = buildConnectors({ name: 'Maps' });
    const collection = {
      info: { name: 'Maps', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Geocode',
          request: {
            method: 'GET',
            url: {
              raw: `https://maps.example.com/geocode?address=x&key=${GOOGLE}`,
              path: ['geocode'],
              query: [
                { key: 'address', value: 'x' },
                { key: 'key', value: GOOGLE },
              ],
            },
          },
        },
      ],
    };
    await controller.importTools(req(), 'c1', { source: 'postman', content: JSON.stringify(collection) } as any);
    const created = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(created.endpointMapping.queryParams).toEqual({ address: '$address', key: '{{MAPS_API_KEY}}' });
    expect(Object.keys(created.parameters.properties)).toEqual(['address']);
    expect(connectorsService.addEnvVars).toHaveBeenCalledWith('c1', { MAPS_API_KEY: GOOGLE });
    noSecret(created);
  });

  it('JSON: a hand-written tool definition is cleaned too', async () => {
    const { controller, prisma } = buildConnectors();
    await controller.importTools(req(), 'c1', {
      source: 'json',
      content: JSON.stringify([
        { name: 'get_me', description: `GET /bot${TG}/getMe`, endpointMapping: { method: 'GET', path: `/bot${TG}/getMe` } },
      ]),
    } as any);
    const created = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(created.name).toBe('get_me');
    expect(created.description).toBe('GET /bot{{TELEGRAM_BOT_TOKEN}}/getMe');
    noSecret(created);
  });

  it('a DATABASE connector keeps its SQL as written', async () => {
    const { controller, prisma, connectorsService } = buildConnectors({ type: 'DATABASE' });
    const sql = `SELECT * FROM t WHERE k = '${TG}'`;
    await controller.importTools(req(), 'c1', {
      source: 'json',
      content: JSON.stringify([{ name: 'q', description: 'q', endpointMapping: { method: 'query', path: sql } }]),
    } as any);
    expect(prisma.mcpTool.create.mock.calls[0][0].data.endpointMapping.path).toBe(sql);
    expect(connectorsService.addEnvVars).not.toHaveBeenCalled();
  });

  it('backup restore: base URL and tools are cleaned, the token stored once', async () => {
    const { controller, prisma } = buildConnectors();
    const out: any = await controller.importAll(req(), {
      connectors: [
        {
          name: 'Old bot',
          type: 'REST' as any,
          baseUrl: `https://api.telegram.org/bot${TG}`,
          config: { adapterSlug: 'telegram-bot', baseUrlBaseline: `https://api.telegram.org/bot${TG}` },
          tools: [
            {
              name: `post_bot${TG.replace(':', '_')}_sendMessage`.slice(0, 64),
              description: 'send',
              parameters: {},
              endpointMapping: { method: 'POST', path: '/sendMessage' },
            },
          ],
        },
      ],
    } as any);
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(data.envVars).toEqual({ TELEGRAM_BOT_TOKEN: TG });
    expect(data.config.baseUrlBaseline).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    noSecret(data.config);
    const tool = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(tool.name).toBe('post_sendMessage');
    expect(out.secretsMoved[0].field).toBe('Old bot: baseUrl');
    noSecret(out);
    noSecret(tool);
  });
});

describe('tool editor', () => {
  function buildTools(stored: any = { name: 'get_me', description: 'x', parameters: {}, endpointMapping: { method: 'GET', path: '/getMe' } }) {
    const connector = {
      id: 'c1',
      name: 'Telegram',
      type: 'REST',
      organizationId: 'org1',
      userId: 'u1',
      envVars: { TELEGRAM_BOT_TOKEN: TG },
      tools: [{ id: 't1', name: stored.name }],
    };
    const prisma = {
      mcpTool: {
        create: jest.fn(async ({ data }: any) => ({ id: 't2', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: 't1', ...stored, responseMapping: null }),
        findUnique: jest.fn().mockResolvedValue({ id: 't1' }),
      },
    };
    const connectorsService = {
      findById: jest.fn().mockResolvedValue(connector),
      addEnvVars: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ToolsController(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      connectorsService as any,
    );
    return { controller, prisma, connectorsService };
  }

  it('create: a path with the token uses the variable that already holds it', async () => {
    const { controller, prisma, connectorsService } = buildTools();
    const out: any = await controller.create(req(), 'c1', {
      name: 'send',
      description: 'Send',
      parameters: {},
      endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage` },
    });
    const data = prisma.mcpTool.create.mock.calls[0][0].data;
    expect(data.endpointMapping.path).toBe('/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect(connectorsService.addEnvVars).not.toHaveBeenCalled();
    expect(out.secretsMoved[0].variable).toBe('TELEGRAM_BOT_TOKEN');
    noSecret(out);
  });

  it('create: a new key becomes a new variable', async () => {
    const { controller, prisma, connectorsService } = buildTools();
    await controller.create(req(), 'c1', {
      name: 'geo',
      description: 'Geo',
      parameters: {},
      endpointMapping: { method: 'GET', path: '/geo', queryParams: { api_key: 'a1b2c3d4e5f6' } },
    });
    expect(prisma.mcpTool.create.mock.calls[0][0].data.endpointMapping.queryParams).toEqual({
      api_key: '{{TELEGRAM_API_KEY}}',
    });
    expect(connectorsService.addEnvVars).toHaveBeenCalledWith('c1', { TELEGRAM_API_KEY: 'a1b2c3d4e5f6' });
  });

  it('update: an edit cleans a key and a name left by an earlier save', async () => {
    const { controller, prisma } = buildTools({
      name: `get_bot${TG.replace(':', '_')}_getMe`.slice(0, 64),
      description: 'x',
      parameters: {},
      endpointMapping: { method: 'GET', path: `/bot${TG}/getMe` },
    });
    const out: any = await controller.update(req(), 't1', 'c1', { description: 'Who am I' });
    const data = prisma.mcpTool.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({
      description: 'Who am I',
      name: 'get_bot_getMe',
      endpointMapping: { method: 'GET', path: '/bot{{TELEGRAM_BOT_TOKEN}}/getMe' },
    });
    expect(out.renamedTools).toEqual(['get_bot_getMe']);
  });

  it('update: a clean edit changes only what was sent', async () => {
    const { controller, prisma } = buildTools();
    await controller.update(req(), 't1', 'c1', { description: 'Who am I' });
    expect(prisma.mcpTool.updateMany.mock.calls[0][0].data).toEqual({ description: 'Who am I' });
  });
});

describe('setup from the chat', () => {
  function buildSetup() {
    const prisma: any = {
      organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      connector: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const real = new AdaptersService(
      { connector: {}, mcpTool: {} } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) } as any,
      {} as any,
    );
    const adapters: any = {
      describe: (slug: string) => real.describe(slug),
      importAdapter: jest.fn(),
    };
    const service = new ConnectorSetupService(
      prisma,
      adapters,
      { checkCanCreateConnector: jest.fn() } as any,
      { register: jest.fn() } as any,
      { log: jest.fn() } as any,
      { log: jest.fn() } as any,
    );
    return { service, adapters };
  }
  const ctx = { userId: 'u1', organizationId: 'org1', serverIds: [], dashboardBase: 'https://x' };

  it('refuses a key pasted into a non-secret setting, without echoing it', async () => {
    const { service, adapters } = buildSetup();
    const out = await service.install(ctx as any, {
      adapter: 'magento',
      settings: { MAGENTO_BASE_URL: `https://shop.example.com/?access_token=${GOOGLE}` },
    });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.body)).toMatch(/never taken from the chat/);
    noSecret(out.body);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });
});

describe('catalog install', () => {
  it('Telegram keeps the token as {{TELEGRAM_BOT_TOKEN}} in the stored base URL', async () => {
    const prisma = {
      connector: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mcpTool: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) } as any,
      {} as any,
    );
    await service.importAdapter('telegram-bot', 'u1', 'org1', { TELEGRAM_BOT_TOKEN: TG });
    const { data } = prisma.connector.create.mock.calls[0][0];
    expect(data.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(data.config.baseUrlBaseline).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(data.envVars).toEqual({ TELEGRAM_BOT_TOKEN: TG });
  });

  it('still resolves non-secret address variables', () => {
    const weclapp = getAdapter('weclapp')!;
    expect(storableBaseUrl(weclapp, { WECLAPP_TENANT: 'acme', WECLAPP_API_TOKEN: 't' })).toBe(
      weclapp.connector.baseUrl.replace('{{WECLAPP_TENANT}}', 'acme'),
    );
  });

  it('editing the variables keeps the reference, and converts a resolved install', () => {
    const adapter = getAdapter('telegram-bot')!;
    const NEW = `7123456789:${'B'.repeat(35)}`;
    const changed = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: 'NONE',
      storedAuthConfig: null,
      storedBaseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
      storedHeaders: null,
      previousEnvVars: { TELEGRAM_BOT_TOKEN: TG },
      nextEnvVars: { TELEGRAM_BOT_TOKEN: NEW },
    });
    // Nothing to rewrite: the reference already resolves to the new token.
    expect(changed.baseUrl).toBeUndefined();
    expect(changed.missing).toEqual([]);

    const legacy = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: 'NONE',
      storedAuthConfig: null,
      storedBaseUrl: `https://api.telegram.org/bot${TG}`,
      storedHeaders: null,
      previousEnvVars: { TELEGRAM_BOT_TOKEN: TG },
      nextEnvVars: { TELEGRAM_BOT_TOKEN: TG, CHAT: '1' },
    });
    expect(legacy.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');

    const pointedElsewhere = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: 'NONE',
      storedAuthConfig: null,
      storedBaseUrl: 'https://telegram-proxy.example.com/botX',
      storedHeaders: null,
      previousEnvVars: { TELEGRAM_BOT_TOKEN: TG },
      nextEnvVars: { TELEGRAM_BOT_TOKEN: TG },
    });
    expect(pointedElsewhere.baseUrl).toBeUndefined();
  });
});

describe('logs', () => {
  function telegramTool(): RegisteredTool {
    return {
      id: 't1',
      connectorId: 'c1',
      organizationId: 'org1',
      name: 'get_me',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      connectorType: 'REST',
      connectorConfig: {
        baseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
        authType: 'NONE',
        envVars: { TELEGRAM_BOT_TOKEN: TG },
      },
      endpointMapping: { method: 'GET', path: '/getMe' },
    } as RegisteredTool;
  }

  function buildExecutor(restEngine: any) {
    const tool = telegramTool();
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      audit as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any,
      { checkLicenseActive: jest.fn() } as any,
      { isCloud: () => false } as any,
      {} as any,
      restEngine,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
    );
    return { executor, audit };
  }

  it('an error quoting the interpolated URL is redacted for the client and the log', async () => {
    const { executor, audit } = buildExecutor({
      execute: jest.fn().mockRejectedValue(
        new Error(`SSRF guard: blocked https://api.telegram.org/bot${TG}/getMe`),
      ),
    });
    const res = await executor.executeTool('get_me', {});
    expect(res.isError).toBe(true);
    noSecret(res);
    noSecret(audit.logInvocation.mock.calls[0][0]);
    expect(audit.logInvocation.mock.calls[0][0].error).toContain('[REDACTED]');
  });

  it('a response echoing the token is redacted; a clean one is passed through untouched', async () => {
    const echo = { ok: true, url: `https://api.telegram.org/bot${TG}/getMe` };
    const { executor, audit } = buildExecutor({ execute: jest.fn().mockResolvedValue(echo) });
    const res = await executor.executeTool('get_me', {});
    noSecret(res);
    noSecret(audit.logInvocation.mock.calls[0][0]);

    const clean = { ok: true, result: { id: 1 } };
    const second = buildExecutor({ execute: jest.fn().mockResolvedValue(clean) });
    await second.executor.executeTool('get_me', {});
    expect(second.audit.logInvocation.mock.calls[0][0].output).toBe(clean);
  });

  it('Sentry URLs and span names lose a token in the path', () => {
    expect(stripQuery(`https://api.telegram.org/bot${TG}/getMe?x=1`)).toBe(
      'https://api.telegram.org/bot[REDACTED]/getMe',
    );
    expect(cutQueries(`GET https://api.telegram.org/bot${TG}/getMe`)).toBe(
      'GET https://api.telegram.org/bot[REDACTED]/getMe',
    );
    expect(stripQuery('https://api.example.com/v1/users/123')).toBe('https://api.example.com/v1/users/123');
  });
});
