import { ConnectorSetupService } from './connector-setup.service';
import { AdaptersService } from './adapters.service';
import { encrypt } from '../common/crypto/encryption.util';

const KEY = 'k'.repeat(32);

function build(opts: { role?: string; connectors?: any[]; importResult?: any } = {}) {
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
  };
  const realAdapters = new AdaptersService(
    { connector: {}, mcpTool: {} } as any,
    { reloadConnectorTools: jest.fn() } as any,
    { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) } as any,
    {} as any,
  );
  const adapters: any = {
    listAll: () => realAdapters.listAll(),
    describe: (slug: string) => realAdapters.describe(slug),
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
      };
      return { connectorId: id, toolsCreated: def.tools.length, probe: opts.importResult ?? null };
    }),
  };
  const licenseGuard: any = {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
    getUsage: jest.fn().mockResolvedValue({ connectors: { current: 1, max: 5 } }),
  };
  const securityEvents: any = { log: jest.fn() };
  const productEvents: any = { log: jest.fn() };
  const service = new ConnectorSetupService(prisma, adapters as unknown as AdaptersService, licenseGuard, { register: jest.fn() } as any, securityEvents, productEvents);
  const ctx = { userId: 'u1', organizationId: 'org-1', serverIds: ['srv-granted'], dashboardBase: 'https://cloud.example.com' };
  return { service, prisma, adapters, licenseGuard, securityEvents, links, serverConnectors, ctx };
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
    expect(etsy.enteredByTheUserOnTheLinkedPage).toContain('Shared secret');
    expect(out.connectorsLeftOnThisPlan).toBe(4);
  });

  it('never offers payment, banking or trading connectors', async () => {
    const { service, ctx } = build();
    const out: any = (await service.find(ctx, { query: 'payone sorare', limit: 10 })).body;
    expect(out.results.map((r: any) => r.adapter)).not.toEqual(expect.arrayContaining(['payone', 'sorare']));
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

  it('asks for the sign-in when an OAuth connector has its app keys', async () => {
    const { service, ctx } = build();
    const out: any = await service.install(ctx, { adapter: 'etsy', settings: { ETSY_CLIENT_ID: 'ks' } });
    expect(out.body.status).toBe('needs_input'); // the shared secret still has to be entered on the page
    expect(out.body.whatTheUserDoes).toMatch(/enter Shared secret, then sign in to .+ and approve\./);
    expect(out.body.finishSetupUrl).toBeDefined();
  });

  it('stops after ten installs an hour', async () => {
    const { service, ctx } = build();
    for (let i = 0; i < 10; i++) await service.install(ctx, { adapter: 'openplz' });
    const out = await service.install(ctx, { adapter: 'openplz' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.body)).toContain('an hour');
  });

  it('respects the trial limit', async () => {
    const { service, ctx, licenseGuard, adapters } = build();
    licenseGuard.checkCanCreateConnector.mockRejectedValueOnce(new Error('Trial limit reached (2 connectors).'));
    const out = await service.install(ctx, { adapter: 'openplz' });
    expect(out.isError).toBe(true);
    expect(adapters.importAdapter).not.toHaveBeenCalled();
  });
});

describe('ConnectorSetupService — links', () => {
  async function linkFor(build_: ReturnType<typeof build>) {
    const out: any = await build_.service.install(build_.ctx, { adapter: 'weclapp', settings: { WECLAPP_TENANT: 'acme' } });
    return out.body.finishSetupUrl.split('/s/')[1] as string;
  }

  it('opens once, for the user it was made for, on the guided setup of that connector', async () => {
    const b = build();
    const token = await linkFor(b);
    await expect(b.service.resolveLink(token, 'someone-else')).resolves.toEqual({ error: expect.stringContaining('another account') });
    await expect(b.service.resolveLink(token, 'u1')).resolves.toEqual({
      redirect: '/connectors/setup/weclapp?connector=c-weclapp&from=claude',
    });
    await expect(b.service.resolveLink(token, 'u1')).resolves.toEqual({ error: expect.stringContaining('already used') });
  });

  it('does not open after it expires, or with a made-up token', async () => {
    const b = build();
    const token = await linkFor(b);
    b.links[0].expiresAt = new Date(Date.now() - 1000);
    await expect(b.service.resolveLink(token, 'u1')).resolves.toEqual({ error: expect.stringContaining('expired') });
    await expect(b.service.resolveLink('made-up', 'u1')).resolves.toEqual({ error: expect.stringContaining('expired') });
  });
});
