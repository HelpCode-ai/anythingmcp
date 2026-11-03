// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import type { Request, Response } from 'express';
import {
  FILE_SEARCH_SETUP_OPTIONS,
  LoginController,
  fileSearchWizardPathFor,
} from './login.controller';
import { MCP_APP_COOKIE } from './resource-indicator.middleware';

/**
 * The File Search plugin's step after "Approve" (/mcp/file-search): an admin
 * of a workspace without a folder is offered to connect one, hands off to the
 * dashboard wizard signed in on the granted workspace, and comes back to the
 * paused authorization. Every other client keeps the pages it had.
 */

interface FakeRes extends Response {
  _cookies: Record<string, { value: string; options: any }>;
  _cleared: string[];
  _sent?: string;
  _json?: any;
  _redirect?: string;
  _status: number;
}

function makeRes(): FakeRes {
  const res: any = {
    _cookies: {},
    _cleared: [],
    _status: 200,
    cookie(name: string, value: string, options: any) {
      this._cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string) {
      this._cleared.push(name);
      return this;
    },
    setHeader() {
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    send(payload: string) {
      this._sent = payload;
      return this;
    },
    json(payload: unknown) {
      this._json = payload;
      return this;
    },
    redirect(url: string) {
      this._redirect = url;
      return this;
    },
  };
  return res as FakeRes;
}

const LOGIN_USER = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b.com' })).toString('base64url');

function setup(opts: { cloud?: boolean; role?: string; sources?: Array<Record<string, unknown>>; grant?: any } = {}) {
  const store = {
    getOAuthSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      clientId: 'client-gpt',
      redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      expiresAt: Date.now() + 20 * 60_000,
    }),
    getClient: jest.fn().mockResolvedValue({ client_id: 'client-gpt', client_name: 'ChatGPT' }),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(({ select }: any) =>
        select?.organizationId ? { organizationId: 'org-1', email: 'a@b.com' } : { id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'h' },
      ),
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'h' }]),
    },
    organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: opts.role ?? 'ADMIN' }) },
    connector: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue(opts.sources ?? []),
    },
  };
  const grants = {
    grantServers: jest.fn().mockResolvedValue([]),
    grantWholeOrganization: jest.fn().mockResolvedValue(true),
    listSelectableTargets: jest.fn().mockResolvedValue([]),
    resolve: jest.fn().mockResolvedValue(opts.grant ?? null),
  };
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const recent = {
    user: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' }),
    session: jest.fn().mockResolvedValue({ accessToken: 'jwt', user: { id: 'u1', organizationId: 'org-1' } }),
  };
  const authService = { comparePassword: jest.fn().mockResolvedValue(true), verifyToken: jest.fn(() => { throw new Error('x'); }) };
  const config = {
    get: jest.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://cloud.example/' : undefined)),
  };
  const cloud = opts.cloud ?? true;
  const controller = new LoginController(
    authService as any,
    prisma as any,
    config as any,
    store as any,
    { startMcp: jest.fn() } as any,
    { mode: cloud ? 'cloud' : 'self-hosted', isCloud: () => cloud, isSelfHosted: () => !cloud } as any,
    grants as any,
    productEvents as any,
    { getTrialState: jest.fn().mockResolvedValue(null) } as any,
    { hadSubscription: jest.fn().mockResolvedValue(false) } as any,
    undefined,
    undefined,
    recent as any,
  );
  const req = (extra: Record<string, unknown> = {}, signed: Record<string, string> = {}) =>
    ({
      headers: { host: 'mcp.test' },
      cookies: { oauth_session: 's1' },
      signedCookies: { login_csrf: 'tok', ...signed },
      secure: false,
      ...extra,
    }) as unknown as Request;
  const login = async (signed: Record<string, string> = {}) => {
    const res = makeRes();
    await controller.handleLogin(req({}, signed), { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' } as any, res);
    return res;
  };
  return { controller, prisma, recent, productEvents, login, req };
}

const FILE_SEARCH = { [MCP_APP_COOKIE]: 'file-search' };

describe('LoginController: File Search plugin setup after Approve', () => {
  it('offers an admin with no folder every way to connect one', async () => {
    const { login, productEvents } = setup();
    const res = await login(FILE_SEARCH);
    expect(res._redirect).toBeUndefined();
    const page = res._sent as string;
    expect(page).toContain('Connect a folder for ChatGPT');
    for (const label of ['SFTP', 'FTPS', 'FTP', 'WebDAV', 'Nextcloud', 'ownCloud', 'Synology NAS', 'QNAP NAS', 'FRITZ!Box', 'Hetzner Storage Box', 'S3-compatible storage']) {
      expect(page).toContain(`<span class="fs-option-label">${label === 'FRITZ!Box' ? 'FRITZ!Box' : label}</span>`);
    }
    // A mounted network folder only exists on a self-hosted instance.
    expect(page).not.toContain('Network folder');
    // Each choice goes to the dashboard hand-off with the page's CSRF token.
    const csrf = res._cookies['file_search_setup_csrf'].value;
    expect(res._cookies['file_search_setup_csrf'].options).toEqual(expect.objectContaining({ httpOnly: true, signed: true }));
    expect(page).toContain(`href="https://cloud.example/setup/file-search?option=sftp&amp;t=${csrf}"`);
    // Skipping goes straight back through the authorization.
    expect(page).toContain('href="http://mcp.test/callback"');
    // The pause keeps the authorization alive for the wizard.
    expect(res._cookies['login_user'].options.maxAge).toBeGreaterThan(19 * 60 * 1000);
    expect(productEvents.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'file_search_authorize_offered' }));
    // Never the Claude directory's app picker.
    expect(page).not.toContain('quick-apps');
  });

  it('offers the network folder on a self-hosted instance', async () => {
    const { login } = setup({ cloud: false });
    const res = await login(FILE_SEARCH);
    expect(res._sent).toContain('Network folder');
  });

  it.each([
    ['a non-admin', { role: 'EDITOR' }],
    ['a workspace that already has a folder', { sources: [{ config: { fileSearch: { protocol: 'sftp' } } }] }],
  ])('goes straight back to the client for %s', async (_label, opts) => {
    const { login } = setup(opts as any);
    const res = await login(FILE_SEARCH);
    expect(res._redirect).toBe('http://mcp.test/callback');
    expect(res._sent).toBeUndefined();
  });

  it('does not count the File Share connector as a folder', async () => {
    const { login } = setup({ sources: [{ config: { fileShare: true } }] });
    const res = await login(FILE_SEARCH);
    expect(res._sent).toContain('Connect a folder for ChatGPT');
  });

  it('keeps the first-connector page for every other client', async () => {
    const { login } = setup();
    const res = await login();
    expect(res._sent).toContain('ChatGPT is connected');
    expect(res._sent).not.toContain('Connect a folder');
  });

  describe('POST /auth/file-search/session', () => {
    const handoff = async (
      s: ReturnType<typeof setup>,
      body: Record<string, unknown>,
      opts: { header?: boolean; signed?: Record<string, string> } = {},
    ) => {
      const res = makeRes();
      await s.controller.fileSearchSetupSession(
        s.req(
          { headers: { host: 'mcp.test', ...(opts.header === false ? {} : { 'x-amcp-dashboard': '1' }) } },
          { file_search_setup_csrf: 'csrf-1', login_user: LOGIN_USER, ...FILE_SEARCH, ...(opts.signed ?? {}) },
        ),
        body,
        res,
      );
      return res;
    };

    it('opens a dashboard session on the granted workspace and the wizard for the option', async () => {
      const s = setup({ grant: { mode: 'servers', servers: [{ id: 'cmsrv000000000000000000001', organizationId: 'org-2' }] } });
      const res = await handoff(s, { csrf: 'csrf-1', option: 'synology' });
      expect(res._status).toBe(200);
      expect(res._json.redirect).toBe(
        '/connectors/new/file-search?protocol=sftp&preset=synology&from=authorize&return=authorize&servers=cmsrv000000000000000000001',
      );
      expect(s.recent.session).toHaveBeenCalledWith('u1', 'org-2');
    });

    it.each([
      ['without the dashboard header', { csrf: 'csrf-1', option: 'sftp' }, { header: false }],
      ['with a wrong CSRF token', { csrf: 'other', option: 'sftp' }, {}],
      ['without a pending authorization', { csrf: 'csrf-1', option: 'sftp' }, { signed: { login_user: '' } }],
      ['for another plugin', { csrf: 'csrf-1', option: 'sftp' }, { signed: { [MCP_APP_COOKIE]: '' } }],
    ])('refuses a hand-off %s', async (_label, body, opts) => {
      const s = setup();
      const res = await handoff(s, body, opts as any);
      expect(res._status).toBe(403);
      expect(s.recent.session).not.toHaveBeenCalled();
    });

    it('refuses when the recent sign-in is another user', async () => {
      const s = setup();
      s.recent.user.mockResolvedValue({ id: 'u2', email: 'x@y.z', name: null });
      const res = await handoff(s, { csrf: 'csrf-1', option: 'sftp' });
      expect(res._status).toBe(403);
      expect(s.recent.session).not.toHaveBeenCalled();
    });

    it('refuses a non-admin, an unknown option and the network folder on the Cloud', async () => {
      expect((await handoff(setup({ role: 'EDITOR' }), { csrf: 'csrf-1', option: 'sftp' }))._status).toBe(403);
      expect((await handoff(setup(), { csrf: 'csrf-1', option: 'https://evil.example' }))._status).toBe(400);
      expect((await handoff(setup(), { csrf: 'csrf-1', option: 'local' }))._status).toBe(400);
      expect((await handoff(setup({ cloud: false }), { csrf: 'csrf-1', option: 'local' }))._status).toBe(200);
    });
  });

  describe('GET /auth/file-search/continue', () => {
    it('finishes a pending authorization', async () => {
      const s = setup();
      const res = makeRes();
      await s.controller.fileSearchSetupContinue(s.req({}, { login_user: LOGIN_USER }), res);
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('explains how to go on when the authorization has expired', async () => {
      const s = setup();
      const res = makeRes();
      await s.controller.fileSearchSetupContinue(s.req({}, {}), res);
      expect(res._redirect).toBeUndefined();
      expect(res._sent).toContain('Your folder is connected');
      expect(res._sent).toContain('connect the plugin again');
    });
  });

  it('builds wizard paths only from the fixed options', () => {
    expect(fileSearchWizardPathFor('nope', [])).toBeNull();
    expect(fileSearchWizardPathFor('s3', ['bad id!'])).toBe('/connectors/new/file-search?protocol=s3&from=authorize&return=authorize');
    expect(FILE_SEARCH_SETUP_OPTIONS.map((o) => o.protocol)).toEqual(
      expect.arrayContaining(['sftp', 'ftps', 'ftp', 'webdav', 's3', 'local']),
    );
  });
});
