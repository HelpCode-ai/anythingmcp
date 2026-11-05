import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TikTokShopInstallController } from './tiktok-shop-install.controller';
import { TikTokShopAuthController } from '../connectors/tiktok-shop-auth.controller';
import { McpOAuthService } from '../connectors/mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';
import { getAdapter } from './catalog';

const KEY = 'test-encryption-key-32-chars!!!!';
const PLATFORM_VARS = {
  TIKTOK_SHOP_PLATFORM_APP_KEY: '6abcplatform',
  TIKTOK_SHOP_PLATFORM_APP_SECRET: 'platformsecret0987654321',
  TIKTOK_SHOP_PLATFORM_SERVICE_ID: '7000001',
};
const API = 'https://open-api.tiktokglobalshop.com';
const BLANK = { TIKTOK_SHOP_APP_KEY: '', TIKTOK_SHOP_APP_SECRET: '', TIKTOK_SHOP_SERVICE_ID: '', TIKTOK_SHOP_MARKET: '', TIKTOK_SHOP_SHOP_ID: '' };
const PLATFORM_APP = { appKey: '6abcplatform', appSecret: 'platformsecret0987654321', serviceId: '7000001', apiHost: API };

describe('TikTokShopInstallController (TikTok Shop App Store installs)', () => {
  const saved: Record<string, string | undefined> = {};
  const setServerApp = (on: boolean) => {
    for (const [k, v] of Object.entries(PLATFORM_VARS)) {
      if (on) process.env[k] = v;
      else delete process.env[k];
    }
  };
  beforeAll(() => {
    saved.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    for (const k of Object.keys(PLATFORM_VARS)) saved[k] = process.env[k];
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // The catalog adapter's authConfig as installed: the variables resolved in.
  const installedAuth = (envVars: Record<string, string>) =>
    encrypt(
      JSON.stringify(getAdapter('tiktok-shop')!.connector.authConfig)
        .split('{{TIKTOK_SHOP_APP_SECRET}}')
        .join(envVars.TIKTOK_SHOP_APP_SECRET ?? '')
        .split('{{TIKTOK_SHOP_APP_KEY}}')
        .join(envVars.TIKTOK_SHOP_APP_KEY ?? '')
        .split('{{TIKTOK_SHOP_SERVICE_ID}}')
        .join(envVars.TIKTOK_SHOP_SERVICE_ID ?? ''),
      KEY,
    );
  const row = (id: string, envVars: Record<string, string>, tokens?: Record<string, unknown>) => {
    const auth = tokens
      ? encrypt(
          JSON.stringify({
            ...JSON.parse(JSON.stringify(getAdapter('tiktok-shop')!.connector.authConfig).split(/\{\{TIKTOK_SHOP_[A-Z_]+\}\}/).join('')),
            ...tokens,
          }),
          KEY,
        )
      : installedAuth(envVars);
    return { id, userId: 'user-1', authType: 'HMAC', authConfig: auth, baseUrl: API, envVars };
  };

  let connectors: Map<string, ReturnType<typeof row>>;
  let prisma: { connector: { findMany: jest.Mock } };
  let adapters: { importAdapter: jest.Mock };
  let licenseGuard: { checkCanCreateConnector: jest.Mock };
  let mcpServers: { attachToDefaultServer: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock };
  let tokens: { exchangeCode: jest.Mock };
  let flows: McpOAuthService;
  let callbackController: TikTokShopAuthController;
  let controller: TikTokShopInstallController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };
  const member = { user: { sub: 'user-2', organizationId: 'org-1', role: 'MEMBER' } };

  beforeEach(() => {
    setServerApp(true);
    connectors = new Map();
    prisma = { connector: { findMany: jest.fn(async () => [...connectors.values()]) } };
    adapters = {
      importAdapter: jest.fn(async (_slug: string, _user: string, _org: string, creds: Record<string, string>) => {
        connectors.set('new-1', row('new-1', creds));
        return { connectorId: 'new-1', toolsCreated: 35, probe: null };
      }),
    };
    licenseGuard = { checkCanCreateConnector: jest.fn(async () => undefined) };
    mcpServers = { attachToDefaultServer: jest.fn(async () => ({ id: 'srv-1', name: 'Default' })) };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    connectorsService = {
      findById: jest.fn(async (id: string) => connectors.get(id)),
      findByIdInternal: jest.fn(async (id: string) => connectors.get(id)),
    };
    tokens = { exchangeCode: jest.fn(async () => ({ shopName: 'Maomao', shopCount: 1 })) };
    flows = new McpOAuthService();
    const config = {
      get: jest.fn((k: string) =>
        ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    callbackController = new TikTokShopAuthController(connectorsService as any, flows, tokens as any, mcpServer as any, config);
    controller = new TikTokShopInstallController(
      prisma as any,
      adapters as any,
      licenseGuard as any,
      mcpServers as any,
      mcpServer as any,
      connectorsService as any,
      flows,
      tokens as any,
      config,
    );
  });

  /** What TikTok's App Store sends: a code and the app key, no state. Returns the dashboard's state. */
  const storeInstall = async (query: Record<string, string> = { app_key: '6abcplatform', shop_region: 'GB' }) => {
    const res = { redirect: jest.fn() };
    await callbackController.callback(undefined, 'TTP_store', undefined, res as any, query.app_key, query.shop_region);
    const url = new URL(res.redirect.mock.calls[0][0]);
    expect(url.searchParams.get('provider')).toBe('tiktok-shop-install');
    return url.searchParams.get('state')!;
  };

  it('adds a TikTok Shop connector with empty app variables and authorizes it with the server app', async () => {
    const state = await storeInstall({ app_key: '6abcplatform', shop_region: 'US' });
    expect(await controller.install(admin, { state })).toEqual({ connectorId: 'new-1', toolsImported: 0, created: true });
    expect(licenseGuard.checkCanCreateConnector).toHaveBeenCalledWith('user-1', 'org-1');
    expect(adapters.importAdapter).toHaveBeenCalledWith('tiktok-shop', 'user-1', 'org-1', { ...BLANK, TIKTOK_SHOP_MARKET: 'US' });
    expect(mcpServers.attachToDefaultServer).toHaveBeenCalledWith('user-1', 'org-1', 'new-1');
    expect(tokens.exchangeCode).toHaveBeenCalledWith({ connectorId: 'new-1', app: PLATFORM_APP, code: 'TTP_store', preferredShop: undefined });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('new-1');
    // Only this workspace's TikTok Shop catalog connectors are looked at.
    expect(prisma.connector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', authType: 'HMAC', config: { path: ['adapterSlug'], equals: 'tiktok-shop' } },
      }),
    );
  });

  it('is single use', async () => {
    const state = await storeInstall();
    await controller.install(admin, { state });
    await expect(controller.install(admin, { state })).rejects.toBeInstanceOf(GoneException);
    await expect(controller.install(admin, { state: 'unknown' })).rejects.toBeInstanceOf(GoneException);
    expect(tokens.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('reuses the newest connector on the server app that still waits for its authorization', async () => {
    connectors.set('own', row('own', { ...BLANK, TIKTOK_SHOP_APP_KEY: '38abcd', TIKTOK_SHOP_APP_SECRET: 'testappsecret1234567890', TIKTOK_SHOP_SERVICE_ID: '7256213' }));
    connectors.set('authorized', row('authorized', BLANK, { accessToken: 'at', refreshToken: 'rt' }));
    connectors.set('waiting', { ...row('waiting', { ...BLANK, TIKTOK_SHOP_SHOP_ID: 'GBX' }) });
    const state = await storeInstall();
    expect(await controller.install(admin, { state })).toEqual({ connectorId: 'waiting', toolsImported: 0, created: false });
    expect(adapters.importAdapter).not.toHaveBeenCalled();
    expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
    expect(tokens.exchangeCode).toHaveBeenCalledWith({ connectorId: 'waiting', app: PLATFORM_APP, code: 'TTP_store', preferredShop: 'GBX' });
  });

  it('adds a new connector when every existing one is authorized or has its own app', async () => {
    connectors.set('authorized', row('authorized', BLANK, { accessToken: 'at', refreshToken: 'rt' }));
    connectors.set('own', row('own', { ...BLANK, TIKTOK_SHOP_APP_KEY: '38abcd', TIKTOK_SHOP_APP_SECRET: 'testappsecret1234567890', TIKTOK_SHOP_SERVICE_ID: '7256213' }));
    const state = await storeInstall();
    expect((await controller.install(admin, { state })).created).toBe(true);
  });

  it("looks only at a member's own connectors", async () => {
    const state = await storeInstall();
    await controller.install(member, { state });
    expect(prisma.connector.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user-2' }) }));
    expect(adapters.importAdapter).toHaveBeenCalledWith('tiktok-shop', 'user-2', 'org-1', expect.any(Object));
  });

  it('refuses a viewer without using up the install', async () => {
    const state = await storeInstall();
    await expect(controller.install({ user: { ...admin.user, role: 'VIEWER' } }, { state })).rejects.toBeInstanceOf(ForbiddenException);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
    expect((await controller.install(admin, { state })).connectorId).toBe('new-1');
  });

  it('keeps the install when the plan allows no more connectors', async () => {
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new ForbiddenException('Your plan allows 3 connectors.'));
    const state = await storeInstall();
    await expect(controller.install(admin, { state })).rejects.toBeInstanceOf(ForbiddenException);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
    expect((await controller.install(admin, { state })).created).toBe(true);
  });

  it('refuses when the server no longer has the app', async () => {
    const state = await storeInstall();
    setServerApp(false);
    await expect(controller.install(admin, { state })).rejects.toBeInstanceOf(BadRequestException);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('says to authorize again when TikTok refuses the code, without naming app keys', async () => {
    tokens.exchangeCode.mockRejectedValueOnce({ response: { status: 200, data: { code: 36004004, message: 'Invalid auth code.' } } });
    const state = await storeInstall();
    const err = await controller.install(admin, { state }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ connectorId: 'new-1', message: expect.stringMatching(/code 36004004.*Authorize again/) });
    expect(err.getResponse().message).not.toMatch(/TIKTOK_SHOP_APP_KEY/);
  });
});
