// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { autoContinueScript, continueBeaconScript, LoginController } from './login.controller';
import { attemptKey } from './authorization-attempt';
import { ProductEventService } from '../audit/product-event.service';
import { TELEGRAM_ONE_TAP } from '../adapters/telegram-managed-bot';
import type { Request, Response } from 'express';

/**
 * The measurement of the authorization pages and the split test of the page
 * shown to an empty workspace (authorization-attempt.ts): which events a
 * sign-in attempt leaves behind, what the page's beacon may write, and what
 * the 'next_step' arm shows and does.
 */

function makeRes() {
  const res: any = {
    _cookies: {} as Record<string, { value: string; options: any }>,
    _status: 200,
    _ended: false,
    cookie(name: string, value: string, options: any) {
      this._cookies[name] = { value, options };
      return this;
    },
    clearCookie() {
      return this;
    },
    setHeader() {
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    end() {
      this._ended = true;
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
  return res as Response & Record<string, any>;
}

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };
const EXPIRES = Date.now() + 20 * 60_000;
const ATTEMPT = attemptKey(EXPIRES) as string;
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const LOGIN_USER = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b.com' })).toString('base64url');
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function build(
  opts: {
    deployment?: object;
    /** `AUTHORIZE_CONNECTED_PAGE_TEST`. */
    setting?: string;
    /** `AUTHORIZE_SIGNIN_PAGE_TEST`; 'off' unless a test sets it. */
    signin?: string;
    session?: boolean;
    createdAt?: Date;
    telegram?: boolean;
  } = {},
) {
  // The real event store, so every field these pages write passes its allow-list.
  const create = jest.fn().mockResolvedValue({});
  const productEvents = new ProductEventService({ productEvent: { create } } as any);
  const events = () => create.mock.calls.map(([{ data }]) => data);
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ select }: any) =>
        select?.createdAt
          ? { createdAt: opts.createdAt ?? new Date(Date.now() - 60_000), organizationId: 'org-1' }
          : select?.organizationId
            ? { organizationId: 'org-1', email: 'a@b.com' }
            : { id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'hash', emailVerified: true },
      ),
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'hash', emailVerified: true }]),
    },
    organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
    connector: { count: jest.fn().mockResolvedValue(0) },
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'FRONTEND_URL'
        ? 'https://cloud.example'
        : key === 'AUTHORIZE_CONNECTED_PAGE_TEST'
          ? opts.setting
          : key === 'AUTHORIZE_SIGNIN_PAGE_TEST'
            ? (opts.signin ?? 'off')
            : undefined,
    ),
  };
  const store = {
    getOAuthSession: jest.fn(async (id: string) =>
      opts.session !== false && id === 's1'
        ? { sessionId: 's1', state: 'x', clientId: 'c1', redirectUri: 'https://claude.ai/api/mcp/auth_callback', expiresAt: EXPIRES }
        : undefined,
    ),
    getClient: jest.fn(async () => ({ client_id: 'c1', client_name: 'Claude' })),
  };
  const social = {
    enabledProviders: jest.fn(() => [{ id: 'google', name: 'Google' }]),
    start: jest.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/auth?x', bindingToken: 'bind' })),
    complete: jest.fn(async () => ({ kind: 'MCP', provider: 'google', user: { id: 'u1', email: 'a@b.com', name: 'A' } })),
    logFailure: jest.fn(async () => undefined),
  };
  const provider = { canSetUp: jest.fn().mockResolvedValue(true), install: jest.fn(), find: jest.fn(), status: jest.fn() };
  const telegram = { isEnabledFor: jest.fn().mockReturnValue(true) };
  const controller = new LoginController(
    { comparePassword: jest.fn().mockResolvedValue(true), verifyToken: jest.fn(() => ({ sub: 'u1', tokenVersion: 0 })) } as any,
    prisma as any,
    config as any,
    store as any,
    { startMcp: jest.fn(async () => ({ authorizationUrl: 'https://idp.example/auth' })) } as any,
    (opts.deployment ?? CLOUD) as any,
    {
      grantServers: jest.fn().mockResolvedValue([]),
      grantWholeOrganization: jest.fn().mockResolvedValue(true),
      listSelectableTargets: jest.fn().mockResolvedValue([]),
      resolve: jest.fn().mockResolvedValue(null),
      keepVisible: jest.fn(async (_u: string, servers: unknown[]) => servers),
      restrictedIn: jest.fn().mockResolvedValue(false),
    } as any,
    productEvents,
    { getTrialState: jest.fn().mockResolvedValue(null) } as any,
    { hadSubscription: jest.fn().mockResolvedValue(false) } as any,
    social as any,
    {
      get: (token: unknown) =>
        token === TELEGRAM_ONE_TAP ? (opts.telegram ? telegram : null) : { get: () => provider },
    } as any,
  );
  return { controller, events, create, config };
}

const req = (overrides: Record<string, unknown> = {}, userAgent = MAC): Request =>
  ({
    headers: { host: 'mcp.test', 'user-agent': userAgent },
    cookies: { oauth_session: 's1' },
    signedCookies: { login_csrf: 'tok' },
    secure: false,
    originalUrl: '/auth/social/google/callback?code=c&state=s',
    ...overrides,
  }) as unknown as Request;

const post = async (controller: LoginController, body: Record<string, string>, request: Request = req()) => {
  const res = makeRes();
  await controller.handleLogin(request, { email: '', password: '', csrf: 'tok', ...body } as any, res);
  await flush();
  return res;
};

describe('LoginController: what a sign-in attempt leaves behind', () => {
  it('says in which language the browser asked for the sign-in page', async () => {
    const { controller, events } = build({ setting: 'control' });
    await controller.showLoginPage(
      undefined as any,
      undefined as any,
      req({ headers: { host: 'mcp.test', 'user-agent': IPHONE, 'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8' } }),
      makeRes(),
    );
    await flush();
    expect(events()).toEqual([
      {
        event: 'authorize_page_viewed',
        userId: null,
        organizationId: null,
        metadata: { client: 'Claude', device: 'mobile', attempt: ATTEMPT, lang: 'ja', connectedArm: 'control' },
      },
    ]);
  });

  it.each([
    ['Continue with Google', { action: 'social:google' }, 'google'],
    ['the organization sign-in', { action: 'sso:idp-1' }, 'sso'],
    ['Cancel', { action: 'deny' }, 'cancel'],
    ['e-mail and password', { action: 'approve', email: 'a@b.com', password: 'pw' }, 'password'],
    ['Allow access as the signed-in account', { action: 'approve-session' }, 'session'],
  ])('records %s as the button that was used', async (_label, body, button) => {
    const { controller, events } = build({ setting: 'control' });
    await post(controller, body);
    const actions = events().filter((e) => e.event === 'authorize_action');
    expect(actions).toHaveLength(1);
    expect(actions[0].metadata).toEqual({ client: 'Claude', device: 'desktop', attempt: ATTEMPT, connectedArm: 'control', button });
    // The button is not a person: no account on this event.
    expect(actions[0].userId).toBeNull();
  });

  it('records no button for a post that fails the CSRF check, or outside an authorization', async () => {
    const forged = build();
    await post(forged.controller, { action: 'social:google', csrf: 'other' });
    expect(forged.events()).toEqual([]);

    const outside = build({ session: false });
    await post(outside.controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
    expect(outside.events().map((e) => e.event)).not.toContain('authorize_action');
    expect(outside.events().map((e) => e.event)).not.toContain('authorization_signed_in');
  });

  it('records who signed in, how, and whether the account is new', async () => {
    const fresh = build({ setting: 'control', createdAt: new Date(Date.now() - 2 * 60_000) });
    await post(fresh.controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
    const signedIn = fresh.events().filter((e) => e.event === 'authorization_signed_in');
    expect(signedIn).toEqual([
      {
        event: 'authorization_signed_in',
        userId: 'u1',
        organizationId: 'org-1',
        metadata: { client: 'Claude', device: 'desktop', attempt: ATTEMPT, connectedArm: 'control', method: 'password', account: 'new' },
      },
    ]);

    const old = build({ setting: 'control', createdAt: new Date(Date.now() - 40 * 24 * 3600_000) });
    await post(old.controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
    expect(old.events().find((e) => e.event === 'authorization_signed_in').metadata).toEqual(
      expect.objectContaining({ method: 'password', account: 'existing' }),
    );
  });

  it('names the provider when the person came back from Google', async () => {
    const { controller, events } = build({ setting: 'control' });
    const res = makeRes();
    await controller.socialCallback('google', req(), res);
    await flush();
    expect(events().find((e) => e.event === 'authorization_signed_in').metadata).toEqual(
      expect.objectContaining({ method: 'google', attempt: ATTEMPT }),
    );
  });

  it('never makes the form post wait for, or fail on, a statistic', async () => {
    const { controller, create } = build({ setting: 'control' });
    create.mockRejectedValue(new Error('db down'));
    const res = await post(controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
    // The empty workspace page is still shown.
    expect(res._sent).toContain('Continue to Claude');
  });

  it('carries the attempt and the arm on the page shown to an empty workspace', async () => {
    const { controller, events } = build({ setting: 'next_step' });
    await post(controller, { action: 'approve', email: 'a@b.com', password: 'pw' }, req({}, IPHONE));
    expect(events().find((e) => e.event === 'empty_workspace_prompt')).toEqual({
      event: 'empty_workspace_prompt',
      userId: 'u1',
      organizationId: 'org-1',
      metadata: { client: 'Claude', device: 'mobile', attempt: ATTEMPT, connectedArm: 'next_step' },
    });
  });

  it('names no arm where the test does not run', async () => {
    for (const opts of [{ setting: 'off' }, { deployment: SELF_HOSTED, setting: 'next_step' }]) {
      const { controller, events } = build(opts);
      await post(controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
      expect(events().length).toBeGreaterThan(0);
      for (const e of events()) expect(e.metadata).not.toHaveProperty('connectedArm');
    }
  });
});

describe('POST /auth/beacon', () => {
  const beacon = async (
    controller: LoginController,
    body: Record<string, unknown>,
    request: Request = req({ signedCookies: { login_user: LOGIN_USER } }),
  ) => {
    const res = makeRes();
    await controller.pageBeacon(request, body as any, res);
    await flush();
    return res;
  };

  it.each(['continue', 'auto_continue', 'copy_continue'])('records %s on the page shown to an empty workspace', async (kind) => {
    const { controller, events } = build({ setting: 'next_step' });
    const res = await beacon(controller, { e: kind, a: ATTEMPT });
    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
    expect(events()).toEqual([
      {
        event: 'post_approve_continue_clicked',
        userId: 'u1',
        organizationId: 'org-1',
        metadata: { client: 'Claude', device: 'desktop', attempt: ATTEMPT, connectedArm: 'next_step', button: kind },
      },
    ]);
  });

  it('records "Create an account" on the sign-in page, where nobody is signed in yet', async () => {
    const { controller, events } = build({ setting: 'control' });
    await beacon(controller, { e: 'create_account', a: ATTEMPT }, req({ signedCookies: {} }, IPHONE));
    expect(events()).toEqual([
      {
        event: 'authorize_action',
        userId: null,
        organizationId: null,
        metadata: { client: 'Claude', device: 'mobile', attempt: ATTEMPT, connectedArm: 'control', button: 'create_account' },
      },
    ]);
  });

  it('counts only inside the authorization it names, and always answers 204', async () => {
    const { controller, events } = build();
    for (const body of [
      { e: 'continue', a: 'abcdef12' }, // another attempt: a page of another site cannot know the value
      { e: 'continue' },
      { e: 'continue', a: ['x'] },
      { e: 'delete_everything', a: ATTEMPT },
      {},
      undefined as any,
    ]) {
      const res = await beacon(controller, body);
      expect(res._status).toBe(204);
    }
    // Continue without the signed login cookie of the paused authorization: nothing.
    await beacon(controller, { e: 'continue', a: ATTEMPT }, req({ signedCookies: {} }));
    // No pending authorization at all.
    await beacon(controller, { e: 'continue', a: ATTEMPT }, req({ cookies: {}, signedCookies: { login_user: LOGIN_USER } }));
    expect(events()).toEqual([]);
  });

  it('writes nothing on a self-hosted instance', async () => {
    const { controller, events } = build({ deployment: SELF_HOSTED });
    const res = await beacon(controller, { e: 'continue', a: ATTEMPT });
    expect(res._status).toBe(204);
    expect(events()).toEqual([]);
  });

  it('answers 204 when the event cannot be written', async () => {
    const { controller, create } = build();
    create.mockRejectedValue(new Error('db down'));
    const res = await beacon(controller, { e: 'continue', a: ATTEMPT });
    expect(res._status).toBe(204);
  });
});

describe('the page shown to an empty workspace, as a split test', () => {
  const page = async (opts: Parameters<typeof build>[0], userAgent = MAC) => {
    const { controller } = build(opts);
    const res = await post(controller, { action: 'approve', email: 'a@b.com', password: 'pw' }, req({}, userAgent));
    return res._sent as string;
  };
  const scriptOf = (html: string) => html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

  it('is the page as before on the control arm, when the test is off, and on a self-hosted instance', async () => {
    for (const opts of [{ setting: 'control' }, { setting: 'off' }]) {
      const html = await page(opts);
      expect(html).toContain('<h1>Claude is connected</h1>');
      expect(html).toContain('<button type="button" class="copy" id="copy-request">Copy</button>');
      expect(html).toContain('<title>Claude is connected</title>');
      expect(html).toContain('Your workspace has no apps yet, so Claude has nothing to work with.');
      expect(html).not.toContain('One more step');
      expect(html).not.toContain('auto-continue');
      expect(html).toContain('<a class="button" id="continue" href="http://mcp.test/callback" data-client="Claude">Continue to Claude</a>');
    }
  });

  it('says what is still to do on the next_step arm, with Continue as the one primary button', async () => {
    const html = await page({ setting: 'next_step' });
    // No visible heading: it stays for screen readers and the tab title.
    expect(html).toContain('<h1 class="vh">One more step: go back to Claude</h1>');
    expect(html).toContain('h1.vh { position: absolute; width: 1px; height: 1px;');
    expect(html).toContain('<title>One more step: go back to Claude</title>');
    expect(html).not.toContain('Claude is connected</h1>');
    expect(html).toContain('<p class="sub" id="first-sub">Press <strong>Continue to Claude</strong> to finish connecting.</p>');
    expect(html).not.toContain('You are signed in');
    // On a phone Continue follows that sentence; the example request comes after it.
    expect(html).toContain('<div class="flow next">');
    // On a phone: the picker, the request to copy, then Continue.
    expect(html).toContain('.flow.next > .quick { order: 1; margin-bottom: 12px; }');
    expect(html).toContain('.flow.next > .example { order: 3; margin-bottom: 12px; padding: 10px 12px; }');
    expect(html).toContain('.flow.next > #continue { order: 6; }');
    // The copy button also goes on.
    expect(html).toContain('<button type="button" class="copy" id="copy-request" data-continue="1">Copy &amp; continue</button>');
    expect(html).toContain('id="first-sub2">Your workspace has no apps yet: you can add them right in the chat. For example, ask:</p>');
    // The same link, the same picker, and nothing else that looks like the way on.
    expect(html).toContain('<a class="button" id="continue" href="http://mcp.test/callback" data-client="Claude">Continue to Claude</a>');
    expect(html.match(/class="button"/g)).toHaveLength(1);
    expect(html).toContain('id="quick-apps"');
    expect(html.indexOf('<h1 class="vh">')).toBeLessThan(html.indexOf('id="continue"'));
  });

  it('escapes the client name in the new heading', async () => {
    const { controller, config } = build({ setting: 'next_step' });
    void config;
    (controller as any).oauthStore.getClient = jest.fn(async () => ({ client_id: 'c1', client_name: '<img src=x>' }));
    const res = await post(controller, { action: 'approve', email: 'a@b.com', password: 'pw' });
    expect(res._sent).toContain('<h1 class="vh">One more step: go back to &lt;img src=x&gt;</h1>');
    expect(res._sent).not.toContain('<img src=x>');
  });

  it('goes on by itself only on the next_step arm, and only where the one-tap Telegram bot exists', async () => {
    const withBot = await page({ setting: 'next_step', telegram: true });
    expect(withBot).toContain('id="auto-continue" role="status" aria-live="polite" hidden');
    expect(withBot).toContain('id="auto-continue-stay">Stay on this page</button>');
    expect(withBot.indexOf('id="auto-continue"')).toBeLessThan(withBot.indexOf('id="continue"'));
    expect(scriptOf(withBot)).toContain('window.location.assign(target)');

    for (const html of [await page({ setting: 'next_step' }), await page({ setting: 'control', telegram: true })]) {
      expect(html).not.toContain('auto-continue');
      expect(scriptOf(html)).not.toContain('location.assign');
    }
  });

  it('reports the click on Continue on both arms, with the attempt of this authorization', async () => {
    for (const setting of ['control', 'next_step']) {
      const script = scriptOf(await page({ setting }));
      expect(script).toContain(`navigator.sendBeacon('/auth/beacon', new URLSearchParams({ e: via, a: '${ATTEMPT}' }))`);
    }
    // Nothing on the page opens a window, whatever the arm.
    for (const html of [await page({ setting: 'control', telegram: true }), await page({ setting: 'next_step', telegram: true })]) {
      expect(scriptOf(html)).not.toContain('window.open');
      expect(html).not.toContain('target="_self"');
    }
  });

  describe('the copy button', () => {
    // Runs the page's first script block parts that concern the copy button.
    const run = async (opts: { setting: string; clipboard: 'ok' | 'refused' | 'silent' }) => {
      const html = await page({ setting: opts.setting });
      const script = scriptOf(html);
      const clicks: string[] = [];
      const attrs: Record<string, string> = {};
      const listeners: Record<string, Array<() => void>> = { copy: [], cont: [] };
      const button: any = {
        hidden: false,
        textContent: '',
        getAttribute: (n: string) => (n === 'data-continue' && html.includes('id="copy-request" data-continue="1"') ? '1' : null),
        addEventListener: (_t: string, f: () => void) => listeners.copy.push(f),
      };
      const cont: any = {
        getAttribute: (n: string) => attrs[n] ?? (n === 'href' ? 'http://mcp.test/callback' : n === 'data-client' ? 'Claude' : null),
        setAttribute: (n: string, v: string) => (attrs[n] = v),
        addEventListener: (_t: string, f: () => void) => listeners.cont.push(f),
        click: () => clicks.push(attrs['data-via'] ?? 'plain'),
      };
      const timers: Array<() => void> = [];
      const writeText = jest.fn(() =>
        opts.clipboard === 'ok' ? Promise.resolve() : opts.clipboard === 'refused' ? Promise.reject(new Error('denied')) : new Promise<void>(() => undefined),
      );
      const elements: Record<string, unknown> = {
        'copy-request': button,
        'example-request': { textContent: 'Connect my Telegram bot to AnythingMCP.' },
        continue: cont,
      };
      require('vm').runInNewContext(script, {
        document: { getElementById: (id: string) => elements[id] ?? null, querySelectorAll: () => [] },
        navigator: { clipboard: { writeText } },
        window: { setTimeout: (f: () => void) => timers.push(f), URLSearchParams },
        URLSearchParams,
      });
      listeners.copy[0]();
      await flush();
      return { clicks, timers, writeText, button };
    };

    it('copies the request and presses Continue once on the next_step page', async () => {
      const { clicks, timers, writeText, button } = await run({ setting: 'next_step', clipboard: 'ok' });
      expect(writeText).toHaveBeenCalledWith('Connect my Telegram bot to AnythingMCP.');
      expect(button.textContent).toBe('Copied');
      expect(clicks).toEqual(['copy']);
      // The safety timer finds it already gone: /callback is never asked for twice.
      timers.forEach((t) => t());
      expect(clicks).toEqual(['copy']);
    });

    it('goes on when the clipboard refuses, and when it never answers', async () => {
      const refused = await run({ setting: 'next_step', clipboard: 'refused' });
      expect(refused.clicks).toEqual(['copy']);
      const silent = await run({ setting: 'next_step', clipboard: 'silent' });
      expect(silent.clicks).toEqual([]);
      silent.timers.forEach((t) => t());
      expect(silent.clicks).toEqual(['copy']);
    });

    it('only copies on the control page', async () => {
      const { clicks, timers, button } = await run({ setting: 'control', clipboard: 'ok' });
      expect(button.textContent).toBe('Copied');
      timers.forEach((t) => t());
      expect(clicks).toEqual([]);
    });
  });

  describe('the beacon on Continue', () => {
    const via: { current: string | null } = { current: null };
    afterEach(() => {
      via.current = null;
    });
    const run = (navigator: object, withUrlSearchParams = true) => {
      const listeners: Array<(e: unknown) => unknown> = [];
      const cont = {
        addEventListener: (_t: string, f: (e: unknown) => unknown) => listeners.push(f),
        getAttribute: (name: string) => (name === 'data-via' ? via.current : null),
      };
      require('vm').runInNewContext(continueBeaconScript(ATTEMPT), {
        document: { getElementById: (id: string) => (id === 'continue' ? cont : null) },
        navigator,
        window: withUrlSearchParams ? { URLSearchParams } : {},
        URLSearchParams,
      });
      return listeners;
    };
    const tap = () => ({ preventDefault: jest.fn(), stopPropagation: jest.fn(), stopImmediatePropagation: jest.fn(), returnValue: true });

    it('queues one request and returns at once, without touching the click', () => {
      const sendBeacon = jest.fn(() => true);
      const [listener] = run({ sendBeacon });
      const event = tap();
      expect(listener(event)).toBeUndefined();
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, body] = sendBeacon.mock.calls[0] as unknown as [string, URLSearchParams];
      expect(url).toBe('/auth/beacon');
      expect(body.toString()).toBe(`e=continue&a=${ATTEMPT}`);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(event.returnValue).toBe(true);
    });

    it('says so when "Copy & continue" pressed Continue', () => {
      const sendBeacon = jest.fn(() => true);
      const [listener] = run({ sendBeacon });
      via.current = 'copy';
      listener(tap());
      const [, body] = sendBeacon.mock.calls[0] as unknown as [string, URLSearchParams];
      expect(body.toString()).toBe(`e=copy_continue&a=${ATTEMPT}`);
    });

    it('changes nothing when the browser refuses or throws', () => {
      for (const sendBeacon of [jest.fn(() => false), jest.fn(() => { throw new Error('SecurityError'); })]) {
        const [listener] = run({ sendBeacon });
        const event = tap();
        expect(() => listener(event)).not.toThrow();
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    });

    it('adds nothing to Continue in a browser without beacons', () => {
      expect(run({})).toEqual([]);
      expect(run({ sendBeacon: jest.fn() }, false)).toEqual([]);
    });

    it('is written so that it cannot stop, delay or redirect the click', () => {
      const script = continueBeaconScript(ATTEMPT);
      for (const forbidden of ['preventDefault', 'stopPropagation', 'window.open', 'location', 'await', 'return false', 'setTimeout', '.click(', 'href', 'setAttribute', 'fetch(']) {
        expect(script).not.toContain(forbidden);
      }
    });
  });

  describe('going on by itself after the one-tap Telegram bot', () => {
    const run = (opts: { sendBeacon?: jest.Mock } = {}) => {
      const node = (attrs: Record<string, string> = {}) => ({
        attrs,
        hidden: true,
        textContent: '',
        listeners: [] as Array<() => void>,
        getAttribute(n: string) {
          return n in this.attrs ? this.attrs[n] : null;
        },
        addEventListener(_t: string, f: () => void) {
          this.listeners.push(f);
        },
      });
      const nodes: Record<string, ReturnType<typeof node>> = {
        'quick-apps': node(),
        continue: node({ href: 'http://mcp.test/callback', 'data-client': 'Claude' }),
        'auto-continue': node(),
        'auto-continue-text': node(),
        'auto-continue-stay': node(),
      };
      nodes['auto-continue-stay'].hidden = false;
      let tick: (() => void) | null = null;
      const assign = jest.fn();
      const clearInterval = jest.fn(() => {
        tick = null;
      });
      const document = { visibilityState: 'visible', getElementById: (id: string) => nodes[id] ?? null };
      const sendBeacon = opts.sendBeacon ?? jest.fn(() => true);
      const window = {
        setInterval: (f: () => void, ms: number) => {
          expect(ms).toBe(1000);
          tick = f;
          return 1;
        },
        clearInterval,
        location: { assign },
        URLSearchParams,
        open: jest.fn(),
      };
      require('vm').runInNewContext(autoContinueScript(ATTEMPT), { document, navigator: { sendBeacon }, window, URLSearchParams });
      const seconds = (n: number) => {
        for (let i = 0; i < n; i++) tick?.();
      };
      return { nodes, document, window, assign, sendBeacon, seconds, connected: () => (nodes['quick-apps'].attrs['data-telegram'] = 'done') };
    };

    it('does nothing until the bot is connected', () => {
      const t = run();
      t.seconds(120);
      expect(t.assign).not.toHaveBeenCalled();
      expect(t.nodes['auto-continue'].hidden).toBe(true);
      // Connected, but Start not pressed yet in the bot's chat: still the person's turn.
      t.nodes['quick-apps'].attrs['data-telegram'] = 'start';
      t.seconds(30);
      expect(t.assign).not.toHaveBeenCalled();
    });

    it('counts down five seconds where the person can see it, then follows the link in this tab', () => {
      const t = run();
      t.connected();
      t.seconds(1);
      expect(t.nodes['auto-continue'].hidden).toBe(false);
      expect(t.nodes['auto-continue-text'].textContent).toBe('Telegram is connected. Going back to Claude in 5 s…');
      t.seconds(4);
      expect(t.nodes['auto-continue-text'].textContent).toBe('Telegram is connected. Going back to Claude in 1 s…');
      expect(t.assign).not.toHaveBeenCalled();
      t.seconds(1);
      // The same address as the Continue link, once, and nothing opened.
      expect(t.assign).toHaveBeenCalledTimes(1);
      expect(t.assign).toHaveBeenCalledWith('http://mcp.test/callback');
      expect(t.window.open).not.toHaveBeenCalled();
      expect(t.sendBeacon).toHaveBeenCalledTimes(1);
      expect((t.sendBeacon.mock.calls[0][1] as URLSearchParams).toString()).toBe(`e=auto_continue&a=${ATTEMPT}`);
      t.seconds(10);
      expect(t.assign).toHaveBeenCalledTimes(1);
    });

    it('waits while the tab is in the background', () => {
      const t = run();
      t.connected();
      t.document.visibilityState = 'hidden';
      t.seconds(60);
      expect(t.assign).not.toHaveBeenCalled();
      expect(t.nodes['auto-continue'].hidden).toBe(true);
      t.document.visibilityState = 'visible';
      t.seconds(6);
      expect(t.assign).toHaveBeenCalledTimes(1);
    });

    it('stops for good on "Stay on this page"', () => {
      const t = run();
      t.connected();
      t.seconds(2);
      t.nodes['auto-continue-stay'].listeners[0]();
      expect(t.nodes['auto-continue-text'].textContent).toBe('Press Continue to Claude when you are ready.');
      expect(t.nodes['auto-continue-stay'].hidden).toBe(true);
      t.seconds(30);
      expect(t.assign).not.toHaveBeenCalled();
      expect(t.sendBeacon).not.toHaveBeenCalled();
    });

    it('stops when the person presses Continue, so the callback is never asked for twice', () => {
      const t = run();
      t.connected();
      t.seconds(3);
      t.nodes.continue.listeners[0]();
      t.seconds(30);
      expect(t.assign).not.toHaveBeenCalled();
    });

    it('still goes on when the beacon cannot be sent', () => {
      const t = run({ sendBeacon: jest.fn(() => { throw new Error('SecurityError'); }) });
      t.connected();
      t.seconds(6);
      expect(t.assign).toHaveBeenCalledWith('http://mcp.test/callback');
    });

    it('never prevents, opens or clicks anything', () => {
      const script = autoContinueScript(ATTEMPT);
      for (const forbidden of ['preventDefault', 'stopPropagation', 'window.open', '.click(', 'target=', 'fetch(']) {
        expect(script).not.toContain(forbidden);
      }
      // One way on, and it is the link's own address.
      expect(script.match(/location\.assign\(/g)).toHaveLength(1);
      expect(script).toContain("var target = cont.getAttribute('href');");
    });
  });
});

describe('the sign-in page on a phone', () => {
  const signInPage = async () => {
    const { controller } = build({ setting: 'next_step' });
    const res = makeRes();
    await controller.showLoginPage(undefined as any, undefined as any, req({ headers: { host: 'mcp.test', 'user-agent': IPHONE } }), res);
    return res._sent as string;
  };

  it('keeps the destination warning right above the buttons, and moves the consent box under them', async () => {
    const html = await signInPage();
    expect(html).toContain('<div class="flow login">');
    // The short form of the warning comes before the form, the full box before it too (desktop order).
    const compact = html.indexOf('class="returns-compact"');
    expect(compact).toBeGreaterThan(-1);
    expect(compact).toBeLessThan(html.indexOf('<form method="POST" action="/auth/login">'));
    expect(html).toContain('is sent to <span class="host">claude.ai</span>. Only continue if you started this and recognise this destination. If you did not, choose <strong>Cancel</strong>.</p>');
    // Phone layout: the form first, the consent box and the badge after it.
    expect(html).toContain('.flow.login > form { order: 1; }');
    expect(html).toContain('.flow.login > .consent { order: 3; margin: 18px 0 0; }');
    expect(html).toContain('.flow.login > .returns-compact { display: block; }');
  });

  it('does not focus the email field when provider buttons are above it', async () => {
    const html = await signInPage();
    expect(html).toContain('value="social:google"');
    expect(html).not.toMatch(/id="email"[^>]*autofocus/);
  });
});

describe('the sign-in page test (A3/A4)', () => {
  const signIn = async (signin: string, lang = 'de-DE,de;q=0.9,en;q=0.8', ua = MAC) => {
    const { controller, events } = build({ setting: 'next_step', signin });
    const res = makeRes();
    await controller.showLoginPage(
      undefined as any,
      undefined as any,
      req({ headers: { host: 'mcp.test', 'user-agent': ua, 'accept-language': lang } }),
      res,
    );
    await flush();
    return { html: res._sent as string, events: events() };
  };

  it('speaks the browser language on buttons_first, with the value line and the buttons first', async () => {
    const { html, events } = await signIn('buttons_first');
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<h1>Claude mit AnythingMCP verbinden</h1>');
    expect(html).toContain('<p class="sub value">Danach arbeitet Claude mit Ihren Apps');
    expect(html).not.toContain('Melden Sie sich an, damit');
    expect(html).toContain('<span>Weiter mit Google</span>');
    expect(html).toContain('<div class="flow login bf">');
    // The sign-up box gives way to a link under the form.
    expect(html).not.toContain('class="signup-btn"');
    expect(html).toContain('<a id="signup-link" href="/login?mode=register&amp;redirect=%2Fauth%2Flogin&amp;client=claude">Konto mit E-Mail erstellen</a>');
    // The destination warning stays above the buttons, in full.
    expect(html).toContain('Nach der Anmeldung geht der Zugang an <span class="host">claude.ai</span>. Fahren Sie nur fort, wenn Sie das selbst gestartet haben und dieses Ziel kennen. Andernfalls wählen Sie <strong>Abbrechen</strong>.');
    expect(html.indexOf('class="returns-compact"')).toBeLessThan(html.indexOf('value="social:google"'));
    expect(html).toContain('.flow.login.bf > .consent { order: 3; margin: 18px 0 0; }');
    expect(events.find((e) => e.event === 'authorize_page_viewed').metadata).toEqual(
      expect.objectContaining({ signinArm: 'buttons_first', lang: 'de' }),
    );
  });

  it('is English on buttons_first for a language we do not speak', async () => {
    const { html } = await signIn('buttons_first', 'fr-FR,fr;q=0.9');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>Connect Claude to AnythingMCP</h1>');
    expect(html).toContain('<p class="sub value">Then Claude works with the apps you use');
  });

  it('keeps the control page as before, in English, whatever the browser language', async () => {
    const { html, events } = await signIn('control');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>Connect Claude to AnythingMCP</h1>');
    expect(html).not.toContain('sub value');
    expect(html).toContain('class="signup-btn"');
    expect(html).toContain('<div class="flow login">');
    expect(html).toContain('Only continue if you started this and recognise this destination. If you did not, choose <strong>Cancel</strong>.');
    expect(events.find((e) => e.event === 'authorize_page_viewed').metadata).toEqual(expect.objectContaining({ signinArm: 'control' }));
  });

  it('reports a click on "Create an account" on both arms', async () => {
    for (const arm of ['control', 'buttons_first']) {
      const { html } = await signIn(arm);
      expect(html).toContain(`new URLSearchParams({ e: 'create_account', a: '${ATTEMPT}' })`);
      expect(html).toContain("document.querySelectorAll('.signup-btn, #signup-link')");
    }
  });

  it('translates the signed-in consent page too', async () => {
    const { controller } = build({ setting: 'next_step', signin: 'buttons_first' });
    const r = req({ headers: { host: 'mcp.test', 'user-agent': IPHONE } });
    const consent = await (controller as any).loadConsentContext(r);
    const html = (controller as any).renderLoginPage({
      error: undefined, serverName: 'AnythingMCP', consent, csrfToken: 'tok', ssoProviders: [], socialProviders: [],
      sessionUser: { id: 'u1', email: 'a@b.com', name: 'A' }, lang: 'it',
    });
    expect(html).toContain('<h1>Collega Claude a AnythingMCP</h1>');
    expect(html).toContain('>Consenti l’accesso</button>');
    expect(html).toContain('Accesso come <strong>a@b.com</strong>');
    expect(html).toContain('>Annulla</button>');
    // No value line for someone already signed in.
    expect(html).not.toContain('sub value');
  });
});
