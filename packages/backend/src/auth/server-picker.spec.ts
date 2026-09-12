// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';

/**
 * The second step of the authorize flow — which MCP servers a client may reach.
 *
 * Two things are being pinned here. The first is that it stays OUT of the way:
 * 1318 of 1393 workspaces on the cloud instance have exactly one MCP server and
 * all but four users belong to a single workspace, so a screen shown to
 * everyone would add a step to the flow this work exists to shorten. The second
 * is that nothing submitted by the browser is trusted with identity.
 */
function build(
  opts: {
    targets?: any[];
    consent?: any;
    requestedServerId?: string;
  } = {},
) {
  const grants = {
    grantServers: jest.fn().mockResolvedValue(['srv-1']),
    grantWholeOrganization: jest.fn().mockResolvedValue(true),
    listSelectableTargets: jest.fn().mockResolvedValue(opts.targets ?? []),
  };
  const store = {
    getOAuthSession: jest.fn().mockResolvedValue(
      opts.consent === null
        ? null
        : { clientId: 'client-1', redirectUri: 'https://claude.ai/cb', scope: 's' },
    ),
    getClient: jest.fn().mockResolvedValue({ client_name: 'Claude' }),
  };
  const controller = new LoginController(
    { comparePassword: jest.fn() } as any,
    { user: { findUnique: jest.fn() } } as any,
    { get: jest.fn() } as any,
    store as any,
    { startMcp: jest.fn() } as any,
    { isCloud: () => true } as any,
    grants as any,
  );

  const req: any = {
    cookies: { oauth_session: opts.consent === null ? undefined : 'sess-1' },
    signedCookies: opts.requestedServerId
      ? { mcp_resource: opts.requestedServerId }
      : {},
    headers: { host: 'cloud.anythingmcp.com' },
  };
  const res: any = {
    cookie: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn(),
    clearCookie: jest.fn(),
  };
  return { controller, grants, req, res };
}

const ask = (c: LoginController, req: any, res: any, userId = 'u1') =>
  (c as any).maybeAskWhichServers(req, res, userId);

const workspace = (id: string, name: string, servers: any[]) => ({
  organizationId: id,
  organizationName: name,
  servers,
});
const server = (id: string, name: string, connectorCount = 1) => ({
  id,
  name,
  connectorCount,
});

describe('choosing what a client may reach', () => {
  it('shows nothing and grants the only server there is', async () => {
    const { controller, grants, req, res } = build({
      targets: [workspace('org-A', 'Acme', [server('srv-1', 'Default')])],
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-1']);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('asks once there is more than one server to choose between', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'ERP'), server('srv-2', 'CRM')]),
      ],
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    expect(res.send).toHaveBeenCalled();
    const html = res.send.mock.calls[0][0];
    expect(html).toContain('ERP');
    expect(html).toContain('CRM');
    expect(html).toContain('Everything in this workspace');
    // Nothing is granted until the user answers.
    expect(grants.grantServers).not.toHaveBeenCalled();
  });

  it('asks a multi-workspace user even when each workspace has one server', async () => {
    const { controller, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'Default')]),
        workspace('org-B', 'Globex', [server('srv-2', 'Default')]),
      ],
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);
    const html = res.send.mock.calls[0][0];
    expect(html).toContain('Acme');
    expect(html).toContain('Globex');
  });

  // The client already said which server it wants via RFC 8707. Asking again
  // would be noise — but it still goes through grantServers, which drops an id
  // this user cannot reach.
  it('honours a server the client named, without asking', async () => {
    const { controller, grants, req, res } = build({
      requestedServerId: 'srv-named',
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'a'), server('srv-2', 'b')]),
      ],
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-named']);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('grants the workspace when it has no servers yet, so one added later is picked up', async () => {
    const { controller, grants, req, res } = build({
      targets: [workspace('org-A', 'Acme', [])],
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantWholeOrganization).toHaveBeenCalledWith('client-1', 'u1', 'org-A');
  });

  it('does nothing at all outside an authorize flow', async () => {
    const { controller, grants, req, res } = build({ consent: null });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
  });

  it('carries the verified identity in a signed cookie, never the form', async () => {
    const { controller, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'a'), server('srv-2', 'b')]),
      ],
    });

    await ask(controller, req, res);

    const pending = res.cookie.mock.calls.find((c: any[]) => c[0] === 'pending_grant');
    expect(pending).toBeDefined();
    expect(pending[1]).toBe('u1');
    expect(pending[2]).toMatchObject({ httpOnly: true, signed: true });
    // The rendered form must not carry the user id anywhere.
    expect(res.send.mock.calls[0][0]).not.toContain('u1');
  });

  it('escapes a workspace name instead of interpolating it raw', async () => {
    const { controller, req, res } = build({
      targets: [
        workspace('org-A', '<img src=x onerror=alert(1)>', [
          server('srv-1', 'a'),
          server('srv-2', 'b'),
        ]),
      ],
    });

    await ask(controller, req, res);
    const html = res.send.mock.calls[0][0];
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('submitting the selection', () => {
  const submit = (c: LoginController, req: any, body: any, res: any) =>
    (c as any).handleServerSelection(req, body, res);

  function submitFixture(signed: Record<string, unknown>) {
    const f = build({ targets: [] });
    f.req.signedCookies = { login_csrf: 'tok', ...signed };
    return f;
  }

  it('refuses without a matching CSRF token', async () => {
    const { controller, grants, req, res } = submitFixture({ pending_grant: 'u1' });

    await submit(controller, req, { servers: ['srv-1'], csrf: 'wrong' }, res);

    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error='));
  });

  it('refuses when the signed identity cookie is absent', async () => {
    const { controller, grants, req, res } = submitFixture({});

    await submit(controller, req, { servers: ['srv-1'], csrf: 'tok' }, res);

    expect(grants.grantServers).not.toHaveBeenCalled();
  });

  it('refuses an empty selection rather than granting nothing silently', async () => {
    const { controller, grants, req, res } = submitFixture({ pending_grant: 'u1' });

    await submit(controller, req, { csrf: 'tok' }, res);

    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('Choose%20at%20least%20one'),
    );
  });

  // The ids come from the browser. grantServers resolves each one's owning
  // organization and drops what this user cannot reach, so a tampered form can
  // only ever produce a NARROWER grant — never a wider one.
  it('sends the submitted ids straight to the validating write', async () => {
    const { controller, grants, req, res } = submitFixture({ pending_grant: 'u1' });

    await submit(
      controller,
      req,
      { servers: ['srv-mine', 'srv-of-another-tenant'], csrf: 'tok' },
      res,
    );

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', [
      'srv-mine',
      'srv-of-another-tenant',
    ]);
  });

  it('stops when nothing in the selection validated', async () => {
    const { controller, grants, req, res } = submitFixture({ pending_grant: 'u1' });
    grants.grantServers.mockResolvedValue([]);

    await submit(controller, req, { servers: ['srv-theirs'], csrf: 'tok' }, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('None%20of%20the%20selected'),
    );
  });
});
