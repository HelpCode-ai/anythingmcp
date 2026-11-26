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
    /** Member visibility narrows the user's view of the workspace. */
    restricted?: boolean;
    /** The user's own first server in the workspace, where connectors they add go. */
    ownServerId?: string | null;
    /** This client already holds a grant the user has not revoked. */
    hasGrant?: boolean;
    /** Connectors of the workspace, on a server or not. */
    workspaceConnectors?: number;
    /** The signed-in user's email address. */
    email?: string;
    /** Per workspace: member visibility narrows the user's view there. */
    restrictedOrgs?: string[];
  } = {},
) {
  const grants = {
    grantServers: jest.fn().mockResolvedValue(['srv-1']),
    grantRequestedServer: jest.fn().mockResolvedValue(true),
    grantWholeOrganization: jest.fn().mockResolvedValue(true),
    listSelectableTargets: jest.fn().mockResolvedValue(opts.targets ?? []),
    restrictedIn: jest.fn(async (_userId: string, orgId: string) =>
      opts.restrictedOrgs ? opts.restrictedOrgs.includes(orgId) : !!opts.restricted,
    ),
    firstOwnServerId: jest.fn().mockResolvedValue(opts.ownServerId ?? null),
    hasActiveGrant: jest.fn().mockResolvedValue(!!opts.hasGrant),
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
    {
      user: { findUnique: jest.fn().mockResolvedValue(opts.email ? { email: opts.email } : null) },
      connector: { count: jest.fn().mockResolvedValue(opts.workspaceConnectors ?? 0) },
    } as any,
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

  it('grants a restricted member the whole workspace instead of their one own server', async () => {
    // Member visibility offers them only their own server, which often holds
    // none of the connectors shared with them; the workspace connection gives
    // every tool their roles allow.
    const { controller, grants, req, res } = build({
      targets: [workspace('org-A', 'Acme', [server('srv-own', 'Default (Vera)', 0)])],
      restricted: true,
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.restrictedIn).toHaveBeenCalledWith('u1', 'org-A');
    expect(grants.grantWholeOrganization).toHaveBeenCalledWith('client-1', 'u1', 'org-A');
    expect(grants.grantServers).not.toHaveBeenCalled();
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
  // would be noise. It goes through grantRequestedServer, which drops an id
  // this user cannot reach and ADDS the server to what the client was already
  // allowed: a second server URL of the same client must not take the first
  // one's access away.
  it('honours a server the client named, without asking', async () => {
    const { controller, grants, req, res } = build({
      requestedServerId: 'srv-named',
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'a'), server('srv-2', 'b')]),
      ],
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantRequestedServer).toHaveBeenCalledWith('client-1', 'u1', 'srv-named');
    // Not grantServers, which would replace the client's grant.
    expect(grants.grantServers).not.toHaveBeenCalled();
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
    // The rendered form must not carry the user id anywhere. The CSRF token
    // is random base64url and contains "u1" in about 1 run out of 100, so
    // leave it out of the search.
    const html: string = res.send.mock.calls[0][0];
    expect(html.replace(/name="csrf" value="[^"]*"/g, '')).not.toContain('u1');
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

// A server without connectors is not a choice: every invited member gets an
// empty default server, so any workspace with two people has several servers.
describe('servers without connectors are not a choice', () => {
  it('grants the whole workspace when no server has connectors (an invited member, an empty workspace)', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-admin', 'Default (Ada)', 0), server('srv-own', 'Default (Vera)', 0)]),
      ],
      ownServerId: 'srv-own',
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantWholeOrganization).toHaveBeenCalledWith('client-1', 'u1', 'org-A');
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    // No picker: none of its cookies either.
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('grants the one server with connectors when it is the user\'s own first server', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-own', 'Default (Ada)', 3), server('srv-member', 'Default (Vera)', 0)]),
      ],
      ownServerId: 'srv-own',
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.firstOwnServerId).toHaveBeenCalledWith('u1', 'org-A');
    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-own']);
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('adds the user\'s own first server when the one with connectors is another, so what they add later arrives', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-admin', 'Default (Ada)', 3), server('srv-own', 'Default (Vera)', 0)]),
      ],
      ownServerId: 'srv-own',
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-admin', 'srv-own']);
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('grants only the one with connectors to a member who owns no server', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-admin', 'Default (Ada)', 2), server('srv-other', 'Default (Bo)', 0)]),
      ],
      ownServerId: null,
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-admin']);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('grants a restricted member the whole workspace, whatever their own servers hold', async () => {
    // Member visibility lists only their own servers; with one of them they
    // already get the whole workspace, an empty second one changes nothing.
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-own', 'Default (Vera)', 1), server('srv-own-2', 'Drafts', 0)]),
      ],
      restricted: true,
      ownServerId: 'srv-own',
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.restrictedIn).toHaveBeenCalledWith('u1', 'org-A');
    expect(grants.grantWholeOrganization).toHaveBeenCalledWith('client-1', 'u1', 'org-A');
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  // What was chosen for this client before is not replaced without asking.
  it.each([
    ['one server has connectors', 3],
    ['no server has connectors', 0],
  ])('still asks when the client already has a grant (%s)', async (_label, count) => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-admin', 'Default (Ada)', count), server('srv-own', 'Default (Vera)', 0)]),
      ],
      ownServerId: 'srv-own',
      hasGrant: true,
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    expect(grants.hasActiveGrant).toHaveBeenCalledWith('client-1', 'u1');
    expect(res.send.mock.calls[0][0]).toContain('Default (Vera)');
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
  });

  it('still asks when no server has connectors but the workspace has some on no server', async () => {
    // Only "everything in this workspace" reaches those: the person's call.
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-admin', 'Default (Ada)', 0), server('srv-own', 'Default (Vera)', 0)]),
      ],
      ownServerId: 'srv-own',
      workspaceConnectors: 2,
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(grants.grantServers).not.toHaveBeenCalled();
  });

  it('still asks when two servers have connectors, and lists the empty one too', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'ERP', 2), server('srv-2', 'CRM', 1), server('srv-3', 'Drafts', 0)]),
      ],
      ownServerId: 'srv-1',
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    const html = res.send.mock.calls[0][0];
    expect(html).toContain('ERP');
    expect(html).toContain('CRM');
    expect(html).toContain('Drafts');
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
  });

  it('still asks a restricted member with two own servers that both have connectors', async () => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-own', 'Default (Vera)', 1), server('srv-own-2', 'Shop', 2)]),
      ],
      restricted: true,
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(grants.grantServers).not.toHaveBeenCalled();
  });

  // Several workspaces keep the picker: which workspace is a choice of its own.
  it.each([
    ['one server with connectors', 3, 0],
    ['no server with connectors', 0, 0],
  ])('still asks a user in several workspaces (%s)', async (_label, first, second) => {
    const { controller, grants, req, res } = build({
      targets: [
        workspace('org-A', 'Acme', [server('srv-1', 'Default', first)]),
        workspace('org-B', 'Globex', [server('srv-2', 'Default', second)]),
      ],
      ownServerId: 'srv-1',
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    const html = res.send.mock.calls[0][0];
    expect(html).toContain('Acme');
    expect(html).toContain('Globex');
    expect(grants.grantServers).not.toHaveBeenCalled();
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    expect(grants.firstOwnServerId).not.toHaveBeenCalled();
  });

  it('keeps the single-server grant for a workspace whose only server is empty', async () => {
    const { controller, grants, req, res } = build({
      targets: [workspace('org-A', 'Acme', [server('srv-1', 'Default', 0)])],
    });

    await expect(ask(controller, req, res)).resolves.toBe(false);

    expect(grants.grantServers).toHaveBeenCalledWith('client-1', 'u1', ['srv-1']);
    expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
  });
});

// The picker can run on a dashboard session already open in the browser
// (often an admin's): reproduced on a self-hosted instance, a Viewer at an
// admin's browser was shown every server of the workspace under the admin's
// name. The page now says whose choice it is, and in a workspace where member
// visibility narrows the user's view it does not promise "everything".
describe('what the picker tells the person choosing', () => {
  const twoWorkspaces = [
    workspace('org-A', 'Acme', [server('srv-own', 'Default (Rita)', 0)]),
    workspace('org-B', 'Lab', [server('srv-lab', 'Lab server', 1)]),
  ];

  it('names the signed-in account with a link to switch accounts', async () => {
    const { controller, req, res } = build({ targets: twoWorkspaces, email: 'rita@example.com' });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    const html = res.send.mock.calls[0][0];
    expect(html).toContain('Signed in as <strong>rita@example.com</strong>');
    expect(html).toContain('href="/auth/login?switch=1"');
    expect(html).toContain('Switch account');
  });

  it('escapes the account it names', async () => {
    const { controller, req, res } = build({ targets: twoWorkspaces, email: '<b>x</b>@example.com' });

    await ask(controller, req, res);

    const html = res.send.mock.calls[0][0];
    expect(html).not.toContain('<b>x</b>@example.com');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;@example.com');
  });

  it('shows no account line when the user cannot be read', async () => {
    const { controller, req, res } = build({ targets: twoWorkspaces });

    await ask(controller, req, res);

    expect(res.send.mock.calls[0][0]).not.toContain('class="acct"');
  });

  it('offers a restricted member the tools their role allows, not "everything in this workspace"', async () => {
    const { controller, grants, req, res } = build({
      targets: twoWorkspaces,
      email: 'rita@example.com',
      restrictedOrgs: ['org-A'],
    });

    await expect(ask(controller, req, res)).resolves.toBe(true);

    const html: string = res.send.mock.calls[0][0];
    const acme = html.slice(html.indexOf('<legend>Acme</legend>'), html.indexOf('<legend>Lab</legend>'));
    const lab = html.slice(html.indexOf('<legend>Lab</legend>'));
    expect(acme).toContain('The tools your role allows');
    expect(acme).not.toContain('Everything in this workspace');
    expect(acme).not.toContain('including connectors not on a server');
    // The whole-workspace grant itself is unchanged: roles cap it on every call.
    expect(acme).toContain('name="workspace" value="org-A"');
    // A workspace where they are not restricted keeps the option as it was.
    expect(lab).toContain('Everything in this workspace');
    expect(lab).not.toContain('The tools your role allows');
    expect(grants.restrictedIn).toHaveBeenCalledWith('u1', 'org-A');
    expect(grants.restrictedIn).toHaveBeenCalledWith('u1', 'org-B');
  });

  it('keeps "everything in this workspace" for an admin or in open mode', async () => {
    const { controller, req, res } = build({ targets: twoWorkspaces, restrictedOrgs: [] });

    await ask(controller, req, res);

    const html: string = res.send.mock.calls[0][0];
    expect(html.match(/class="pick-name">Everything in this workspace/g)).toHaveLength(2);
    expect(html).not.toContain('The tools your role allows');
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
      expect.stringContaining('error=chooseServer'),
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
      expect.stringContaining('error=noServersAvailable'),
    );
  });
});
