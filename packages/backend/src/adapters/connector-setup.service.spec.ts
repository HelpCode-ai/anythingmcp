import { ConnectorSetupService, SETUP_LINK_RETENTION_MS } from './connector-setup.service';
import { AdaptersService } from './adapters.service';
import { encrypt } from '../common/crypto/encryption.util';
import { outboundRequest } from '../common/outbound-http';

// The chat install asks an Odoo address about itself: no real request here.
jest.mock('../common/outbound-http', () => ({ outboundRequest: jest.fn().mockRejectedValue(new Error('offline')) }));
const outbound = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

const KEY = 'k'.repeat(32);

function build(opts: { role?: string; connectors?: any[]; importResult?: any; trial?: any; cloud?: boolean; lastCalls?: Record<string, any>; verify?: any; woo?: any } = {}) {
  process.env.ENCRYPTION_KEY = KEY;
  const links: any[] = [];
  const serverConnectors: any[] = [];
  const stored: Record<string, any> = {};
  const prisma: any = {
    organizationMember: { findFirst: jest.fn().mockResolvedValue(opts.role ? { role: opts.role } : null) },
    connector: {
      findMany: jest.fn().mockResolvedValue(opts.connectors ?? []),
      findUnique: jest.fn(async ({ where }: any) => stored[where.id] ?? null),
      findFirst: jest.fn(async ({ where }: any) => (stored[where.id]?.organizationId === where.organizationId ? stored[where.id] : null)),
    },
    connectorSetupLink: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: any) => (links.push({ id: `l${links.length}`, ...data }), data)),
      findUnique: jest.fn(async ({ where }: any) => links.find((l) => l.tokenHash === where.tokenHash) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(links.find((l) => l.id === where.id), data)),
    },
    mcpServerConfig: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id }))) },
    mcpServerConnector: { create: jest.fn(async ({ data }: any) => serverConnectors.push(data)) },
    toolInvocation: { findFirst: jest.fn(async ({ where }: any) => opts.lastCalls?.[where.connectorId] ?? null) },
  };
  const realAdapters = new AdaptersService(
    { connector: {}, mcpTool: {} } as any,
    { reloadConnectorTools: jest.fn() } as any,
    {
      get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : k === 'DEPLOYMENT_MODE' && opts.cloud ? 'cloud' : undefined),
    } as any,
    {} as any,
  );
  const adapters: any = {
    listAll: () => realAdapters.listAll(),
    describe: (slug: string) => realAdapters.describe(slug),
    verifyCredentials: jest.fn().mockResolvedValue(opts.verify ?? { ok: null, skipped: 'no_probe' }),
    inspectWooCommerceAddress: jest.fn().mockResolvedValue(opts.woo),
    importAdapter: jest.fn(async (slug: string, _u: string, orgId: string, settings: Record<string, string>) => {
      const def = realAdapters.getBySlug(slug);
      const id = `c-${slug}`;
      stored[id] = {
        id,
        organizationId: orgId,
        authType: def.connector.authType,
        authConfig: def.connector.authConfig ? encrypt(JSON.stringify(def.connector.authConfig), KEY) : null,
        baseUrl: def.connector.baseUrl,
        headers: null,
        envVars: settings,
        config: { adapterSlug: slug },
        tools: def.tools.map((t: any) => ({ endpointMapping: t.endpointMapping })),
      };
      return { connectorId: id, toolsCreated: def.tools.length, probe: opts.importResult ?? null };
    }),
  };
  const licenseGuard: any = {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
    getUsage: jest.fn().mockResolvedValue({ plan: 'trial', connectors: { current: 1, max: 5 } }),
    getTrialState: jest.fn().mockResolvedValue(opts.trial ?? null),
  };
  const securityEvents: any = { log: jest.fn() };
  const productEvents: any = { log: jest.fn() };
  const service = new ConnectorSetupService(prisma, adapters as unknown as AdaptersService, licenseGuard, { register: jest.fn() } as any, securityEvents, productEvents);
  const ctx = { userId: 'u1', organizationId: 'org-1', serverIds: ['srv-granted'], dashboardBase: 'https://cloud.example.com' };
  return { service, prisma, adapters, licenseGuard, securityEvents, productEvents, links, serverConnectors, ctx };
}

describe('ConnectorSetupService — who may', () => {
  it.each([['ADMIN', true], ['EDITOR', true], ['VIEWER', false], [undefined, false]])('%s → %s', async (role, ok) => {
    const { service, ctx } = build({ role: role as any });
    await expect(service.canSetUp(ctx)).resolves.toBe(ok);
  });
});

describe('ConnectorSetupService — find', () => {
  it('finds Etsy, says a sign-in is needed, and lists no secret as passable', async () => {
    const { service, ctx } = build();
    const out: any = (await service.find(ctx, { query: 'etsy' })).body;
    const etsy = out.results.find((r: any) => r.adapter === 'etsy');
    expect(etsy.setup).toMatch(/sign-in at the provider/);
    expect(etsy.settingsYouMayPass.map((s: any) => s.name)).toEqual(['ETSY_CLIENT_ID']);
    expect(etsy.enteredByTheUserOnTheLinkedPage).toContain('Shared Secret');
    expect(out.connectorsLeftOnThisPlan).toBe(4);
  });

  it('gives the callback URL to register for a provider sign-in, before the user creates the app', async () => {
    const before = process.env.SERVER_URL;
    process.env.SERVER_URL = 'https://cloud.example.com/';
    try {
      const { service, ctx } = build();
      const out: any = (await service.find(ctx, { query: 'etsy openplz', limit: 10 })).body;
      const etsy = out.results.find((r: any) => r.adapter === 'etsy');
      const openplz = out.results.find((r: any) => r.adapter === 'openplz');
      expect(etsy.callbackUrlToRegisterInTheProviderApp).toBe('https://cloud.example.com/api/mcp-oauth/callback');
      expect(openplz.callbackUrlToRegisterInTheProviderApp).toBeUndefined();

      const installed: any = (await service.install(ctx, { adapter: 'etsy', settings: { ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx' } })).body;
      expect(installed.callbackUrlToRegisterInTheProviderApp).toBe('https://cloud.example.com/api/mcp-oauth/callback');

      // Where to create the app, and how to show both addresses: a link to
      // tap and the callback alone in a code block to copy.
      for (const r of [etsy, installed]) {
        expect(r.createTheAppAt).toBe('https://www.etsy.com/developers/register');
        expect(r.showToTheUser).toMatch(/\[Create the app\]\(https:\/\/www\.etsy\.com\/developers\/register\)/);
        expect(r.showToTheUser).toMatch(/fenced code block/);
      }
      expect(openplz.createTheAppAt).toBeUndefined();

      // Notion's server registers the client itself: no app, no callback.
      const notionOut: any = (await service.find(ctx, { query: 'notion', limit: 10 })).body;
      const notion = notionOut.results.find((r: any) => r.adapter === 'notion');
      expect(notion.setup).toMatch(/No app to create/);
      expect(notion.callbackUrlToRegisterInTheProviderApp).toBeUndefined();
      expect(notion.showToTheUser).toBeUndefined();
    } finally {
      process.env.SERVER_URL = before;
    }
  });

  it('records what the chat searched for and how well the catalog answered', async () => {
    const { service, ctx, productEvents } = build();
    await service.find(ctx, { query: 'etsy' });
    await service.find(ctx, { query: 'quarzwerk shop' });
    await service.find(ctx, { query: 'zzqx' });
    await service.find(ctx, {});
    const logged = productEvents.log.mock.calls.map(([e]: any) => e);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toEqual(
      expect.objectContaining({
        event: 'catalog_search',
        userId: 'u1',
        organizationId: 'org-1',
        metadata: expect.objectContaining({ query: 'etsy', via: 'mcp' }),
      }),
    );
    expect(logged[0].metadata.adapterSlug.split(',')[0]).toBe('etsy');
    expect(logged[0].metadata.missing).toBeUndefined();
    // "shop" returns shop connectors, but the app itself is missing.
    expect(logged[1].metadata).toEqual(expect.objectContaining({ query: 'quarzwerk shop', missing: 'quarzwerk' }));
    expect(logged[1].metadata.results).toBeGreaterThan(0);
    expect(logged[2].metadata).toEqual({ query: 'zzqx', results: 0, missing: 'zzqx', via: 'mcp' });
  });

  it('forgives a typo and knows other names, and records how it matched', async () => {
    const { service, ctx, productEvents } = build();
    const typo: any = (await service.find(ctx, { query: 'bot de telgram' })).body;
    expect(typo.results[0].adapter).toBe('telegram-bot');
    const alias: any = (await service.find(ctx, { query: 'mercado livre' })).body;
    expect(alias.results[0].adapter).toBe('mercado-libre');
    const logged = productEvents.log.mock.calls.map(([e]: any) => e.metadata);
    expect(logged[0]).toEqual(expect.objectContaining({ query: 'bot de telgram', match: 'fuzzy' }));
    expect(logged[0].missing).toBeUndefined();
    expect(logged[1]).toEqual(expect.objectContaining({ query: 'mercado livre', match: 'direct' }));
  });

  it('never offers an unlisted adapter, whatever the query', async () => {
    const { service, ctx } = build();
    for (const query of ['teamsystem', 'zucchetti', 'zucheti', 'cas genesisworld', 'asite']) {
      const out: any = (await service.find(ctx, { query, limit: 10 })).body;
      expect(out.results.map((r: any) => r.adapter)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(teamsystem|zucchetti|cas-genesisworld|asite)$/)]),
      );
    }
  });

  it('never offers payment, banking or trading connectors', async () => {
    const { service, ctx } = build();
    const out: any = (await service.find(ctx, { query: 'payone sorare', limit: 10 })).body;
    expect(out.results.map((r: any) => r.adapter)).not.toEqual(expect.arrayContaining(['payone', 'sorare']));
  });

  it('offers payment connectors for their read tools on the default profile, never cryptocurrency ones', async () => {
    const { service, ctx } = build();
    const claude = { ...ctx, profile: 'default' as const };
    const stripe: any = (await service.find(claude, { query: 'stripe', limit: 10 })).body;
    const hit = stripe.results.find((r: any) => r.adapter === 'stripe');
    expect(hit.servedHere).toMatch(/Read tools only/);
    const crypto: any = (await service.find(claude, { query: 'binance coinbase sorare', limit: 10 })).body;
    expect(crypto.results.map((r: any) => r.adapter)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(binance|coinbase|sorare)$/)]),
    );
    expect((await service.install(claude, { adapter: 'binance' })).isError).toBe(true);
  });

  it('keeps generation connectors off the default profile and betting odds off ChatGPT', async () => {
    const { service, ctx } = build();
    const claude = { ...ctx, profile: 'default' as const };
    const media: any = (await service.find(claude, { query: 'elevenlabs stability heygen', limit: 10 })).body;
    expect(media.results.map((r: any) => r.adapter)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(elevenlabs|stability-ai|heygen)$/)]),
    );
    expect((await service.install(claude, { adapter: 'stability-ai' })).isError).toBe(true);
    const openai: any = (await service.find(claude, { query: 'openai', limit: 10 })).body;
    expect(openai.results.find((r: any) => r.adapter === 'openai').servedHere).toMatch(/except image, video and audio generation/);

    const odds: any = (await service.find(ctx, { query: 'the odds api', limit: 10 })).body;
    expect(odds.results.map((r: any) => r.adapter)).not.toContain('the-odds-api');
    const claudeOdds: any = (await service.find(claude, { query: 'the odds api', limit: 10 })).body;
    expect(claudeOdds.results.map((r: any) => r.adapter)).toContain('the-odds-api');
  });
});

describe('ConnectorSetupService — File Search from the chat', () => {
  it('suggests Synology File Search next to the DSM API connector, with the wizard link', async () => {
    const { service, ctx } = build();
    const out: any = (await service.find(ctx, { query: 'synology' })).body;
    expect(out.results.slice(0, 2).map((r: any) => r.adapter)).toEqual(['synology', 'synology-file-search']);
    const fs = out.results[1];
    expect(fs.fileSearch).toBe(true);
    expect(fs.setupUrl).toBe(
      'https://cloud.example.com/connectors/new/file-search?protocol=sftp&preset=synology&adapter=synology-file-search&from=chat',
    );
    expect(fs.settingsYouMayPass).toBeUndefined();
    expect(out.fileSearch.adapters).toContain('synology-file-search');
    expect(out.fileSearch.whatItAdds).toMatch(/inside the documents/);
    expect(out.next).toMatch(/setupUrl/);
    // The DSM API connector keeps its normal answer.
    expect(out.results[0].fileSearch).toBeUndefined();
  });

  it('offers the network folder on self-hosted only', async () => {
    const selfHosted: any = (await build().service.find(build().ctx, { query: 'Netzlaufwerk' })).body;
    expect(selfHosted.fileSearch.adapters).toContain('network-folder');

    const { service, ctx } = build({ cloud: true });
    const cloud: any = (await service.find(ctx, { query: 'Netzlaufwerk' })).body;
    expect(cloud.results.map((r: any) => r.adapter)).not.toContain('network-folder');
    expect(cloud.fileSearch.adapters).toEqual(['sftp', 'webdav']);
  });

  it('suggests nothing for SharePoint, OneDrive, Google Drive or Dropbox', async () => {
    const { service, ctx } = build();
    for (const query of ['sharepoint', 'onedrive', 'google drive', 'dropbox']) {
      const out: any = (await service.find(ctx, { query })).body;
      expect({ query, fileSearch: out.fileSearch }).toEqual({ query, fileSearch: undefined });
      expect(out.results.some((r: any) => r.fileSearch)).toBe(false);
    }
  });

  it('answers an install of a File Search entry with the wizard link, and installs nothing', async () => {
    const { service, ctx, adapters, licenseGuard } = build({ role: 'ADMIN' });
    const out: any = await service.install(ctx, { adapter: 'qnap-file-search' });
    expect(out.isError).toBe(true);
    expect(out.body.setupUrl).toBe(
      'https://cloud.example.com/connectors/new/file-search?protocol=sftp&preset=qnap&adapter=qnap-file-search&from=chat',
    );
    expect(adapters.importAdapter).not.toHaveBeenCalled();
    expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
  });
});

describe('ConnectorSetupService — install', () => {
  it('refuses a secret from the chat, before installing anything', async () => {
    const { service, adapters, ctx } = build();
    const out = await service.install(ctx, { adapter: 'lexware-office', settings: { LEXWARE_API_KEY: 'k' } });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.body)).toContain('never taken from the chat');
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('refuses a setting the adapter does not have, and an unknown or excluded adapter', async () => {
    const { service, ctx } = build();
    expect((await service.install(ctx, { adapter: 'weclapp', settings: { BASE_URL: 'https://evil.example' } })).isError).toBe(true);
    expect((await service.install(ctx, { adapter: 'no-such-thing' })).isError).toBe(true);
    expect((await service.install(ctx, { adapter: 'payone' })).isError).toBe(true);
  });

  it('installs a keyless connector ready to use, on the granted server, and records it', async () => {
    const { service, ctx, serverConnectors, securityEvents } = build();
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.isError).toBeFalsy();
    expect(out.body.status).toBe('ready');
    expect(serverConnectors).toEqual([{ mcpServerId: 'srv-granted', connectorId: 'c-openplz' }]);
    expect(securityEvents.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'CONNECTOR_INSTALLED_VIA_MCP' }));
  });

  it('returns a one-time link when the user has to enter something', async () => {
    const { service, ctx, links } = build();
    const out: any = await service.install(ctx, { adapter: 'weclapp', settings: { WECLAPP_TENANT: 'acme' } });
    expect(out.body.status).toBe('needs_input');
    expect(out.body.whatTheUserDoes).toContain('API token');
    expect(out.body.finishSetupUrl).toMatch(/^https:\/\/cloud\.example\.com\/s\/[A-Za-z0-9_-]{20,}$/);
    // Only the hash is stored.
    const token = out.body.finishSetupUrl.split('/s/')[1];
    expect(JSON.stringify(links)).not.toContain(token);
  });

  it('installs Telegram and Shopify without the values in their API address, and asks for them', async () => {
    // The bot token is part of Telegram's address and is never taken from the
    // chat; the post-approve picker sends no values at all. Both installs
    // used to be refused outright.
    const { service, ctx, adapters } = build();
    const telegram: any = await service.install(ctx, { adapter: 'telegram-bot' }, { via: 'post_approve' });
    expect(adapters.importAdapter).toHaveBeenLastCalledWith('telegram-bot', 'u1', 'org-1', {}, { addressMayWait: true });
    expect(telegram.isError).toBeUndefined();
    expect(telegram.body.status).toBe('needs_input');
    expect(telegram.body.whatTheUserDoes).toMatch(/bot token/i);
    expect(telegram.body.finishSetupUrl).toMatch(/\/s\//);

    const shopify: any = await service.install(ctx, { adapter: 'shopify' });
    expect(shopify.isError).toBeUndefined();
    expect(shopify.body.status).toBe('needs_input');
    expect(shopify.body.finishSetupUrl).toMatch(/\/s\//);
  });

  it('asks for the key of an Odoo JSON-RPC connector, which only its tools use', async () => {
    // The key lives in the request body. Before, the install answered "ready"
    // without a link and every call came back "Access Denied".
    const { service, ctx } = build();
    const out: any = await service.install(ctx, {
      adapter: 'odoo-jsonrpc',
      settings: { ODOO_URL: 'https://erp.example.com', ODOO_DB: 'prod', ODOO_UID: '2' },
    });
    expect(out.body.status).toBe('needs_input');
    expect(out.body.whatTheUserDoes).toContain('API key');
    expect(out.body.finishSetupUrl).toBeDefined();
  });

  it('asks for the sign-in when an OAuth connector has its app keys', async () => {
    const { service, ctx } = build();
    const out: any = await service.install(ctx, { adapter: 'etsy', settings: { ETSY_CLIENT_ID: 'a1b2c3d4e5f6g7h8i9j0k1l2' } });
    expect(out.body.status).toBe('needs_input'); // the shared secret still has to be entered on the page
    expect(out.body.whatTheUserDoes).toMatch(/enter Shared Secret, then sign in to .+ and approve\./);
    expect(out.body.finishSetupUrl).toBeDefined();
  });

  it('stops after ten installs an hour', async () => {
    const { service, ctx } = build();
    for (let i = 0; i < 10; i++) await service.install(ctx, { adapter: 'openplz' });
    const out = await service.install(ctx, { adapter: 'openplz' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.body)).toContain('an hour');
  });

  it('refuses a setting that does not match its pattern, with what to check', async () => {
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, { adapter: 'etsy', settings: { ETSY_CLIENT_ID: 'abc123:secret' } });
    expect(out.isError).toBe(true);
    expect(out.body.error).toMatch(/Keystring.*does not look right.*24 lowercase/);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('adds the https:// an address from the chat lacks, and names the fix for one still wrong', async () => {
    const { service, ctx, adapters } = build();
    await service.install(ctx, { adapter: 'odoo', settings: { ODOO_URL: 'acme.odoo.com', ODOO_DB: 'acme' } });
    expect(adapters.importAdapter).toHaveBeenLastCalledWith(
      'odoo',
      'u1',
      'org-1',
      { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme' },
      { addressMayWait: true },
    );

    adapters.importAdapter.mockClear();
    const out: any = await service.install(ctx, { adapter: 'prestashop', settings: { PRESTASHOP_URL: 'http://shop.example.com/' } });
    expect(out.isError).toBe(true);
    expect(out.body.error).toMatch(/Use https:\/\/ instead of http:\/\//);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('cleans a WooCommerce address from the chat silently (WooCommerce has its own rule)', async () => {
    const { service, ctx, adapters } = build();
    await service.install(ctx, {
      adapter: 'woocommerce',
      settings: { WOOCOMMERCE_URL: 'http://shop.example.com/wp-admin/admin.php?page=wc-settings' },
    });
    expect(adapters.importAdapter).toHaveBeenLastCalledWith(
      'woocommerce',
      'u1',
      'org-1',
      { WOOCOMMERCE_URL: 'https://shop.example.com' },
      { addressMayWait: true },
    );
    expect(adapters.inspectWooCommerceAddress).toHaveBeenCalledWith('https://shop.example.com');
  });

  it('respects the trial limit', async () => {
    const { service, ctx, licenseGuard, adapters } = build();
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('Trial limit reached (2 connectors).'));
    const out = await service.install(ctx, { adapter: 'openplz' });
    expect(out.isError).toBe(true);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('at the limit, offers an admin on the free trial the card trial', async () => {
    const { service, ctx, licenseGuard } = build({ role: 'ADMIN' });
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('Trial limit reached (2 connectors).'));
    licenseGuard.getUsage.mockResolvedValueOnce({ plan: 'trial', connectors: { current: 2, max: 2 } });
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.body).toMatchObject({
      error: 'Trial limit reached (2 connectors).',
      upgradeUrl: 'https://cloud.example.com/start-trial?source=chat_setup',
    });
    expect(out.body.whatTheUserCanDo).toMatch(/nothing is charged before the trial ends/);
  });

  it('at the limit, sends an admin on a paid plan to the licence page', async () => {
    const { service, ctx, licenseGuard } = build({ role: 'ADMIN' });
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('Connector limit reached.'));
    licenseGuard.getUsage.mockResolvedValueOnce({ plan: 'cloud_starter', connectors: { current: 5, max: 5 } });
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.body.upgradeUrl).toBe('https://cloud.example.com/settings/license?source=chat_setup');
  });

  it('without any licence, sends an admin to the licence page and does not suggest removing a connector', async () => {
    const { service, ctx, licenseGuard } = build({ role: 'ADMIN' });
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('No active license.'));
    licenseGuard.getUsage.mockResolvedValueOnce({ plan: null, connectors: { current: 0, max: null } });
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.body.upgradeUrl).toBe('https://cloud.example.com/settings/license?source=chat_setup');
    expect(out.body.whatTheUserCanDo).toMatch(/no active licence/);
    expect(out.body.whatTheUserCanDo).not.toMatch(/remove a connector/);
  });

  it('without any licence, tells an editor to ask an admin to activate one', async () => {
    const { service, ctx, licenseGuard } = build({ role: 'EDITOR' });
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('No active license.'));
    licenseGuard.getUsage.mockResolvedValueOnce({ plan: null, connectors: { current: 0, max: null } });
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.body.upgradeUrl).toBeUndefined();
    expect(out.body.whatTheUserCanDo).toMatch(/activate a licence/);
  });

  it('at the limit, tells an editor who can lift it, without a billing link', async () => {
    const { service, ctx, licenseGuard } = build({ role: 'EDITOR' });
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('Trial limit reached (2 connectors).'));
    const out: any = await service.install(ctx, { adapter: 'openplz' });
    expect(out.body.upgradeUrl).toBeUndefined();
    expect(out.body.whatTheUserCanDo).toMatch(/administrator/);
  });
});

describe('ConnectorSetupService — status', () => {
  const DAY = 86_400_000;
  const running = (days: number, cardTrialAvailable = true) => ({
    endsAt: new Date(Date.now() + days * DAY - 60_000),
    active: true,
    cardTrialAvailable,
  });

  it('tells an admin on the free trial the days left and the card-trial page', async () => {
    const { service, ctx } = build({ role: 'ADMIN', trial: running(5) });
    const out: any = (await service.status(ctx)).body;
    expect(out.trial).toEqual({
      daysLeft: 5,
      endsAt: expect.any(String),
      choosePlanUrl: 'https://cloud.example.com/start-trial?source=chat_setup',
      afterTheTrial: expect.stringMatching(/Nothing is charged before then/),
    });
  });

  it('sends an admin to the licence page once a card trial no longer fits', async () => {
    const { service, ctx } = build({ role: 'ADMIN', trial: running(1, false) });
    const out: any = (await service.status(ctx)).body;
    expect(out.trial).toMatchObject({ daysLeft: 1, choosePlanUrl: 'https://cloud.example.com/settings/license?source=chat_setup' });
    expect(out.trial.afterTheTrial).not.toMatch(/card/i);
  });

  it('tells an editor the days left, without a billing link', async () => {
    const { service, ctx } = build({ role: 'EDITOR', trial: running(3) });
    const out: any = (await service.status(ctx)).body;
    expect(out.trial).toEqual({ daysLeft: 3, endsAt: expect.any(String), afterTheTrial: 'A workspace administrator can choose a plan.' });
  });

  it('reports an ended trial, with the licence page for an admin', async () => {
    const ended = { endsAt: new Date(Date.now() - DAY), active: false, cardTrialAvailable: false };
    const admin: any = (await build({ role: 'ADMIN', trial: ended }).service.status(build().ctx)).body;
    expect(admin.trial).toMatchObject({ ended: true, choosePlanUrl: 'https://cloud.example.com/settings/license?source=chat_setup' });
    const editor: any = (await build({ role: 'EDITOR', trial: ended }).service.status(build().ctx)).body;
    expect(editor.trial).toEqual({ ended: true, endedAt: expect.any(String), afterTheTrial: expect.stringMatching(/administrator/) });
  });

  it('says nothing about plans on a paid plan, self-hosted, or when the licence cannot be read', async () => {
    const paid: any = (await build({ role: 'ADMIN' }).service.status(build().ctx)).body;
    expect(paid.trial).toBeUndefined();
    const broken = build({ role: 'ADMIN' });
    broken.licenseGuard.getTrialState.mockRejectedValueOnce(new Error('db down'));
    const out: any = (await broken.service.status(broken.ctx)).body;
    expect(out.trial).toBeUndefined();
    expect(out.connectors).toEqual([]);
  });

  it('keeps billing out of every other setup answer', async () => {
    const { service, ctx } = build({ role: 'ADMIN', trial: running(5) });
    const found: any = (await service.find(ctx, { query: 'etsy' })).body;
    const installed: any = (await service.install(ctx, { adapter: 'openplz' })).body;
    expect(JSON.stringify([found, installed])).not.toMatch(/start-trial|choosePlanUrl|daysLeft/);
  });
});

describe('ConnectorSetupService — an Odoo address asked before a chat install', () => {
  /** Answers like an Odoo: `version` on /jsonrpc, `databases` on /web/database/list. */
  function odoo(opts: { major?: number | string; serie?: string; databases?: string[]; typo?: boolean }) {
    outbound.mockImplementation(async (config: any) => {
      if (opts.typo) {
        return { status: 404, data: '<script>window.location = `https://www.odoo.com/typo?domain=x.odoo.com`;</script>' } as any;
      }
      if (config.url.endsWith('/jsonrpc')) {
        return { status: 200, data: { result: { server_version_info: [opts.major, 0, 0, 'final', 0, ''], server_serie: opts.serie } } } as any;
      }
      if (config.url.endsWith('/web/database/list')) return { status: 200, data: { result: opts.databases ?? [] } } as any;
      throw new Error(`unexpected ${config.url}`);
    });
  }
  afterEach(() => outbound.mockReset().mockRejectedValue(new Error('offline')));

  it('installs the JSON-RPC connector for an Odoo below 19, and the one database it serves', async () => {
    odoo({ major: 17, serie: '17.0', databases: ['acme-main-123'] });
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, {
      adapter: 'odoo',
      settings: { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme' },
    });
    expect(out.isError).toBeUndefined();
    expect(adapters.importAdapter).toHaveBeenCalledWith(
      'odoo-jsonrpc',
      'u1',
      'org-1',
      { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme-main-123' },
      expect.anything(),
    );
    expect(out.body.installed).toBe('Odoo 14-18 (JSON-RPC)');
    expect(out.body.checkedTheAddress).toMatch(/version 17\.0, older than 19/);
    expect(out.body.checkedTheAddress).toMatch(/called "acme-main-123", not "acme"/);
    expect(out.body.finishSetupUrl).toMatch(/\/s\//);
  });

  it('keeps the JSON-2 connector on Odoo 19 and fills in a database the assistant left out', async () => {
    odoo({ major: 'saas~19', serie: 'saas~19.3', databases: ['acme-main-123'] });
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, { adapter: 'odoo', settings: { ODOO_URL: 'https://acme.odoo.com' } });
    expect(adapters.importAdapter.mock.calls[0][0]).toBe('odoo');
    expect(adapters.importAdapter.mock.calls[0][3].ODOO_DB).toBe('acme-main-123');
    expect(out.body.checkedTheAddress).toBe('The database is called "acme-main-123": that name was used.');
  });

  it('drops a database the address does not serve when it serves several, and names them', async () => {
    odoo({ major: 19, serie: '19.0', databases: ['prod', 'staging'] });
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, {
      adapter: 'odoo',
      settings: { ODOO_URL: 'https://erp.example.com', ODOO_DB: 'erp' },
    });
    expect(adapters.importAdapter.mock.calls[0][3]).toEqual({ ODOO_URL: 'https://erp.example.com' });
    expect(out.body.checkedTheAddress).toMatch(/no database "erp"; it serves "prod", "staging"/);
  });

  it('installs nothing when there is no Odoo database at the address', async () => {
    odoo({ typo: true });
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, { adapter: 'odoo', settings: { ODOO_URL: 'https://acme.odoo.com' } });
    expect(out.isError).toBe(true);
    expect(out.body.error).toMatch(/no Odoo database at https:\/\/acme\.odoo\.com/);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('installs as asked when the address says nothing, or the right values were passed', async () => {
    const { service, ctx, adapters } = build();
    const quiet: any = await service.install(ctx, {
      adapter: 'odoo',
      settings: { ODOO_URL: 'https://erp.example.com', ODOO_DB: 'prod' },
    });
    expect(quiet.body.checkedTheAddress).toBeUndefined();
    expect(adapters.importAdapter.mock.calls[0].slice(0, 4)).toEqual([
      'odoo', 'u1', 'org-1', { ODOO_URL: 'https://erp.example.com', ODOO_DB: 'prod' },
    ]);

    odoo({ major: 19, serie: '19.0', databases: ['prod'] });
    const right: any = await build().service.install(ctx, {
      adapter: 'odoo',
      settings: { ODOO_URL: 'https://erp.example.com', ODOO_DB: 'prod' },
    });
    expect(right.body.checkedTheAddress).toBeUndefined();
  });
});

describe('ConnectorSetupService — status of ready connectors', () => {
  /** A ready (keyless) connector row as status() reads it. */
  async function readyRow(updatedAt: Date) {
    const { service, ctx, prisma } = build();
    await service.install(ctx, { adapter: 'openplz' });
    const row = await prisma.connector.findUnique({ where: { id: 'c-openplz' } });
    return { ...row, name: 'OpenPLZ', createdAt: updatedAt, updatedAt };
  }

  it('says how the last call of a ready connector went', async () => {
    const row = await readyRow(new Date(Date.now() - 5 * 86_400_000));
    const at = new Date();
    const { service, ctx, adapters } = build({
      connectors: [row],
      lastCalls: { 'c-openplz': { status: 'ERROR', error: '401 Unauthorized: key revoked', createdAt: at } },
    });
    const out: any = (await service.status(ctx)).body;
    expect(out.connectors[0]).toMatchObject({
      status: 'ready',
      lastCall: { ok: false, at: at.toISOString(), error: '401 Unauthorized: key revoked' },
    });
    expect(adapters.verifyCredentials).not.toHaveBeenCalled();
  });

  it('runs the setup check on one finished today and never used, and gives a link to fix it when it fails', async () => {
    const row = await readyRow(new Date());
    const { service, ctx, adapters } = build({
      connectors: [row],
      verify: { ok: false, kind: 'auth_failed', message: 'The provider refused the key.' },
    });
    const out: any = (await service.status(ctx)).body;
    expect(adapters.verifyCredentials).toHaveBeenCalledWith('openplz', 'org-1', {}, 'c-openplz');
    expect(out.connectors[0]).toMatchObject({ check: { ok: false, message: 'The provider refused the key.' } });
    expect(out.connectors[0].fixUrl).toMatch(/\/s\//);
    expect(out.checkHint).toMatch(/fixUrl/);
  });

  it('leaves an old unused connector unchecked', async () => {
    const row = await readyRow(new Date(Date.now() - 3 * 86_400_000));
    const { service, ctx, adapters } = build({ connectors: [row] });
    const out: any = (await service.status(ctx)).body;
    expect(adapters.verifyCredentials).not.toHaveBeenCalled();
    expect(out.connectors[0].check).toBeUndefined();
    expect(out.checkHint).toBeUndefined();
  });
});

describe('ConnectorSetupService — links', () => {
  async function linkFor(build_: ReturnType<typeof build>) {
    const out: any = await build_.service.install(build_.ctx, { adapter: 'weclapp', settings: { WECLAPP_TENANT: 'acme' } });
    return out.body.finishSetupUrl.split('/s/')[1] as string;
  }

  it('keeps expired links a week (for measurement), not just until they expire', async () => {
    const b = build();
    const before = Date.now();
    await linkFor(b);
    const cutoff: Date = b.prisma.connectorSetupLink.deleteMany.mock.calls[0][0].where.expiresAt.lt;
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(SETUP_LINK_RETENTION_MS - 1000);
  });

  it('opens for the user it was made for, on the guided setup of that connector, in its workspace', async () => {
    const b = build();
    const token = await linkFor(b);
    await expect(b.service.resolveLink(token, 'someone-else')).resolves.toEqual({ error: expect.stringContaining('another account') });
    await expect(b.service.resolveLink(token, 'u1', 'claude')).resolves.toEqual({
      redirect: '/connectors/setup/weclapp?connector=c-weclapp&from=claude',
      organizationId: 'org-1',
    });
  });

  it('opens again for the same user until it expires, and records only the first opening', async () => {
    // A second click on the link in the chat said "already used".
    const b = build();
    const token = await linkFor(b);
    await b.service.resolveLink(token, 'u1');
    const first = b.links[0].usedAt;
    expect(first).toBeInstanceOf(Date);
    await expect(b.service.resolveLink(token, 'u1')).resolves.toMatchObject({
      redirect: '/connectors/setup/weclapp?connector=c-weclapp&from=assistant',
    });
    expect(b.links[0].usedAt).toBe(first);
    await expect(b.service.resolveLink(token, 'someone-else')).resolves.toEqual({ error: expect.stringContaining('another account') });
  });

  it('names the assistant of the chat on the link, and nothing when it is not known', async () => {
    for (const [assistant, suffix] of [
      ['claude', '?from=claude'],
      ['chatgpt', '?from=chatgpt'],
      ['muse', '?from=muse'],
      [null, ''],
      [undefined, ''],
    ] as const) {
      const b = build();
      const out: any = await b.service.install(
        { ...b.ctx, assistant },
        { adapter: 'weclapp', settings: { WECLAPP_TENANT: 'acme' } },
      );
      expect(out.body.finishSetupUrl).toMatch(
        new RegExp(`^https://cloud\\.example\\.com/s/[A-Za-z0-9_-]{20,}${suffix.replace('?', '\\?')}$`),
      );
    }
  });

  it('sends the user back to that assistant, or to a neutral page for anything else', async () => {
    for (const [from, back] of [
      ['claude', 'claude'],
      ['chatgpt', 'chatgpt'],
      ['muse', 'muse'],
      [undefined, 'assistant'],
      ['', 'assistant'],
      ['cursor', 'assistant'],
      ['https://evil.example', 'assistant'],
      [{ toString: () => 'claude' }, 'assistant'],
    ] as const) {
      const b = build();
      const token = await linkFor(b);
      await expect(b.service.resolveLink(token, 'u1', from)).resolves.toEqual({
        redirect: `/connectors/setup/weclapp?connector=c-weclapp&from=${back}`,
        organizationId: 'org-1',
      });
    }
  });

  it('does not open after it expires, or with a made-up token', async () => {
    const b = build();
    const token = await linkFor(b);
    b.links[0].expiresAt = new Date(Date.now() - 1000);
    await expect(b.service.resolveLink(token, 'u1')).resolves.toEqual({ error: expect.stringContaining('expired') });
    await expect(b.service.resolveLink('made-up', 'u1')).resolves.toEqual({ error: expect.stringContaining('expired') });
  });
});

describe('ConnectorSetupService — where a setup call comes from', () => {
  const logged = (productEvents: { log: jest.Mock }, event: string) =>
    productEvents.log.mock.calls.map(([e]) => e).filter((e) => e.event === event);

  it('records the chat\'s own calls as via mcp, as before', async () => {
    const { service, ctx, productEvents } = build({ role: 'ADMIN' });
    await service.find(ctx, { query: 'telegram' });
    await service.install(ctx, { adapter: 'telegram-bot' });
    expect(logged(productEvents, 'catalog_search')[0].metadata.via).toBe('mcp');
    expect(logged(productEvents, 'setup_completed')[0].metadata).toEqual(
      expect.objectContaining({ adapterSlug: 'telegram-bot', via: 'mcp' }),
    );
  });

  it('records the search fallback and a post-approve pick apart', async () => {
    const { service, ctx, productEvents } = build({ role: 'ADMIN' });
    await service.find(ctx, { query: 'telegram' }, { via: 'mcp_search_fallback' });
    await service.install(ctx, { adapter: 'telegram-bot' }, { via: 'post_approve' });
    expect(logged(productEvents, 'catalog_search')[0].metadata.via).toBe('mcp_search_fallback');
    expect(logged(productEvents, 'setup_completed')[0].metadata).toEqual({
      adapterSlug: 'telegram-bot',
      via: 'post_approve',
      verified: false,
    });
  });
});

describe('ConnectorSetupService — a WooCommerce address asked before a chat install', () => {
  it('uses the address WordPress names itself, and says WooCommerce was found', async () => {
    const { service, ctx, adapters } = build({
      woo: {
        url: 'https://shop.example.com',
        home: 'https://www.shop.example.com',
        corrected: 'https://www.shop.example.com',
        woocommerce: true,
      },
    });
    const out: any = await service.install(ctx, { adapter: 'woocommerce', settings: { WOOCOMMERCE_URL: 'shop.example.com' } });
    expect(adapters.importAdapter.mock.calls[0][3]).toEqual({ WOOCOMMERCE_URL: 'https://www.shop.example.com' });
    expect(out.body.checkedTheAddress).toBe(
      'WooCommerce answers at https://www.shop.example.com: that address was used instead of https://shop.example.com.',
    );
    expect(out.body.finishSetupUrl).toMatch(/\/s\//);
  });

  it('refuses a host name that does not exist, so the assistant asks again', async () => {
    const { service, ctx, adapters } = build({
      woo: { url: 'https://shpo.example.com', problem: 'dns', final: true, message: 'No site answers at shpo.example.com: that name does not exist.' },
    });
    const out: any = await service.install(ctx, { adapter: 'woocommerce', settings: { WOOCOMMERCE_URL: 'https://shpo.example.com' } });
    expect(out.isError).toBe(true);
    expect(out.body.error).toMatch(/that name does not exist/);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('installs, and passes on what the user must change in WordPress first, with the link', async () => {
    const { service, ctx, adapters } = build({
      woo: {
        url: 'https://shop.example.com',
        home: 'https://shop.example.com',
        problem: 'plain_permalinks',
        final: true,
        fixUrl: 'https://shop.example.com/wp-admin/options-permalink.php',
        message: 'Permalinks are Plain.',
      },
    });
    const out: any = await service.install(ctx, { adapter: 'woocommerce', settings: { WOOCOMMERCE_URL: 'https://shop.example.com' } });
    expect(adapters.importAdapter).toHaveBeenCalled();
    expect(out.body.checkedTheAddress).toBe(
      'Permalinks are Plain. Tell the user this before they create the key, with the link https://shop.example.com/wp-admin/options-permalink.php.',
    );
  });

  it('changes nothing when the address says nothing', async () => {
    const { service, ctx, adapters } = build();
    const out: any = await service.install(ctx, { adapter: 'woocommerce', settings: { WOOCOMMERCE_URL: 'https://shop.example.com' } });
    expect(adapters.importAdapter.mock.calls[0][3]).toEqual({ WOOCOMMERCE_URL: 'https://shop.example.com' });
    expect(out.body.checkedTheAddress).toBeUndefined();
  });
});

describe('ConnectorSetupService — unfinished and refused connectors in status', () => {
  /** A WooCommerce connector installed from a chat without any value, created `ageMs` ago. */
  async function pendingRow(ageMs: number) {
    const { service, ctx, prisma } = build();
    await service.install(ctx, { adapter: 'woocommerce' });
    const row = await prisma.connector.findUnique({ where: { id: 'c-woocommerce' } });
    const at = new Date(Date.now() - ageMs);
    return { ...row, name: 'WooCommerce', envVars: {}, createdAt: at, updatedAt: at };
  }

  it('offers the link again for a catalog connector still waiting for its values after a day', async () => {
    const row = await pendingRow(2 * 86_400_000);
    const { service, ctx } = build({ connectors: [row] });
    const out: any = (await service.status(ctx)).body;
    expect(out.connectors[0]).toMatchObject({
      status: 'needs_input',
      finishSetupUrl: expect.stringMatching(/\/s\//),
      unfinishedSince: row.createdAt.toISOString(),
    });
    expect(out.unfinishedHint).toMatch(/Offer the user its finishSetupUrl/);
  });

  it('says nothing extra about one added today', async () => {
    const row = await pendingRow(60 * 60 * 1000);
    const { service, ctx } = build({ connectors: [row] });
    const out: any = (await service.status(ctx)).body;
    expect(out.connectors[0].finishSetupUrl).toMatch(/\/s\//);
    expect(out.connectors[0].unfinishedSince).toBeUndefined();
    expect(out.unfinishedHint).toBeUndefined();
  });

  it('names a ready connector whose saved credentials the provider keeps refusing, with a link to fix them', async () => {
    const first = build();
    await first.service.install(first.ctx, { adapter: 'openplz' });
    const ready = await first.prisma.connector.findUnique({ where: { id: 'c-openplz' } });
    const since = new Date(Date.now() - 3 * 86_400_000);
    const row = {
      ...ready,
      name: 'OpenPLZ',
      createdAt: since,
      updatedAt: since,
      authStatus: 'needs_reauth',
      authStatusMessage: "The API refused this connector's saved credentials on 5 calls in a row (HTTP 401).",
      authStatusAt: since,
    };
    const { service, ctx } = build({ connectors: [row] });
    const out: any = (await service.status(ctx)).body;
    expect(out.connectors[0]).toMatchObject({
      status: 'ready',
      credential: { ok: false, since: since.toISOString(), message: expect.stringMatching(/5 calls in a row/) },
      fixUrl: expect.stringMatching(/\/s\//),
    });
    expect(out.credentialHint).toMatch(/fixUrl/);
  });
});
