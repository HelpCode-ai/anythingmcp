import { SupportConnectorSetupService } from './support-connector-setup.service';

const HOST = 'cloud.anythingmcp.com';
const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const CONTACT_ID = 42;
// Built at run time: nothing here reads as a real key.
const KEY = 'fk_' + 'a1'.repeat(12);
const SECRET = 'fs_' + 'b2'.repeat(12);

const FUDO = {
  slug: 'fudo',
  name: 'Fudo API',
  connector: { type: 'REST', baseUrl: 'https://api.fu.do/v1alpha1', authType: 'API_KEY', authConfig: {} },
  requiredEnvVars: ['FUDO_API_KEY', 'FUDO_API_SECRET'],
  optionalEnvVars: [],
  envVarMeta: {},
  tools: [{ name: 'fudo_list_sales' }],
};
const TELEGRAM = {
  ...FUDO,
  slug: 'telegram-bot',
  name: 'Telegram Bot API',
  requiredEnvVars: ['TELEGRAM_BOT_TOKEN'],
};

class TestService extends SupportConnectorSetupService {
  saved: Array<{ id: string; values: Record<string, string> }> = [];
  constructor(
    deps: any,
    private readonly desk: any,
  ) {
    super(
      deps.prisma,
      deps.adapters,
      deps.setup,
      deps.licenseGuard,
      deps.mcpServers,
      deps.email,
      deps.securityEvents,
      deps.productEvents,
      {} as any,
    );
  }
  protected client() {
    return this.desk;
  }
  protected host() {
    return HOST;
  }
  protected dashboardBase() {
    return 'https://cloud.anythingmcp.com';
  }
  protected async saveValues(id: string, _user: unknown, values: Record<string, string>) {
    this.saved.push({ id, values });
  }
}

const identity = (over: Record<string, string> = {}) => ({
  externalUserId: `${HOST}:${USER_ID}`,
  contactType: 'contact',
  conversationUuid: 'conv-1',
  ...over,
});

function setup(
  opts: {
    definition?: any;
    messages?: any[];
    existing?: Array<{ id: string }>;
    states?: Record<string, { status: string; missing: string[] }>;
    verify?: any;
    user?: any;
    externalOnConversation?: string;
  } = {},
) {
  const definition = opts.definition ?? FUDO;
  const desk = {
    conversation: jest.fn().mockResolvedValue({
      uuid: 'conv-1',
      inbox_channel: 'livechat',
      contact: { id: CONTACT_ID, type: 'contact', external_user_id: opts.externalOnConversation ?? `${HOST}:${USER_ID}` },
    }),
    incomingMessages: jest.fn().mockResolvedValue(
      opts.messages ?? [
        { type: 'incoming', private: false, sender_type: 'contact', sender_id: CONTACT_ID, text_content: `key ${KEY} secret ${SECRET}` },
      ],
    ),
  };
  const states = opts.states ?? {};
  const deps = {
    prisma: {
      user: {
        findUnique: jest.fn().mockResolvedValue(
          opts.user === undefined
            ? {
                id: USER_ID,
                email: 'ana@example.com',
                name: 'Ana',
                emailVerified: true,
                memberships: [{ organizationId: ORG_ID, role: 'ADMIN', organization: { name: 'Acme' } }],
              }
            : opts.user,
        ),
      },
      connector: { findMany: jest.fn().mockResolvedValue(opts.existing ?? []) },
      organizationMember: { findMany: jest.fn().mockResolvedValue([{ user: { email: 'boss@example.com', name: 'Boss' } }]) },
    },
    adapters: {
      describe: jest.fn((slug: string) => {
        if (slug === definition.slug) return definition;
        throw new Error('unknown');
      }),
      verifyCredentials: jest.fn().mockResolvedValue(opts.verify ?? { ok: true, toolName: 't', durationMs: 1, sample: '' }),
      importAdapter: jest.fn().mockResolvedValue({ connectorId: 'new-1' }),
    },
    setup: {
      connectorStatus: jest.fn(async (id: string) => states[id] ?? { status: 'needs_input', missing: ['FUDO_API_KEY'] }),
      createLink: jest.fn().mockResolvedValue('https://cloud.anythingmcp.com/s/once'),
    },
    licenseGuard: { checkCanCreateConnector: jest.fn().mockResolvedValue(undefined) },
    mcpServers: { attachToDefaultServer: jest.fn().mockResolvedValue({ id: 's1', name: 'Default' }) },
    email: { sendConnectorAddedFromSupportEmail: jest.fn().mockResolvedValue(true) },
    securityEvents: { log: jest.fn().mockResolvedValue(undefined) },
    productEvents: { log: jest.fn().mockResolvedValue(undefined) },
  };
  return { svc: new TestService(deps, desk), deps, desk };
}

describe('SupportConnectorSetupService', () => {
  it('refuses a contact that is not a Cloud user, or whose conversation names someone else', async () => {
    const a = setup();
    expect(await a.svc.handle(identity({ externalUserId: 'other.host:user-1' }), { app: 'fudo' })).toHaveProperty('error');
    expect(await a.svc.handle(identity({ contactType: 'visitor' }), { app: 'fudo' })).toHaveProperty('error');
    const b = setup({ externalOnConversation: `${HOST}:someone-else` });
    expect(await b.svc.handle(identity(), { app: 'fudo' })).toHaveProperty('error');
    expect(b.deps.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(a.deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('refuses an unverified email, several workspaces and a viewer', async () => {
    const base = { id: USER_ID, email: 'a@x.com', name: null, emailVerified: true };
    const one = [{ organizationId: ORG_ID, role: 'ADMIN', organization: { name: 'Acme' } }];
    for (const user of [
      { ...base, emailVerified: false, memberships: one },
      { ...base, memberships: [...one, { organizationId: 'org-2', role: 'ADMIN', organization: null }] },
      { ...base, memberships: [{ ...one[0], role: 'VIEWER' }] },
    ]) {
      const { svc, deps } = setup({ user });
      expect(await svc.handle(identity(), { app: 'fudo' })).toHaveProperty('error');
      expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    }
  });

  it('without values installs the connector and returns a one-time link, without an email', async () => {
    const { svc, deps } = setup();
    const answer = await svc.handle(identity(), { app: 'fudo' });
    expect(deps.adapters.importAdapter).toHaveBeenCalledWith('fudo', USER_ID, ORG_ID, {}, { addressMayWait: true });
    expect(deps.mcpServers.attachToDefaultServer).toHaveBeenCalledWith(USER_ID, ORG_ID, 'new-1');
    expect(answer).toMatchObject({ installed: 'Fudo API', finishSetupUrl: 'https://cloud.anythingmcp.com/s/once' });
    expect(deps.adapters.verifyCredentials).not.toHaveBeenCalled();
    expect(deps.email.sendConnectorAddedFromSupportEmail).not.toHaveBeenCalled();
    expect(deps.securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ adapter: 'fudo', withPastedValues: false }) }),
    );
  });

  it('uses keys the customer pasted: checked, installed, admins emailed, never echoed', async () => {
    const { svc, deps } = setup({ states: { 'new-1': { status: 'ready', missing: [] } } });
    const answer = await svc.handle(identity(), { app: 'Fudo', values: { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET } });
    expect(deps.adapters.verifyCredentials).toHaveBeenCalledWith('fudo', ORG_ID, { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET });
    expect(deps.adapters.importAdapter).toHaveBeenCalledWith(
      'fudo',
      USER_ID,
      ORG_ID,
      { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET },
      { addressMayWait: true },
    );
    expect(answer).toMatchObject({ done: true, connector: 'Fudo API' });
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(deps.email.sendConnectorAddedFromSupportEmail).toHaveBeenCalledTimes(2);
  });

  it('refuses a key that is not in the customer\'s own messages', async () => {
    const invented = setup();
    expect(await invented.svc.handle(identity(), { app: 'fudo', values: { FUDO_API_KEY: 'fk_' + 'z9'.repeat(12) } })).toHaveProperty(
      'error',
    );
    const agentSaidIt = setup({
      messages: [{ type: 'incoming', private: false, sender_type: 'agent', sender_id: 3, text_content: `key ${KEY}` }],
    });
    expect(await agentSaidIt.svc.handle(identity(), { app: 'fudo', values: { FUDO_API_KEY: KEY } })).toHaveProperty('error');
    for (const s of [invented, agentSaidIt]) expect(s.deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('stores nothing when the provider refuses the keys, and scrubs them from the reason', async () => {
    const { svc, deps } = setup({ verify: { ok: false, kind: 'auth_failed', message: `401 for key ${KEY}` } });
    const answer = await svc.handle(identity(), { app: 'fudo', values: { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET } });
    expect(answer).toHaveProperty('error');
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('never touches a working connector of the same app: it gets the link to it instead', async () => {
    const { svc, deps } = setup({ existing: [{ id: 'c1' }], states: { c1: { status: 'ready', missing: [] } } });
    const answer = await svc.handle(identity(), { app: 'fudo', values: { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET } });
    expect(answer).toMatchObject({ alreadyInstalled: 'Fudo API', valuesNotUsed: expect.any(String) });
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect((svc as TestService).saved).toEqual([]);
    expect(deps.setup.createLink).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), 'c1');
  });

  it('fills the oldest connector when none of the app works yet', async () => {
    const { svc, deps } = setup({ existing: [{ id: 'c1' }, { id: 'c2' }] });
    await svc.handle(identity(), { app: 'fudo', values: { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET } });
    expect(deps.adapters.verifyCredentials).toHaveBeenCalledWith('fudo', ORG_ID, expect.any(Object), 'c1');
    expect((svc as TestService).saved).toEqual([{ id: 'c1', values: { FUDO_API_KEY: KEY, FUDO_API_SECRET: SECRET } }]);
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(deps.securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ filledEmptyConnector: true }) }),
    );
  });

  it('leaves a pasted Telegram token to the message webhook', async () => {
    const token = '7712345678:' + 'AA' + 'x'.repeat(33);
    const { svc, deps } = setup({
      definition: TELEGRAM,
      messages: [{ type: 'incoming', private: false, sender_type: 'contact', sender_id: CONTACT_ID, text_content: token }],
    });
    const answer = await svc.handle(identity(), { app: 'telegram-bot', values: { TELEGRAM_BOT_TOKEN: token } });
    expect(answer).toMatchObject({ handledAutomatically: true });
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('names the settings when the model uses a wrong one, and refuses an unknown app', async () => {
    const { svc } = setup();
    const wrong = await svc.handle(identity(), { app: 'fudo', values: { API_KEY: KEY } });
    expect(wrong).toMatchObject({ settings: expect.arrayContaining([expect.objectContaining({ name: 'FUDO_API_KEY' })]) });
    expect(await svc.handle(identity(), { app: 'no-such-app-xyz' })).toHaveProperty('error');
  });
});
