// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import type { Request, Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { LoginController, QUICK_SETUP_APPS } from './login.controller';
import { followPausedPageInPlace } from './paused-page.spec-helper';
import { AuthPageThrottleFilter } from './auth-page-throttle.filter';
import { CallbackGuardMiddleware } from './callback-guard.middleware';
import { MCP_APP_COOKIE } from './resource-indicator.middleware';
import { TELEGRAM_ONE_TAP } from '../adapters/telegram-managed-bot';
import type { PageLanguage } from './authorization-attempt';
import { SIGN_IN_TEXTS } from './auth-page-i18n';
import { EMAIL_CODE_TEXTS, LOGIN_ERROR_TEXTS, SERVER_PICKER_TEXTS } from './auth-page-i18n.steps';
import { CONNECTED_PAGE_TEXTS } from './auth-page-i18n.connected';
import { TELEGRAM_PANEL_TEXTS } from './auth-page-i18n.telegram';
import { EDGE_PAGE_TEXTS } from './auth-page-i18n.pages';

// The page after approving is reached through a redirect: follow it in place.
followPausedPageInPlace();

/**
 * The pages after the sign-in page in the browser's language: which page
 * speaks which language (the `buttons_first` arm of the sign-in page test,
 * the control arm, self-hosted, no attempt at all), that one attempt never
 * mixes languages, that names from outside stay escaped, and the page
 * scripts run in a language other than English.
 */

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const GERMAN = 'de-DE,de;q=0.9,en;q=0.8';
const JAPANESE = 'ja-JP,ja;q=0.9,en-US;q=0.8';
/** A name a client registers itself with: everything a page or a script could trip over. */
const HOSTILE = 'Evil"\'</script><img src=x onerror=alert(1)>\\u0041\\';
const HOSTILE_ESCAPED = 'Evil&quot;&#x27;&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;\\u0041\\';
const TRIAL_END = new Date('2026-10-13T12:00:00Z');
/** One moment for every fixture: the attempt key in the pages' beacons is derived from it. */
const EXPIRES = Date.now() + 20 * 60_000;
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

type FakeRes = Response & Record<string, any>;

function makeRes(): FakeRes {
  const res: any = {
    _cookies: {} as Record<string, { value: string; options: any }>,
    _cleared: [] as string[],
    _status: 200,
    _headers: {} as Record<string, string>,
    cookie(name: string, value: string, options: any) {
      this._cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string) {
      this._cleared.push(name);
      return this;
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    type() {
      return this;
    },
    end() {
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
    redirect(a: string | number, b?: string) {
      this._redirect = typeof a === 'number' ? (b as string) : a;
      return this;
    },
  };
  return res as FakeRes;
}

interface BuildOptions {
  deployment?: object;
  /** `AUTHORIZE_SIGNIN_PAGE_TEST`: the arm every attempt gets. */
  signin?: 'buttons_first' | 'control' | 'off';
  /** `AUTHORIZE_CONNECTED_PAGE_TEST`. */
  connected?: 'next_step' | 'control';
  clientName?: string;
  /** No pending authorization in the database. */
  session?: boolean;
  redirectUri?: string;
  /** The account's address is verified (false: the code step). */
  verified?: boolean;
  /** More than one server to choose from: the picker. */
  picker?: boolean;
  /** Member visibility narrows the user's view of the workspace. */
  restricted?: boolean;
  telegram?: boolean;
  /** An admin on the free trial who may add a payment method. */
  cardTrial?: boolean;
  trialEnded?: boolean;
}

function build(opts: BuildOptions = {}) {
  const user = { id: 'u1', email: 'anna@example.com', name: 'A', passwordHash: 'hash', emailVerified: opts.verified !== false };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ select }: any) =>
        select?.createdAt
          ? { createdAt: new Date(Date.now() - 60_000), organizationId: 'org-1' }
          : select?.organizationId
            ? { organizationId: 'org-1', email: user.email }
            : { ...user, passwordLoginDisabled: false },
      ),
      findMany: jest.fn().mockResolvedValue([user]),
    },
    organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
    connector: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    oAuthSession: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'FRONTEND_URL'
        ? 'https://cloud.example'
        : key === 'AUTHORIZE_SIGNIN_PAGE_TEST'
          ? (opts.signin ?? 'buttons_first')
          : key === 'AUTHORIZE_CONNECTED_PAGE_TEST'
            ? (opts.connected ?? 'next_step')
            : undefined,
    ),
  };
  const store = {
    getOAuthSession: jest.fn(async (id: string) =>
      opts.session !== false && id === 's1'
        ? {
            sessionId: 's1',
            state: 'x',
            clientId: 'c1',
            redirectUri: opts.redirectUri ?? 'https://claude.ai/api/mcp/auth_callback',
            expiresAt: EXPIRES,
          }
        : undefined,
    ),
    getClient: jest.fn(async () => ({ client_id: 'c1', client_name: opts.clientName ?? 'Claude' })),
    removeOAuthSession: jest.fn(async () => undefined),
  };
  const grants = {
    grantServers: jest.fn(async (_c: string, _u: string, ids: string[]) => ids),
    grantWholeOrganization: jest.fn().mockResolvedValue(true),
    listSelectableTargets: jest.fn().mockResolvedValue(
      opts.picker
        ? [
            {
              organizationId: 'org-1',
              organizationName: 'Acme',
              servers: [
                { id: 'srv-1', name: 'Shop', connectorCount: 1 },
                { id: 'srv-2', name: 'Office', connectorCount: 3 },
              ],
            },
          ]
        : [],
    ),
    resolve: jest.fn().mockResolvedValue(null),
    keepVisible: jest.fn(async (_u: string, servers: unknown[]) => servers),
    restrictedIn: jest.fn().mockResolvedValue(!!opts.restricted),
  };
  const social = {
    enabledProviders: jest.fn(() => [
      { id: 'google', name: 'Google' },
      { id: 'github', name: 'GitHub' },
    ]),
    start: jest.fn(),
    complete: jest.fn(),
    logFailure: jest.fn(async () => undefined),
  };
  const provider = {
    canSetUp: jest.fn().mockResolvedValue(true),
    install: jest.fn(async () => ({ isError: false, connectorId: 'conn-1', body: {} })),
  };
  const telegram = {
    isEnabledFor: jest.fn().mockReturnValue(true),
    begin: jest.fn(async () => ({
      link: 'https://t.me/newbot/x',
      username: 'amcp_x_bot',
      claimLink: 'https://t.me/setup?start=x',
      webLink: 'https://web.telegram.org/a/#x',
      claimWebLink: 'https://web.telegram.org/a/#y',
      qrPath: '/auth/first-app/telegram/qr/x',
    })),
    status: jest.fn(async (): Promise<Record<string, unknown>> => ({ state: 'waiting' })),
    saveToken: jest.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, bot: '@own_bot' })),
  };
  const verification = {
    codesSentWithin: jest.fn().mockResolvedValue(0),
    sendCode: jest.fn().mockResolvedValue(true),
    verifyCode: jest.fn().mockResolvedValue(false),
  };
  const recent = { user: jest.fn(), session: jest.fn() };
  const trial = opts.trialEnded
    ? { active: false }
    : opts.cardTrial
      ? { active: true, cardTrialAvailable: true, endsAt: TRIAL_END }
      : null;
  const controller = new LoginController(
    { comparePassword: jest.fn().mockResolvedValue(true), verifyToken: jest.fn(() => ({ sub: 'u1', tokenVersion: 0 })) } as any,
    prisma as any,
    config as any,
    store as any,
    { startMcp: jest.fn() } as any,
    (opts.deployment ?? CLOUD) as any,
    grants as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
    { getTrialState: jest.fn().mockResolvedValue(trial) } as any,
    { hadSubscription: jest.fn().mockResolvedValue(false) } as any,
    social as any,
    {
      get: (token: unknown) => (token === TELEGRAM_ONE_TAP ? (opts.telegram ? telegram : null) : { get: () => provider }),
    } as any,
    recent as any,
    verification as any,
  );
  return { controller, grants, verification, telegram, provider, social, prisma, config };
}

const req = (language?: string, signed: Record<string, unknown> = {}, userAgent = MAC, cookies: Record<string, string> = { oauth_session: 's1' }): Request =>
  ({
    headers: { host: 'mcp.test', 'user-agent': userAgent, ...(language ? { 'accept-language': language } : {}) },
    cookies,
    signedCookies: { login_csrf: 'tok', ...signed },
    secure: false,
  }) as unknown as Request;

/** The signed cookies a browser holds after `res`, on top of the ones it sent. */
const signedAfter = (res: FakeRes, before: Record<string, unknown> = {}): Record<string, unknown> => {
  const signed: Record<string, unknown> = { ...before };
  for (const name of res._cleared as string[]) delete signed[name];
  for (const [name, cookie] of Object.entries(res._cookies as Record<string, any>)) {
    if (cookie?.options?.signed) signed[name] = cookie.value;
  }
  return signed;
};

type Fixture = ReturnType<typeof build>;

const signInPage = async (f: Fixture, language?: string, error?: string, userAgent = MAC) => {
  const res = makeRes();
  await f.controller.showLoginPage(error as any, undefined as any, req(language, {}, userAgent), res);
  return res._sent as string;
};

/** "Sign in & allow" with the right password: whatever page comes next. */
const signIn = async (f: Fixture, language?: string, userAgent = MAC, signed: Record<string, unknown> = {}) => {
  const res = makeRes();
  await f.controller.handleLogin(
    req(language, signed, userAgent),
    { email: 'anna@example.com', password: 'pw', csrf: 'tok', action: 'approve' } as any,
    res,
  );
  await flush();
  return res;
};

/** Every English sentence of a dictionary: none of them may be left on a translated page. */
function sentences(value: unknown): string[] {
  if (typeof value === 'string') {
    // Split at the placeholders and the markup: what is left is what the page would show.
    return value
      .split(/\{\w+\}|<\/?strong>|&amp;/)
      .map((part) => part.trim())
      .filter((part) => /[A-Za-z]{3,} [A-Za-z]{2,}/.test(part) && part.length > 11);
  }
  return Object.values(value as Record<string, unknown>).flatMap(sentences);
}
const ENGLISH = [
  ...sentences(SIGN_IN_TEXTS.en),
  ...sentences(EMAIL_CODE_TEXTS.en),
  ...sentences(SERVER_PICKER_TEXTS.en),
  ...sentences(LOGIN_ERROR_TEXTS.en),
  ...sentences(CONNECTED_PAGE_TEXTS.en),
  ...sentences(TELEGRAM_PANEL_TEXTS.en),
  ...sentences(EDGE_PAGE_TEXTS.en),
  'Continue to',
  'Verify and continue',
  'Check your email',
  'Stay on this page',
];

/**
 * The page without what is deliberately the same in every language: the
 * trust row and the footer under the card, the directory badge, the styles.
 */
const translatedPart = (page: string) =>
  page
    .slice(page.indexOf('<main'), page.indexOf('</main>'))
    .replace(/<div class="verified[^>]*>.*?<\/div>/s, '')
    // The scripts' comments are English; their texts are checked on their own.
    .replace(/<script>.*?<\/script>/gs, '');

function expectNoEnglish(page: string) {
  const text = translatedPart(page);
  const left = ENGLISH.filter((sentence) => text.includes(sentence));
  expect(left).toEqual([]);
}

describe('the pages after the sign-in page, in the browser\'s language', () => {
  const cases: Array<[PageLanguage, string]> = [
    ['de', GERMAN],
    ['ja', JAPANESE],
  ];

  describe.each(cases)('%s on the buttons_first arm', (lang, header) => {
    it('the e-mail code step, with its notices and errors', async () => {
      const f = build({ verified: false, clientName: HOSTILE });
      const first = await signIn(f, header);
      const page = first._sent as string;
      const T = EMAIL_CODE_TEXTS[lang];
      expect(page).toContain(`<html lang="${lang}">`);
      expect(page).toContain(`<h1>${T.heading}</h1>`);
      expect(page).toContain(`<title>${T.title} — AnythingMCP</title>`);
      expect(page).toContain(`<label for="code">${T.codeLabel}</label>`);
      expect(page).toContain(`<button type="submit">${T.verify}</button>`);
      expect(page).toContain(`formnovalidate class="secondary">${T.resend}</button>`);
      expect(page).toContain(`formnovalidate class="secondary">${T.openedLink}</button>`);
      expect(page).toContain(`<span>${SIGN_IN_TEXTS[lang].continueWith.replace('{provider}', 'Google')}</span>`);
      expect(page).toContain(T.providerAccount.replace('{providers}', `Google${T.providerLast}GitHub`));
      expect(page).toContain(`${T.noEmail} <a href="/auth/login?switch=1">${T.otherAccount}</a>`);
      // The masked address and the client's own name, both escaped.
      expect(page).toContain('<strong>an***@example.com</strong>');
      expect(page).toContain(`<strong>${HOSTILE_ESCAPED}</strong>`);
      expect(page).not.toContain('<img src=x');
      expectNoEnglish(page);

      // A wrong code, a new code too soon, the link not opened yet: the same page, the same language.
      const signed = signedAfter(first);
      const csrf = signed.verify_csrf as string;
      const wrong = makeRes();
      await f.controller.handleEmailCode(req(header, signed), { csrf, code: '000000' }, wrong);
      expect(wrong._sent).toContain(`<div class="error" role="alert">${T.codeWrong}</div>`);
      expectNoEnglish(wrong._sent);

      const again = signedAfter(wrong, signed);
      f.verification.codesSentWithin.mockResolvedValueOnce(1);
      const soon = makeRes();
      await f.controller.resendEmailCode(req(header, again), { csrf: again.verify_csrf as string }, soon);
      expect(soon._sent).toContain(`<p class="note" role="status">${T.resendTooSoon}</p>`);

      const third = signedAfter(soon, again);
      f.verification.codesSentWithin.mockResolvedValueOnce(0).mockResolvedValueOnce(99);
      const many = makeRes();
      await f.controller.resendEmailCode(req(header, third), { csrf: third.verify_csrf as string }, many);
      expect(many._sent).toContain(`<p class="note" role="status">${T.tooManyCodes}</p>`);

      const fourth = signedAfter(many, third);
      const sent = makeRes();
      await f.controller.resendEmailCode(req(header, fourth), { csrf: fourth.verify_csrf as string }, sent);
      expect(sent._sent).toContain(`<p class="note" role="status">${T.newCodeSent}</p>`);

      const fifth = signedAfter(sent, fourth);
      const notYet = makeRes();
      await f.controller.continueAfterEmailLink(req(header, fifth), { csrf: fifth.verify_csrf as string }, notYet);
      expect(notYet._sent).toContain(`<div class="error" role="alert">${T.notVerifiedYet}</div>`);
      expectNoEnglish(notYet._sent);
    });

    it('"Choose what to connect", with its inline error and note', async () => {
      const f = build({ picker: true, clientName: HOSTILE });
      const page = (await signIn(f, header))._sent as string;
      const T = SERVER_PICKER_TEXTS[lang];
      expect(page).toContain(`<html lang="${lang}">`);
      expect(page).toContain(`<title>${T.heading}</title>`);
      expect(page).toContain(`<h1>${T.heading}</h1>`);
      expect(page).toContain(T.sub.replace('{client}', HOSTILE_ESCAPED));
      expect(page).toContain(`<span class="pick-meta">${T.connectors.one.replace('{n}', '1')}</span>`);
      expect(page).toContain(`<span class="pick-name">${T.everything}<span class="pick-sub">${T.everythingSub}</span></span>`);
      expect(page).toContain(`<p class="error" id="pick-error" role="alert" hidden>${T.pickError}</p>`);
      expect(page).toContain(`<button type="submit">${T.connect}</button>`);
      expect(page).toContain(`<p class="note">${T.note}</p>`);
      expect(page).not.toContain('<img src=x');
      expectNoEnglish(page);
    });

    it('"Choose what to connect" names the account and, for a restricted member, the tools their role allows', async () => {
      const f = build({ picker: true, restricted: true });
      const page = (await signIn(f, header))._sent as string;
      const T = SERVER_PICKER_TEXTS[lang];
      const S = SIGN_IN_TEXTS[lang];
      expect(page).toContain(S.signedInAs.replace('{email}', '<strong>anna@example.com</strong>'));
      expect(page).toContain(`<a href="/auth/login?switch=1">${S.switchAccount}</a>`);
      expect(page).toContain(`<span class="pick-name">${T.roleTools}<span class="pick-sub">${T.roleToolsSub}</span></span>`);
      expect(page).not.toContain(T.everythingSub);
      expectNoEnglish(page);
    });

    it('the page after approving, with the picker, the Telegram panel and the payment method', async () => {
      const f = build({ telegram: true, cardTrial: true, clientName: HOSTILE });
      const page = (await signIn(f, header))._sent as string;
      const T = CONNECTED_PAGE_TEXTS[lang];
      const G = TELEGRAM_PANEL_TEXTS[lang];
      const fillClient = (text: string) => text.replace(/\{client\}/g, HOSTILE_ESCAPED);
      expect(page).toContain(`<html lang="${lang}">`);
      expect(page).toContain(`<h1 class="vh">${fillClient(T.headingNext)}</h1>`);
      expect(page).toContain(`<p class="sub" id="first-sub">${fillClient(T.subNext)}</p>`);
      expect(page).toContain(`id="first-sub2">${T.noApps}</p>`);
      expect(page).toContain(`<span>${T.quoteOpen}<span id="example-request">${T.example}</span>${T.quoteClose}</span>`);
      expect(page).toContain(`id="copy-request" data-continue="1">${T.copyContinue}</button>`);
      expect(page).toContain(`<p class="body" id="first-body">${fillClient(T.body)}</p>`);
      expect(page).toContain(`<p class="quick-title" id="quick-title">${T.pickerTitle}</p>`);
      expect(page).toContain(`<label class="other-label" for="other-app">${T.otherApp}</label>`);
      expect(page).toContain(`placeholder="${T.otherPlaceholder}"`);
      expect(page).toContain(`id="auto-continue-stay">${T.stay}</button>`);
      expect(page).toContain(`data-client="${HOSTILE_ESCAPED}">${fillClient(T.continueTo)}</a>`);
      expect(page).toContain(`id="card-trial-link" href="https://cloud.example/start-trial?source=post_approve&amp;return=%2Fcallback">${T.addPayment}</a>`);
      expect(page).toContain(`rel="noopener noreferrer">${T.addHere}</a>`);
      // The Telegram panel's markup.
      expect(page).toContain(`rel="noopener noreferrer">${G.create}</a>`);
      expect(page).toContain(`<p class="tg-help" id="tg-help">${G.help}</p>`);
      expect(page).toContain(`<summary>${G.pasteSummary}</summary>`);
      expect(page).toContain(`<li>${G.step1}</li>`);
      expect(page).toContain(`<label for="tg-token">${G.tokenLabel}</label>`);
      expect(page).toContain(`id="tg-token-save">${G.save}</button>`);
      expect(page).toContain(`<p class="tg-hint" id="tg-hint">${G.linkHintQr}</p>`);
      expect(page).toContain(`alt="${G.qrAlt}"`);
      // The app names are brand names: the same in every language.
      expect(page).toContain('data-adapter="telegram-bot" data-name="Telegram">Telegram</button>');
      // The hostile name appears only escaped, in the markup and in the title.
      expect(page).toContain(`<title>${fillClient(T.headingNext)}</title>`);
      expect(page).not.toContain('<img src=x');
      expect(page.match(/<\/script>/g)).toHaveLength(1);
      expectNoEnglish(page);
    });

    it('the date of the payment-method note, in the language of the page', async () => {
      const f = build({ cardTrial: true });
      const page = (await signIn(f, header))._sent as string;
      const date = lang === 'de' ? '13.&nbsp;Oktober' : '10月13日';
      expect(page).toContain(`<p>${CONNECTED_PAGE_TEXTS[lang].trialNote.replace(/\{date\}/g, date).replace('{client}', 'Claude')}</p>`);
      expect(page).not.toContain('October');
    });

    it('the ended trial, and the control arm of the page test', async () => {
      const ended = (await signIn(build({ trialEnded: true }), header))._sent as string;
      expect(ended).toContain(`id="first-sub2">${CONNECTED_PAGE_TEXTS[lang].trialEnded.replace('{client}', 'Claude')}</p>`);
      expectNoEnglish(ended);

      const control = (await signIn(build({ connected: 'control' }), header))._sent as string;
      const T = CONNECTED_PAGE_TEXTS[lang];
      expect(control).toContain(`<h1>${T.headingControl.replace('{client}', 'Claude')}</h1>`);
      expect(control).toContain(`<p class="sub" id="first-sub">${T.subControl.replace('{client}', 'Claude')}</p>`);
      expect(control).toContain(`id="copy-request">${T.copy}</button>`);
      expectNoEnglish(control);
    });

    it('the File Search folder page and the page its wizard returns to', async () => {
      const f = build({ clientName: HOSTILE });
      const page = (await signIn(f, header, MAC, { [MCP_APP_COOKIE]: 'file-search' }))._sent as string;
      const T = EDGE_PAGE_TEXTS[lang].fileSearch;
      const fillClient = (text: string) => text.replace(/\{client\}/g, HOSTILE_ESCAPED);
      expect(page).toContain(`<html lang="${lang}">`);
      expect(page).toContain(`<h1>${fillClient(T.heading)}</h1>`);
      expect(page).toContain(`<p class="sub">${fillClient(T.sub)}</p>`);
      expect(page).toContain(`aria-label="${T.optionsLabel}"`);
      expect(page).toContain(`<span class="fs-option-label">SFTP</span><span class="fs-option-hint">${T.optionHints.sftp}</span>`);
      expect(page).toContain(`<span class="fs-option-label">${T.optionLabels.s3}</span><span class="fs-option-hint">AWS S3, DigitalOcean Spaces, MinIO, Wasabi</span>`);
      expect(page).toContain('<span class="fs-option-label">Nextcloud</span><span class="fs-option-hint">WebDAV</span>');
      expect(page).toContain(`<li>${fillClient(T.step3)}</li>`);
      expect(page).toContain(`<p class="body">${fillClient(T.body)}</p>`);
      expect(page).toContain(`>${fillClient(T.skip)}</a>`);
      expect(page).not.toContain('<img src=x');
      expectNoEnglish(page);

      // Back from the wizard, signed out of the attempt meanwhile: the attempt's language.
      const back = makeRes();
      await f.controller.fileSearchSetupContinue(req(header), back);
      expect(back._sent).toContain(`<html lang="${lang}">`);
      expect(back._sent).toContain(`<h1>${T.doneHeading}</h1>`);
      expect(back._sent).toContain(`<p class="sub">${T.done1}</p>`);
      expect(back._sent).toContain(`<p class="sub">${T.done2}</p>`);
      expectNoEnglish(back._sent);
    });

    it('the message of a redirect, on the sign-in page', async () => {
      const f = build({});
      const E = LOGIN_ERROR_TEXTS[lang];
      const alert = (text: string) => `<div class="error" role="alert">${text}</div>`;
      expect(await signInPage(f, header, 'sessionExpired')).toContain(alert(E.sessionExpired));
      expect(await signInPage(f, header, 'wrongWorkspace')).toContain(alert(E.wrongWorkspace));
      expect(await signInPage(f, header, 'cancelled')).toContain(alert(E.cancelled));
      expect(await signInPage(f, header, 'ssoUnavailable')).toContain(alert(E.ssoUnavailable));
      expect(await signInPage(f, header, 'authorizationExpired')).toContain(alert(E.authorizationExpired));
      expect(await signInPage(f, header, 'signInFailed')).toContain(
        alert(E.signInFailed.replace('{providers}', `Google${E.listOr}GitHub`)),
      );
      expect(await signInPage(f, header, 'providerNoEmail:github')).toContain(alert(E.providerNoEmail.replace('{provider}', 'GitHub')));
      // The English text an already open page was redirected with: recognised, and translated.
      expect(await signInPage(f, header, 'Your session expired. Please try again.')).toContain(alert(E.sessionExpired));
      // Any other text is shown as it is, escaped.
      expect(await signInPage(f, header, '<b>hello</b> there')).toContain(alert('&lt;b&gt;hello&lt;/b&gt; there'));
      expectNoEnglish(await signInPage(f, header, 'signInFailed'));
    });
  });

  it('follows the first language of the browser that is one of the seven', async () => {
    const heading = async (header?: string) => /<h1>([^<]*)<\/h1>/.exec((await signIn(build({ picker: true }), header))._sent as string)![1];
    expect(await heading('fr-FR,fr;q=0.9')).toBe('Choose what to connect');
    expect(await heading('fr-FR,fr;q=0.9,it;q=0.8,en;q=0.7')).toBe(SERVER_PICKER_TEXTS.it.heading);
    expect(await heading('es-MX')).toBe(SERVER_PICKER_TEXTS.es.heading);
    expect(await heading('zh-CN,zh;q=0.9')).toBe(SERVER_PICKER_TEXTS.zh.heading);
    expect(await heading('ru')).toBe(SERVER_PICKER_TEXTS.ru.heading);
    expect(await heading(undefined)).toBe('Choose what to connect');
    expect(await heading('en-GB,de;q=0.5')).toBe('Choose what to connect');
  });
});

describe('the control arm and a self-hosted instance stay in English', () => {
  /** Tokens differ from render to render: everything else must not. */
  const stable = (page: string) =>
    page
      .replace(/name="csrf" value="[^"]+"/g, 'name="csrf" value=""')
      .replace(/data-csrf="[^"]+"/g, 'data-csrf=""')
      .replace(/[?&](t|amp;t)=[A-Za-z0-9_-]{20,}/g, '');

  const pages = async (opts: BuildOptions, header?: string) => ({
    signIn: stable(await signInPage(build(opts), header, 'sessionExpired')),
    code: stable((await signIn(build({ ...opts, verified: false }), header))._sent ?? ''),
    picker: stable((await signIn(build({ ...opts, picker: true }), header))._sent ?? ''),
    next: stable((await signIn(build({ ...opts, telegram: true, cardTrial: true }), header))._sent ?? ''),
    fileSearch: stable((await signIn(build(opts), header, MAC, { [MCP_APP_COOKIE]: 'file-search' }))._sent ?? ''),
  });

  it('on the control arm of the sign-in page test, whatever the browser asks for', async () => {
    const english = await pages({ signin: 'control' });
    const german = await pages({ signin: 'control' }, GERMAN);
    expect(german).toEqual(english);
    expect(english.code).toContain('<h1>Check your email</h1>');
    expect(english.picker).toContain('<h1>Choose what to connect</h1>');
    expect(english.next).toContain('<h1 class="vh">One more step: go back to Claude</h1>');
    expect(english.next).toContain('Your free trial runs until October&nbsp;13.');
    expect(english.fileSearch).toContain('<h1>Connect a folder for Claude</h1>');
    for (const page of Object.values(english)) expect(page).toContain('<html lang="en">');
    // The same pages as when the test does not run at all.
    expect(await pages({ signin: 'off' }, GERMAN)).toEqual(await pages({ signin: 'off' }));
  });

  it('on a self-hosted instance, where no arm exists', async () => {
    const opts = { deployment: SELF_HOSTED } as const;
    const english = await pages(opts);
    expect(await pages(opts, GERMAN)).toEqual(english);
    expect(english.signIn).toContain('<html lang="en">');
    expect(english.signIn).toContain('Your session expired. Please try again.');
    expect(english.picker).toContain('<h1>Choose what to connect</h1>');
    expect(english.fileSearch).toContain('<h1>Connect a folder for Claude</h1>');
  });

  it('and in English the buttons_first arm shows the texts the pages always had', async () => {
    const english = await pages({ signin: 'buttons_first' }, 'en-US,en;q=0.9');
    const control = await pages({ signin: 'control' });
    // Only the sign-in page differs between the arms.
    expect({ ...english, signIn: '' }).toEqual({ ...control, signIn: '' });
  });

  it('answers the page scripts in English too', async () => {
    for (const opts of [{ signin: 'control' as const }, { signin: 'off' as const }]) {
      const f = build({ ...opts, telegram: true });
      const first = await signIn(f, GERMAN);
      const signed = signedAfter(first);
      const csrf = signed.first_app_csrf as string;
      const pick = makeRes();
      await f.controller.pickFirstApp(req(GERMAN, signed), { adapter: 'etsy', csrf }, pick);
      expect(pick._json).toEqual({ ok: true, adapter: 'etsy', name: 'Etsy', request: 'Finish setting up my Etsy connector.' });
      const refused = makeRes();
      await f.controller.pickFirstApp(req(GERMAN, signed), { adapter: 'etsy', csrf: 'wrong' }, refused);
      expect(refused._json.error).toBe('This page has expired. Go back to your AI assistant and press Connect again.');
      f.telegram.status.mockResolvedValueOnce({ state: 'connected', bot: '@b' });
      const status = makeRes();
      await f.controller.telegramOneTapStatus(req(GERMAN, signed), { csrf }, status);
      expect(status._json.request).toBe('Send me a test message on Telegram.');
    }
  });
});

describe('one attempt never mixes languages', () => {
  it.each([
    ['de', GERMAN],
    ['ja', JAPANESE],
    ['ru', 'ru-RU,ru;q=0.9'],
  ] as Array<[PageLanguage, string]>)('%s: sign-in page, code step, picker, page after approving', async (lang, header) => {
    const f = build({ verified: false, picker: true, telegram: true, cardTrial: true });
    const seen: string[] = [];

    const first = await signInPage(f, header);
    seen.push(first);
    expect(first).toContain(`<h1>${SIGN_IN_TEXTS[lang].heading.replace('{client}', 'Claude').replace('{server}', 'AnythingMCP')}</h1>`);

    const codeStep = await signIn(f, header);
    seen.push(codeStep._sent);
    expect(codeStep._sent).toContain(`<h1>${EMAIL_CODE_TEXTS[lang].heading}</h1>`);

    // The right code: on to the picker.
    let signed = signedAfter(codeStep);
    f.verification.verifyCode.mockResolvedValueOnce(true);
    const picker = makeRes();
    await f.controller.handleEmailCode(req(header, signed), { csrf: signed.verify_csrf as string, code: '123456' }, picker);
    await flush();
    seen.push(picker._sent);
    expect(picker._sent).toContain(`<h1>${SERVER_PICKER_TEXTS[lang].heading}</h1>`);

    // A choice: on to the page after approving.
    signed = signedAfter(picker, signed);
    const next = makeRes();
    await f.controller.handleServerSelection(
      req(header, signed),
      { servers: ['srv-1'], csrf: signed.login_csrf as string },
      next,
    );
    await flush();
    seen.push(next._sent);
    expect(next._followed).toBe('/auth/next');
    expect(next._sent).toContain(`<h1 class="vh">${CONNECTED_PAGE_TEXTS[lang].headingNext.replace('{client}', 'Claude')}</h1>`);

    expect(seen).toHaveLength(4);
    for (const page of seen) {
      expect(page).toContain(`<html lang="${lang}">`);
      expectNoEnglish(page);
    }
    // The script strings of the last page are the same language: every one of this dictionary, none of the English one.
    const script = next._sent.slice(next._sent.indexOf('<script>'), next._sent.indexOf('</script>'));
    for (const text of [...Object.values(CONNECTED_PAGE_TEXTS[lang].js), ...Object.values(TELEGRAM_PANEL_TEXTS[lang].js)]) {
      expect(script).toContain(JSON.stringify(text).replace(/&/g, '\\u0026'));
    }
    for (const text of [...Object.values(CONNECTED_PAGE_TEXTS.en.js), ...Object.values(TELEGRAM_PANEL_TEXTS.en.js)]) {
      expect(script).not.toContain(JSON.stringify(text));
    }
    // And what the page asks the server comes back in it.
    signed = signedAfter(next, signed);
    const pick = makeRes();
    await f.controller.pickFirstApp(req(header, signed), { adapter: 'woocommerce', csrf: signed.first_app_csrf as string }, pick);
    expect(pick._json.request).toBe(CONNECTED_PAGE_TEXTS[lang].finishRequest.replace('{app}', 'WooCommerce'));
  });
});

describe('pages without an attempt speak the browser\'s language for everyone', () => {
  const deployments: Array<[string, BuildOptions]> = [
    ['Cloud, control arm', { signin: 'control' }],
    ['Cloud, test off', { signin: 'off' }],
    ['self-hosted', { deployment: SELF_HOSTED }],
  ];

  it.each(deployments)('"no longer open" on %s', async (_name, opts) => {
    const f = build({ ...opts, session: false });
    const T = EDGE_PAGE_TEXTS.de.closed;
    const res = makeRes();
    await f.controller.showLoginPage('sessionExpiredSignIn' as any, undefined as any, req(GERMAN), res);
    expect(res._sent).toContain('<html lang="de">');
    expect(res._sent).toContain(`<title>${T.heading}</title>`);
    expect(res._sent).toContain(`<h1>${T.heading}</h1>`);
    expect(res._sent).toContain(`<div class="error" role="alert">${LOGIN_ERROR_TEXTS.de.sessionExpiredSignIn}</div>`);
    expect(res._sent).toContain(`<p class="sub" id="closed-what">${T.what}</p>`);
    expect(res._sent).toContain(`<p class="sub" id="closed-next" style="margin-bottom:0">${T.next}</p>`);
    expect(res._sent).toContain(`${T.dashboardLead} <a href="https://cloud.example">${T.dashboardLink}</a>`);
    expectNoEnglish(res._sent);

    const next = makeRes();
    await f.controller.showPausedPage(req(JAPANESE), next);
    expect(next._sent).toContain('<html lang="ja">');
    expect(next._sent).toContain(`<h1>${EDGE_PAGE_TEXTS.ja.closed.heading}</h1>`);

    // English for a browser that asks for English, or for a language that is not one of the seven.
    for (const header of [undefined, 'en-US', 'pt-BR']) {
      const english = makeRes();
      await f.controller.showLoginPage(undefined as any, undefined as any, req(header), english);
      expect(english._sent).toContain('<html lang="en">');
      expect(english._sent).toContain('<h1>This connection request is no longer open</h1>');
    }
  });

  it('"no longer open" from the callback guard', async () => {
    for (const cloud of [true, false]) {
      const guard = new CallbackGuardMiddleware(
        { oAuthSession: { findUnique: jest.fn().mockResolvedValue(null) } } as any,
        { get: () => 'https://cloud.example' } as any,
        { isCloud: () => cloud } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );
      const res = makeRes();
      const next = jest.fn();
      guard.use({ ...req(GERMAN), method: 'GET' } as any, res as any, next);
      await flush();
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(400);
      expect(res._sent).toContain('<html lang="de">');
      expect(res._sent).toContain(`<h1>${EDGE_PAGE_TEXTS.de.closed.heading}</h1>`);
    }
  });

  it.each(deployments)('"Too many attempts" on %s', (_name, opts) => {
    const filter = new AuthPageThrottleFilter((opts.deployment ?? CLOUD) as any);
    const render = (header?: string) => {
      const res = makeRes();
      const request = { originalUrl: '/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(header ? { 'accept-language': header } : {}) } };
      filter.catch(new ThrottlerException(), { switchToHttp: () => ({ getRequest: () => request, getResponse: () => res }) } as any);
      return res._sent as string;
    };
    const T = EDGE_PAGE_TEXTS.de.rateLimit;
    const german = render(GERMAN);
    expect(german).toContain('<html lang="de">');
    expect(german).toContain(`<title>${T.heading}</title>`);
    expect(german).toContain(`<h1>${T.heading}</h1>`);
    expect(german).toContain(`<p class="sub">${T.body}</p>`);
    expect(german).toContain(`<a class="button" href="/auth/login">${T.back}</a>`);
    expectNoEnglish(german);
    expect(render(JAPANESE)).toContain(`<h1>${EDGE_PAGE_TEXTS.ja.rateLimit.heading}</h1>`);
    expect(render()).toContain('<h1>Too many attempts</h1>');
    expect(render()).toContain('<html lang="en">');
  });

  it('"Request Cancelled": the attempt\'s language while there is one, the browser\'s without', async () => {
    const cancel = async (opts: BuildOptions, header?: string) => {
      const f = build(opts);
      const res = makeRes();
      await f.controller.handleLogin(req(header), { email: '', password: '', csrf: 'tok', action: 'deny' } as any, res);
      return res;
    };
    const T = EDGE_PAGE_TEXTS.de.cancelled;
    // No pending authorization left: nothing to tell a client, and no arm.
    for (const opts of [{ session: false, signin: 'control' as const }, { session: false, deployment: SELF_HOSTED }]) {
      const res = await cancel(opts, GERMAN);
      expect(res._sent).toContain('<html lang="de">');
      expect(res._sent).toContain(`<title>${T.heading} — AnythingMCP</title>`);
      expect(res._sent).toContain(`<h1>${T.heading}</h1>`);
      expect(res._sent).toContain(`<p class="sub" style="margin-bottom:0">${T.body}</p>`);
      expectNoEnglish(res._sent);
    }
    // A client whose address cannot be parsed gets the page too: inside an attempt, so the arm decides.
    const unparseable = { redirectUri: 'not a url' };
    expect((await cancel({ ...unparseable, signin: 'buttons_first' }, GERMAN))._sent).toContain(`<h1>${T.heading}</h1>`);
    expect((await cancel({ ...unparseable, signin: 'control' }, GERMAN))._sent).toContain('<h1>Request Cancelled</h1>');
    // With an address, the client is told and no page is shown.
    expect((await cancel({ signin: 'buttons_first' }, GERMAN))._redirect).toContain('error=access_denied');
    expect((await cancel({ session: false }))._sent).toContain('<h1>Request Cancelled</h1>');
  });

  it('"Go back to the chat to finish", once the request is gone', async () => {
    for (const opts of [{ session: false, signin: 'control' as const }, { session: false, deployment: SELF_HOSTED }]) {
      const res = makeRes();
      await build(opts).controller.fileSearchSetupContinue(req(GERMAN), res);
      expect(res._sent).toContain('<html lang="de">');
      expect(res._sent).toContain(`<h1>${EDGE_PAGE_TEXTS.de.fileSearch.doneHeading}</h1>`);
    }
    // Still open, on the control arm: English.
    const open = makeRes();
    await build({ signin: 'control' }).controller.fileSearchSetupContinue(req(GERMAN), open);
    expect(open._sent).toContain('<h1>Go back to the chat to finish</h1>');
  });
});

describe('what the page scripts get back from the server', () => {
  const arrange = async (lang: string, opts: BuildOptions = {}) => {
    const f = build({ telegram: true, ...opts });
    const first = await signIn(f, lang);
    const signed = signedAfter(first);
    return { f, signed, csrf: signed.first_app_csrf as string, page: first._sent as string };
  };

  it('POST /auth/first-app answers in the language of the page that asked', async () => {
    const { f, signed, csrf } = await arrange(GERMAN);
    const A = CONNECTED_PAGE_TEXTS.de.answers;
    const call = async (body: Record<string, unknown>, request = req(GERMAN, signed)) => {
      const res = makeRes();
      await f.controller.pickFirstApp(request, body, res);
      return res;
    };
    expect((await call({ adapter: 'etsy', csrf: 'wrong' }))._json).toEqual({ ok: false, error: A.expired });
    expect((await call({ adapter: 'nope', csrf }))._json).toEqual({ ok: false, error: A.unknownApp });
    // Signed out of the attempt (the sign-in cookies are gone): still the page's language.
    const { login_user: _u, login_bind: _b, ...signedOut } = signed as Record<string, unknown>;
    void _u;
    void _b;
    expect((await call({ adapter: 'etsy', csrf }, req(GERMAN, signedOut)))._json).toEqual({ ok: false, error: A.expired });

    f.provider.canSetUp.mockResolvedValueOnce(false);
    expect((await call({ adapter: 'etsy', csrf }))._json).toEqual({ ok: false, error: A.adminsOnly });
    f.provider.install.mockResolvedValueOnce({ isError: true, body: { error: 'limit' } } as any);
    expect((await call({ adapter: 'etsy', csrf }))._json).toEqual({ ok: false, error: A.couldNotAdd.replace('{app}', 'Etsy') });

    const ok = await call({ adapter: 'etsy', csrf });
    expect(ok._json).toEqual({ ok: true, adapter: 'etsy', name: 'Etsy', request: 'Schließe die Einrichtung meines Etsy-Connectors ab.' });

    // The same route for a Japanese page.
    const ja = await arrange(JAPANESE);
    const res = makeRes();
    await ja.f.controller.pickFirstApp(req(JAPANESE, ja.signed), { adapter: 'odoo', csrf: ja.csrf }, res);
    expect(res._json.request).toBe('Odoo コネクタの設定を完了してください。');
  });

  it('says so in the page\'s language when the setup service is missing', async () => {
    const { f, signed, csrf } = await arrange(GERMAN);
    (f.controller as any).moduleRef = { get: () => null };
    const res = makeRes();
    await f.controller.pickFirstApp(req(GERMAN, signed), { adapter: 'odoo', csrf }, res);
    expect(res._status).toBe(503);
    expect(res._json.error).toBe(CONNECTED_PAGE_TEXTS.de.answers.cannotAddHere.replace('{app}', 'Odoo'));
  });

  it('shows the app picked before in the page\'s language after a reload', async () => {
    const { f, signed } = await arrange(GERMAN);
    const res = makeRes();
    await f.controller.showPausedPage(req(GERMAN, { ...signed, first_app_picked: 'etsy' }), res);
    expect(res._sent).toContain('data-picked="etsy" data-picked-request="Schließe die Einrichtung meines Etsy-Connectors ab."');
  });

  it('the Telegram status and token routes answer in the language of the page that asked', async () => {
    const { f, signed, csrf } = await arrange(GERMAN);
    const A = TELEGRAM_PANEL_TEXTS.de.answers;
    const status = async (body: Record<string, unknown>) => {
      const res = makeRes();
      await f.controller.telegramOneTapStatus(req(GERMAN, signed), body, res);
      return res;
    };
    const token = async (body: Record<string, unknown>) => {
      const res = makeRes();
      await f.controller.telegramOneTapToken(req(GERMAN, signed), body, res);
      return res;
    };
    expect((await status({ csrf: 'wrong' }))._json).toEqual({ ok: false, error: A.pageExpired });
    expect((await status({ csrf }))._json).toEqual({ ok: true, state: 'waiting' });
    f.telegram.status.mockResolvedValueOnce({ state: 'connected', bot: '@b' });
    expect((await status({ csrf }))._json).toEqual({ ok: true, state: 'connected', bot: '@b', request: A.request });
    f.telegram.status.mockRejectedValueOnce(new Error('down'));
    expect((await status({ csrf }))._json).toEqual({ error: A.tryAgain });

    expect((await token({ csrf: 'wrong', token: 'x' }))._json).toEqual({ ok: false, error: A.expiredContinue });
    expect((await token({ csrf, token: 'x' }))._json).toEqual({ ok: true, bot: '@own_bot', state: 'connected', request: A.request });
    // What the service refuses in its own words comes back in the page's language…
    for (const [english, german] of [
      ['Telegram is already connected.', A.alreadyConnected],
      ['This is not available right now. Continue, and finish Telegram in the chat.', A.unavailable],
      ['This page has expired. Continue, and finish Telegram in the chat.', A.expiredContinue],
      ['The token could not be saved. Try again.', A.notSaved],
      ['The token could not be checked right now. Try again, or continue and finish Telegram in the chat.', A.checkFailed],
      [
        'This does not look like a bot token. Paste the whole value from @BotFather, like 123456789:AAH..., with nothing before or after it.',
        A.notATokenStrict,
      ],
    ]) {
      f.telegram.saveToken.mockResolvedValueOnce({ ok: false, error: english });
      expect((await token({ csrf, token: 'x' }))._json).toEqual({ ok: false, error: german });
    }
    // …and Telegram's own refusal as it comes.
    f.telegram.saveToken.mockResolvedValueOnce({ ok: false, error: 'Telegram refused the bot token.' });
    expect((await token({ csrf, token: 'x' }))._json).toEqual({ ok: false, error: 'Telegram refused the bot token.' });
    f.telegram.saveToken.mockRejectedValueOnce(new Error('down'));
    expect((await token({ csrf, token: 'x' }))._json).toEqual({ ok: false, error: A.notSaved });
  });
});

/**
 * The page scripts, run. A small DOM is built from the page itself (every
 * element with an id, with its attributes as the browser would decode them),
 * the script block is executed in a VM, and what it asks the server goes to
 * the controller for real: the texts on the page afterwards are what a person
 * would read.
 */
describe('the page scripts in a language other than English', () => {
  interface El {
    attrs: Record<string, string>;
    textContent: string;
    hidden: boolean;
    value: string;
    readOnly: boolean;
    listeners: Record<string, Array<(e: any) => unknown>>;
    getAttribute(n: string): string | null;
    setAttribute(n: string, v: string): void;
    addEventListener(t: string, f: (e: any) => unknown): void;
    querySelectorAll(): El[];
    click(): void;
    scrollIntoView(): void;
  }
  const decode = (v: string) =>
    v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const el = (attrs: Record<string, string> = {}, text = ''): El => ({
    attrs,
    textContent: text,
    hidden: 'hidden' in attrs,
    value: '',
    readOnly: false,
    listeners: {},
    getAttribute(n) {
      return n in this.attrs ? this.attrs[n] : null;
    },
    setAttribute(n, v) {
      this.attrs[n] = v;
    },
    addEventListener(t, f) {
      (this.listeners[t] ??= []).push(f);
    },
    querySelectorAll() {
      return [];
    },
    click() {
      for (const f of this.listeners.click ?? []) f({ currentTarget: this, preventDefault() {} });
    },
    scrollIntoView() {},
  });
  const fire = (node: El, type: string, event: Record<string, unknown> = {}) => {
    for (const f of node.listeners[type] ?? []) f({ currentTarget: node, preventDefault() {}, ...event });
  };

  const run = async (opts: { header: string; build?: BuildOptions; signedExtra?: Record<string, unknown>; clipboard?: boolean }) => {
    const f = build({ telegram: true, ...opts.build });
    const first = await signIn(f, opts.header);
    let signed = signedAfter(first);
    let page = first._sent as string;
    if (opts.signedExtra) {
      signed = { ...signed, ...opts.signedExtra };
      const again = makeRes();
      await f.controller.showPausedPage(req(opts.header, signed), again);
      page = again._sent as string;
    }
    const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
    const nodes: Record<string, El> = {};
    const chips: El[] = [];
    const markup = page.slice(page.indexOf('<main'), page.indexOf('<script>'));
    for (const tag of markup.matchAll(/<([a-z0-9]+)\b([^<>]*)>([^<]*)/g)) {
      const attrs: Record<string, string> = {};
      for (const a of tag[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '');
      const node = el(attrs, decode(tag[3]));
      if (attrs['data-adapter']) chips.push(node);
      if (attrs.id) nodes[attrs.id] = node;
    }
    nodes['quick-apps'].querySelectorAll = () => chips;

    const clock = { now: 1_000_000 };
    let timers: Array<{ id: number; at: number; f: () => void }> = [];
    let nextId = 1;
    let tick: (() => void) | null = null;
    const copied: string[] = [];
    const assign = jest.fn();
    const route = async (url: string, body: Record<string, unknown>) => {
      const res = makeRes();
      const request = req(opts.header, signed);
      if (url === '/auth/first-app') await f.controller.pickFirstApp(request, body, res);
      else if (url === '/auth/first-app/telegram/status') await f.controller.telegramOneTapStatus(request, body, res);
      else if (url === '/auth/first-app/telegram/token') await f.controller.telegramOneTapToken(request, body, res);
      else throw new Error(`unexpected request to ${url}`);
      signed = signedAfter(res, signed);
      return res._json;
    };
    const fetch = jest.fn(async (url: string, init: { body: string }) => {
      const answer = await route(url, JSON.parse(init.body));
      return { json: async () => answer };
    });
    const setTimeout = (fn: () => void, ms = 0) => {
      timers.push({ id: nextId, at: clock.now + ms, f: fn });
      return nextId++;
    };
    const clearTimeout = (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    };
    const document = { hidden: false, visibilityState: 'visible', getElementById: (id: string) => nodes[id] ?? null, addEventListener() {} };
    const window = {
      fetch,
      JSON,
      setTimeout,
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
      location: { assign },
      URLSearchParams,
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    };
    const navigator = {
      sendBeacon: jest.fn(() => true),
      ...(opts.clipboard === false
        ? {}
        : {
            clipboard: {
              writeText: async (text: string) => {
                copied.push(text);
              },
            },
          }),
    };
    require('vm').runInNewContext(script, {
      document,
      navigator,
      window,
      fetch,
      JSON,
      URLSearchParams,
      encodeURIComponent,
      Date: { now: () => clock.now },
      setTimeout,
      clearTimeout,
    });
    const advance = async (ms: number) => {
      const end = clock.now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock.now = Math.max(clock.now, due.at);
        due.f();
        await flush();
      }
      clock.now = end;
    };
    const chip = (slug: string) => chips.find((c) => c.attrs['data-adapter'] === slug)!;
    const pick = async (slug: string) => {
      fire(chip(slug), 'click');
      await flush();
    };
    const seconds = (n: number) => {
      for (let i = 0; i < n; i++) tick?.();
    };
    return { f, page, nodes, chips, chip, pick, fetch, copied, assign, advance, seconds, document };
  };

  it('German: picking an app says so, and changes the request', async () => {
    const t = await run({ header: GERMAN });
    expect(t.nodes['quick-apps'].hidden).toBe(false);
    expect(t.nodes['example-request'].textContent).toBe('Verbinde meinen Telegram-Bot mit AnythingMCP.');

    fire(t.chip('etsy'), 'click');
    expect(t.nodes['quick-status'].textContent).toBe('Etsy wird hinzugefügt…');
    await flush();
    expect(t.nodes['quick-status'].textContent).toBe('Etsy hinzugefügt – die Einrichtung schließen Sie in Claude ab.');
    expect(t.nodes['example-request'].textContent).toBe('Schließe die Einrichtung meines Etsy-Connectors ab.');
    expect(t.chip('etsy').attrs['aria-pressed']).toBe('true');
  });

  it('German: a pick the server refuses, and one that never arrives', async () => {
    const refused = await run({ header: GERMAN });
    refused.f.provider.install.mockResolvedValueOnce({ isError: true, body: { error: 'limit' } } as any);
    await refused.pick('odoo');
    expect(refused.nodes['quick-status'].textContent).toBe(
      'Odoo konnte gerade nicht hinzugefügt werden. Sie können trotzdem fortfahren und die App im Chat hinzufügen.',
    );
    expect(refused.nodes['example-request'].textContent).toBe('Verbinde meinen Telegram-Bot mit AnythingMCP.');

    const offline = await run({ header: GERMAN });
    offline.fetch.mockRejectedValueOnce(new Error('offline'));
    await offline.pick('printify');
    expect(offline.nodes['quick-status'].textContent).toBe(
      'Printify konnte gerade nicht hinzugefügt werden. Sie können trotzdem fortfahren und die App im Chat hinzufügen.',
    );
  });

  it('German: another app becomes the request, whatever is typed', async () => {
    const t = await run({ header: GERMAN });
    t.nodes['other-app'].value = '  HubSpot   CRM ';
    fire(t.nodes['other-app'], 'input');
    expect(t.nodes['example-request'].textContent).toBe('Verbinde mein HubSpot CRM mit AnythingMCP.');
    // Typed text is text: placeholders, markup and quotes in it mean nothing.
    t.nodes['other-app'].value = '{client} </script> "\' \\ $&';
    fire(t.nodes['other-app'], 'input');
    expect(t.nodes['example-request'].textContent).toBe('Verbinde mein {client} </script> "\' \\ $& mit AnythingMCP.');
    t.nodes['other-app'].value = '';
    fire(t.nodes['other-app'], 'input');
    expect(t.nodes['example-request'].textContent).toBe('Verbinde meinen Telegram-Bot mit AnythingMCP.');
  });

  it('German: "Kopieren & weiter" copies, says so and presses Continue once', async () => {
    const t = await run({ header: GERMAN });
    const pressed: Array<string | undefined> = [];
    t.nodes.continue.addEventListener('click', () => pressed.push(t.nodes.continue.attrs['data-via']));
    expect(t.nodes['copy-request'].textContent).toBe('Kopieren & weiter');
    fire(t.nodes['copy-request'], 'click');
    await flush();
    expect(t.copied[0]).toBe('Verbinde meinen Telegram-Bot mit AnythingMCP.');
    expect(t.nodes['copy-request'].textContent).toBe('Kopiert');
    expect(pressed).toEqual(['copy']);
    // Continue itself copies too, and says where to paste it.
    expect(t.nodes['request-copied'].textContent).toBe('Kopiert. Fügen Sie es in Claude in einen neuen Chat ein.');
    expect(t.nodes['request-copied'].hidden).toBe(false);
    await t.advance(1500);
    expect(pressed).toEqual(['copy']);
  });

  it('Japanese: the same, with the texts of that dictionary', async () => {
    const t = await run({ header: JAPANESE });
    await t.pick('woocommerce');
    expect(t.nodes['quick-status'].textContent).toBe('WooCommerce を追加しました。設定は Claude で完了します。');
    expect(t.nodes['example-request'].textContent).toBe('WooCommerce コネクタの設定を完了してください。');
    fire(t.nodes['copy-request'], 'click');
    await flush();
    expect(t.nodes['copy-request'].textContent).toBe('コピーしました');
    expect(t.nodes['request-copied'].textContent).toBe('コピーしました。Claude の新しいチャットに貼り付けてください。');
  });

  it('German: the app picked before a reload is shown as added', async () => {
    const t = await run({ header: GERMAN, signedExtra: { first_app_picked: 'woocommerce' } });
    expect(t.nodes['quick-status'].textContent).toBe('WooCommerce hinzugefügt – die Einrichtung schließen Sie in Claude ab.');
    expect(t.nodes['example-request'].textContent).toBe('Schließe die Einrichtung meines WooCommerce-Connectors ab.');
  });

  it('a client and an app with quotes, a closing script tag and a backslash in their names', async () => {
    const apps = QUICK_SETUP_APPS as Array<{ slug: string; name: string }>;
    const evil = { slug: 'evil-app', name: 'App"\'</script><u>\\n\\' };
    apps.push(evil);
    try {
      const t = await run({ header: GERMAN, build: { clientName: HOSTILE }, signedExtra: { first_app_picked: 'evil-app' } });
      // The page has one script element, and the names only escaped.
      expect(t.page.match(/<script>/g)).toHaveLength(1);
      expect(t.page.match(/<\/script>/g)).toHaveLength(1);
      expect(t.page).not.toContain('<img src=x');
      expect(t.page).not.toContain('<u>');
      expect(t.page).toContain(`data-client="${HOSTILE_ESCAPED}"`);
      expect(t.page).toContain('data-name="App&quot;&#x27;&lt;/script&gt;&lt;u&gt;\\n\\"');
      // The script reads them back as the text they are.
      expect(t.nodes['quick-status'].textContent).toBe(`${evil.name} hinzugefügt – die Einrichtung schließen Sie in ${HOSTILE} ab.`);
      expect(t.nodes['example-request'].textContent).toBe(`Schließe die Einrichtung meines ${evil.name}-Connectors ab.`);
      fire(t.nodes.continue, 'click');
      await flush();
      expect(t.nodes['request-copied'].textContent).toBe(`Kopiert. Fügen Sie es in ${HOSTILE} in einen neuen Chat ein.`);

      // Picked now, through the server: the answer carries the name as JSON.
      const fresh = await run({ header: JAPANESE, build: { clientName: HOSTILE } });
      await fresh.pick('evil-app');
      expect(fresh.nodes['quick-status'].textContent).toBe(`${evil.name} を追加しました。設定は ${HOSTILE} で完了します。`);
      expect(fresh.nodes['example-request'].textContent).toBe(`${evil.name} コネクタの設定を完了してください。`);
    } finally {
      apps.splice(apps.indexOf(evil), 1);
    }
  });

  describe('the one-tap Telegram panel', () => {
    it('German: waiting, then connected with Start still to press, then done', async () => {
      const t = await run({ header: GERMAN });
      expect(t.nodes['tg-setup'].hidden).toBe(true);
      expect(t.nodes['tg-create'].textContent).toBe('Ihren Telegram-Bot erstellen');
      await t.pick('telegram-bot');
      expect(t.nodes['tg-setup'].hidden).toBe(false);
      expect(t.nodes['tg-create'].attrs.href).toBe('https://t.me/newbot/x');
      expect(t.nodes['tg-status'].textContent).toBe('Warte auf Ihren Bot…');
      expect(t.nodes['quick-status'].textContent).toBe(
        'Telegram hinzugefügt. Erstellen Sie jetzt den Bot, oder fahren Sie fort und schließen Sie die Einrichtung in Claude ab.',
      );
      expect(t.nodes['example-request'].textContent).toBe('Schließe die Einrichtung meines Telegram-Connectors ab.');

      t.f.telegram.status.mockResolvedValue({ state: 'connected', bot: '@amcp_x_bot', startUrl: 'https://t.me/amcp_x_bot' });
      await t.advance(2000);
      expect(t.nodes['tg-status'].textContent).toBe('Telegram ist verbunden: @amcp_x_bot.');
      expect(t.nodes['tg-create'].textContent).toBe('Bot öffnen und auf „Starten“ tippen');
      expect(t.nodes['tg-help'].textContent).toBe('Ihr Bot kann Ihnen schreiben, sobald Sie in seinem Chat auf „Starten“ getippt haben.');
      expect(t.nodes['tg-next'].textContent).toBe(
        'Noch zwei Schritte: Tippen Sie im Chat Ihres Bots auf „Starten“ und dann unten auf „Weiter zu Claude“.',
      );
      expect(t.nodes['first-sub'].textContent).toBe('Telegram ist bereit. Gehen Sie weiter zu Claude und fragen Sie zum Beispiel:');
      expect(t.nodes['example-request'].textContent).toBe('Sende mir eine Testnachricht über Telegram.');

      t.f.telegram.status.mockResolvedValue({ state: 'connected', bot: '@amcp_x_bot' });
      await t.advance(2000);
      expect(t.nodes['tg-next'].textContent).toBe('Letzter Schritt: Tippen Sie unten auf „Weiter zu Claude“.');
      expect(t.nodes['quick-apps'].attrs['data-telegram']).toBe('done');
    });

    it('German: then the page counts down and goes on by itself, unless the person stays', async () => {
      const t = await run({ header: GERMAN });
      await t.pick('telegram-bot');
      t.f.telegram.status.mockResolvedValue({ state: 'connected' });
      await t.advance(2000);
      expect(t.nodes['tg-status'].textContent).toBe('Telegram ist verbunden.');
      expect(t.nodes['auto-continue-stay'].textContent).toBe('Auf dieser Seite bleiben');
      t.seconds(1);
      expect(t.nodes['auto-continue'].hidden).toBe(false);
      expect(t.nodes['auto-continue-text'].textContent).toBe('Telegram ist verbunden. Zurück zu Claude in 5 s…');
      t.seconds(4);
      expect(t.nodes['auto-continue-text'].textContent).toBe('Telegram ist verbunden. Zurück zu Claude in 1 s…');
      expect(t.assign).not.toHaveBeenCalled();
      t.seconds(1);
      expect(t.assign).toHaveBeenCalledWith('http://mcp.test/callback');

      const stays = await run({ header: GERMAN });
      await stays.pick('telegram-bot');
      stays.f.telegram.status.mockResolvedValue({ state: 'connected' });
      await stays.advance(2000);
      stays.seconds(2);
      fire(stays.nodes['auto-continue-stay'], 'click');
      expect(stays.nodes['auto-continue-text'].textContent).toBe('Klicken Sie auf „Weiter zu Claude“, wenn Sie bereit sind.');
      stays.seconds(10);
      expect(stays.assign).not.toHaveBeenCalled();
    });

    it('Japanese: linked account, expired link, and a pasted token', async () => {
      const t = await run({ header: JAPANESE });
      await t.pick('telegram-bot');
      expect(t.nodes['tg-status'].textContent).toBe('ボットを待っています…');
      t.f.telegram.status.mockResolvedValueOnce({ state: 'waiting', claimed: true });
      await t.advance(2000);
      expect(t.nodes['tg-status'].textContent).toBe(
        'Telegram アカウントを連携しました。ボットを作成してください。ユーザー名は何でもかまいません。',
      );

      // A token that is not one never leaves the page.
      t.nodes['tg-token'].value = 'not a token';
      fire(t.nodes['tg-token-form'], 'submit');
      expect(t.nodes['tg-token-status'].textContent).toBe(
        'ボットトークンではないようです。@BotFather から受け取った値全体（例：123456789:AAH...）を貼り付けてください。',
      );
      // One the service refuses: its answer, in the page's language.
      t.f.telegram.saveToken.mockResolvedValueOnce({ ok: false, error: 'Telegram is already connected.' });
      t.nodes['tg-token'].value = `123456789:${'A'.repeat(35)}`;
      fire(t.nodes['tg-token-form'], 'submit');
      expect(t.nodes['tg-token-status'].textContent).toBe('Telegram でトークンを確認しています…');
      await flush();
      expect(t.nodes['tg-token-status'].textContent).toBe('Telegram はすでに接続されています。');
      // And one it accepts.
      fire(t.nodes['tg-token-form'], 'submit');
      await flush();
      expect(t.nodes['tg-status'].textContent).toBe('Telegram を接続しました（@own_bot）。');
      expect(t.nodes['tg-next'].textContent).toBe('最後のステップ：下の「Claude に進む」をタップしてください。');
      expect(t.nodes['example-request'].textContent).toBe('Telegram でテストメッセージを送ってください。');

      const expired = await run({ header: JAPANESE });
      await expired.pick('telegram-bot');
      expired.f.telegram.status.mockResolvedValueOnce({ state: 'expired' });
      await expired.advance(2000);
      expect(expired.nodes['tg-status'].textContent).toBe(
        'このリンクは有効期限が切れました。Claude に戻り、もう一度「接続」を押してください。',
      );
    });
  });

  it('on a phone the panel has no QR code, and its hint says so in the page\'s language', async () => {
    const f = build({ telegram: true });
    const page = (await signIn(f, GERMAN, IPHONE))._sent as string;
    expect(page).toContain(`<p class="tg-hint" id="tg-hint">${TELEGRAM_PANEL_TEXTS.de.linkHint}</p>`);
    expect(page).not.toContain('id="tg-qr-img"');
  });
});
