import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupportIdentityService, connectorLinks, mcpServerUrls, splitName } from './support-identity.service';
import { instanceHost, supportChatConfig, supportModuleEnabled, supportTriageConfig } from './support-config';

const SAVED = { ...process.env };

function fakePrisma() {
  return {
    user: {
      findUnique: jest.fn().mockImplementation(({ select }) =>
        Promise.resolve(
          select.email
            ? { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' }
            : { role: 'ADMIN', createdAt: new Date('2026-10-01T10:00:00Z'), emailVerified: true },
        ),
      ),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
    connector: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'c1',
          name: 'Etsy',
          isActive: true,
          authStatus: 'needs_reauth',
          authStatusMessage: 'refresh token revoked',
          config: { adapterSlug: 'etsy' },
        },
        { id: 'c2', name: 'Shopify', isActive: true, authStatus: null, authStatusMessage: null },
        { id: 'c3', name: 'Old', isActive: false, authStatus: null, authStatusMessage: null },
      ]),
    },
    mcpServerConfig: {
      findMany: jest.fn().mockResolvedValue([{ id: 's1', name: 'Default (Ada)' }]),
    },
    toolInvocation: {
      groupBy: jest.fn().mockResolvedValue([{ connectorId: 'c2', _count: { _all: 7 } }]),
      findFirst: jest.fn().mockResolvedValue({
        error: '401 Unauthorized: token=FAKE-not-a-real-credential-0000',
        tool: { name: 'shopify_list_orders' },
      }),
    },
  };
}

function build(isCloud = true) {
  const prisma = fakePrisma();
  const deployment = { isCloud: () => isCloud };
  const license = {
    getCurrentLicense: jest.fn().mockResolvedValue({
      plan: 'trial',
      status: 'active',
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    }),
  };
  return { svc: new SupportIdentityService(prisma as any, deployment as any, license as any), prisma, license };
}

describe('support config', () => {
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('is off unless every variable of a part is set', () => {
    const env = { SUPPORT_CHAT_URL: 'https://desk.test/', SUPPORT_CHAT_INBOX_ID: 'i' } as any;
    expect(supportChatConfig(env)).toBeNull();
    expect(supportModuleEnabled(env)).toBe(false);
    expect(supportChatConfig({ ...env, SUPPORT_CHAT_SECRET: 's' })).toEqual({
      baseUrl: 'https://desk.test',
      inboxId: 'i',
      secret: 's',
    });
    expect(
      supportTriageConfig({
        SUPPORT_CHAT_URL: 'https://desk.test',
        LIBREDESK_API_KEY: 'k',
        LIBREDESK_API_SECRET: 's',
        LIBREDESK_WEBHOOK_SECRET: 'w',
      } as any)?.baseUrl,
    ).toBe('https://desk.test');
    const triage = {
      SUPPORT_CHAT_URL: 'https://desk.test',
      LIBREDESK_API_KEY: 'k',
      LIBREDESK_API_SECRET: 's',
      LIBREDESK_WEBHOOK_SECRET: 'w',
    } as any;
    expect(supportTriageConfig(triage)?.aiAssistantUserId).toBeNull();
    expect(supportTriageConfig({ ...triage, LIBREDESK_AI_ASSISTANT_USER_ID: '5' })?.aiAssistantUserId).toBe(5);
    expect(supportTriageConfig({ ...triage, LIBREDESK_AI_ASSISTANT_USER_ID: 'x' })?.aiAssistantUserId).toBeNull();
  });

  it('instance host comes from FRONTEND_URL', () => {
    expect(instanceHost({ FRONTEND_URL: 'https://cloud.anythingmcp.com' } as any)).toBe('cloud.anythingmcp.com');
    expect(instanceHost({} as any)).toBe('unknown');
  });
});

describe('SupportIdentityService', () => {
  beforeEach(() => {
    process.env.SUPPORT_CHAT_URL = 'https://desk.test';
    process.env.SUPPORT_CHAT_INBOX_ID = 'inbox-uuid';
    process.env.SUPPORT_CHAT_SECRET = 'inbox-secret';
    process.env.FRONTEND_URL = 'https://cloud.anythingmcp.com';
    process.env.SERVER_URL = 'https://cloud.anythingmcp.com/';
  });
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('signs an HS256 identity the desk can verify, scoped per instance', async () => {
    const { svc } = build();
    const session = await svc.widgetSession('u1', 'org1');
    expect(session).toMatchObject({ baseUrl: 'https://desk.test', inboxId: 'inbox-uuid' });

    const claims: any = new JwtService().verify(session.userJwt, { secret: 'inbox-secret', algorithms: ['HS256'] });
    expect(claims.external_user_id).toBe('cloud.anythingmcp.com:u1');
    expect(claims.email).toBe('ada@example.com');
    expect(claims.first_name).toBe('Ada');
    expect(claims.last_name).toBe('Lovelace');
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.contact_custom_attributes).toMatchObject({
      deployment: 'cloud',
      organization_name: 'Acme',
      plan: 'trial',
      trial_ends_at: '2026-10-26',
      connectors: '3 (1 inactive)',
    });
  });

  it('summarises connector issues without leaking credentials', async () => {
    const { svc } = build();
    const attrs = await svc.contactAttributes('u1', 'org1');
    expect(attrs.connector_issues).toContain('Etsy: auth needs_reauth');
    expect(attrs.connector_issues).toContain('Shopify: 7 failed calls/24h, last shopify_list_orders: 401');
    expect(attrs.connector_issues).not.toContain('FAKE-not-a-real-credential-0000');
  });

  it('names the connectors and the day of the last successful tool call', async () => {
    const { svc, prisma } = build();
    prisma.toolInvocation.findFirst.mockImplementation(async (q: any) =>
      q.where.status === 'SUCCESS' ? { createdAt: new Date('2026-10-20T08:00:00Z') } : null,
    );
    const attrs = await svc.contactAttributes('u1', 'org1');
    expect(attrs.connector_names).toContain('Etsy');
    expect(attrs.last_tool_call).toBe('2026-10-20');
    const q = prisma.toolInvocation.findFirst.mock.calls.find((c: any[]) => c[0].where.status === 'SUCCESS')[0];
    expect(q.where.organizationId).toBe('org1');
  });

  it('links each connector to its own page, so the desk never sends the generic setup link', async () => {
    const { svc } = build();
    const attrs = await svc.contactAttributes('u1', 'org1');
    expect(attrs.connector_links).toBe(
      'Etsy: https://cloud.anythingmcp.com/connectors/setup/etsy?connector=c1 | ' +
        'Shopify: https://cloud.anythingmcp.com/connectors/c2 | Old: https://cloud.anythingmcp.com/connectors/c3',
    );
  });

  it('builds no links without a dashboard URL, and keeps them bounded', () => {
    expect(connectorLinks([{ id: 'c1', name: 'Etsy' }], undefined)).toBe('');
    expect(connectorLinks([{ id: 'c1', name: 'Etsy' }], 'not a url')).toBe('');
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: 'X'.repeat(80) }));
    const out = connectorLinks(many, 'https://cloud.anythingmcp.com/');
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.split(' | ').length).toBeLessThanOrEqual(15);
    expect(out).not.toContain('com//connectors');
  });

  it("gives the workspace's MCP server URL, the address an AI client connects to", async () => {
    const { svc, prisma } = build();
    const attrs = await svc.contactAttributes('u1', 'org1');
    expect(attrs.mcp_server_urls).toBe('Default (Ada): https://cloud.anythingmcp.com/mcp/s1');
    const q = prisma.mcpServerConfig.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organizationId: 'org1', isActive: true });
  });

  it('builds no server URL without a public server URL, and keeps the list bounded', () => {
    expect(mcpServerUrls([{ id: 's1', name: 'Default' }], undefined)).toBe('');
    expect(mcpServerUrls([{ id: 's1', name: 'Default' }], 'not a url')).toBe('');
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
    const out = mcpServerUrls(many, 'https://cloud.anythingmcp.com');
    expect(out.split(' | ')).toHaveLength(5);
    expect(out).toContain('and more on the MCP Servers page');
    expect(out).not.toContain('/connectors/');
  });

  it('says "never" when no AI client has called a tool yet', async () => {
    const { svc, prisma } = build();
    prisma.toolInvocation.findFirst.mockResolvedValue(null);
    expect((await svc.contactAttributes('u1', 'org1')).last_tool_call).toBe('never');
  });

  it('filters every query by the caller organization', async () => {
    const { svc, prisma, license } = build();
    await svc.contactAttributes('u1', 'org1');
    expect(prisma.connector.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1' });
    expect(prisma.toolInvocation.groupBy.mock.calls[0][0].where.organizationId).toBe('org1');
    expect(prisma.toolInvocation.findFirst.mock.calls[0][0].where.organizationId).toBe('org1');
    expect(license.getCurrentLicense).toHaveBeenCalledWith('org1');
  });

  it('caches the snapshot for a few minutes', async () => {
    const { svc, prisma } = build();
    await svc.contactAttributes('u1', 'org1');
    await svc.contactAttributes('u1', 'org1');
    expect(prisma.connector.findMany).toHaveBeenCalledTimes(1);
  });

  it('marks dedicated instances', async () => {
    const { svc } = build(false);
    expect((await svc.contactAttributes('u1', 'org1')).deployment).toBe('dedicated');
  });

  it('is 404 when the chat is not configured', async () => {
    delete process.env.SUPPORT_CHAT_SECRET;
    const { svc } = build();
    await expect(svc.widgetSession('u1', 'org1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('splitName falls back to the email local part', () => {
    expect(splitName(null, 'bob@x.test')).toEqual({ first: 'bob', last: '' });
    expect(splitName('  Grace   Brewster Hopper ', 'g@x.test')).toEqual({ first: 'Grace', last: 'Brewster Hopper' });
  });
});
