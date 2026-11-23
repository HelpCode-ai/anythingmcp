import { expect, test, type Page } from '@playwright/test';
import {
  CLIENT_NAME_MAX,
  displayClientName,
  parsePendingAuthorization,
  pendingAuthorizationPath,
  signUpClientName,
} from '../../src/lib/pending-authorization';

/**
 * The way back to an AI client's unfinished authorization (Cloud).
 *
 * Someone presses "Connect" in Claude and ends up in the dashboard before the
 * connection is finished: to create an account, to add an app first, in a
 * second tab. The backend keeps the authorization for 30 minutes and answers
 * GET /auth/pending; the dashboard shows the way back.
 *
 * The first block tests the pure helpers (no browser). The rest fakes the
 * session and the API as the other specs do; /auth/pending and the two
 * backend pages (/auth/login, /callback) are stubbed too.
 */

const ADMIN = {
  id: 'u1',
  email: 'ada@example.test',
  name: 'Ada',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const UNVERIFIED = { ...ADMIN, id: 'u2', email: 'new@example.test', name: 'New', emailVerified: false };

/** The backend's own pages: never an /api/ path. */
const AUTH_LOGIN_PAGE = /^https?:\/\/[^/]+\/auth\/login(\?.*)?$/;
const CALLBACK_PAGE = /^https?:\/\/[^/]+\/callback(\?.*)?$/;

interface Backend {
  /** How often /auth/pending was asked. */
  asked: () => number;
  /** Change the answer of /auth/pending for the questions that follow. */
  setPending: (answer: unknown) => void;
}

async function mockBackend(
  page: Page,
  opts: {
    cloud?: boolean;
    /** The JSON /auth/pending answers with; 'abort' drops the request. */
    pending?: unknown;
    pendingStatus?: number;
    /** A dashboard session in the browser. */
    signedIn?: boolean;
    /** Extra answers by path, before the defaults. */
    extra?: (path: string, method: string) => { status?: number; json: unknown } | null;
  } = {},
): Promise<Backend> {
  const cloud = opts.cloud ?? true;
  let pending: unknown = opts.pending ?? { pending: false };
  let asked = 0;
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  if (opts.signedIn) {
    await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
    await page.addInitScript((user) => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify(user));
    }, ADMIN);
  }
  await page.route(
    (url) => url.pathname === '/auth/pending',
    (route) => {
      asked += 1;
      if (pending === 'abort') return route.abort();
      return route.fulfill({
        status: opts.pendingStatus ?? 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: typeof pending === 'string' ? pending : JSON.stringify(pending),
      });
    },
  );
  await page.route(AUTH_LOGIN_PAGE, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Allow access</h1>' }),
  );
  await page.route(CALLBACK_PAGE, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Back to the client</h1>' }),
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({
        deploymentMode: cloud ? 'cloud' : 'self-hosted',
        mcpAuthMode: 'oauth2',
        hasUsers: true,
        registrationEnabled: true,
        ssoProviders: [],
        socialProviders: [],
      });
    }
    const extra = opts.extra?.(p, req.method());
    if (extra) return json(extra.json, extra.status ?? 200);
    // A finished onboarding and a paid plan: the dashboard stays where it is.
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) return json({ plan: 'cloud_team', status: 'active', expiresAt: null, features: {} });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Main', role: 'ADMIN', joinedAt: '2026-10-01' }]);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Main', createdAt: '2026-10-01' });
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/adapters/starter-pack')) return json([]);
    if (p.endsWith('/audit/stats')) return json({ invocations24h: 0, errors24h: 0 });
    return json({});
  });
  return {
    asked: () => asked,
    setPending: (answer) => {
      pending = answer;
    },
  };
}

const bar = (page: Page) => page.getByTestId('pending-authorization-bar');

test.describe('pending-authorization helpers', () => {
  test('reads the backend answer and treats anything else as nothing waiting', () => {
    expect(parsePendingAuthorization({ pending: true, client: 'Claude', step: 'allow' })).toEqual({ client: 'Claude', step: 'allow' });
    expect(parsePendingAuthorization({ pending: true, client: 'Claude', step: 'continue' })).toEqual({ client: 'Claude', step: 'continue' });
    expect(parsePendingAuthorization({ pending: true, step: 'allow' })).toEqual({ client: null, step: 'allow' });
    expect(parsePendingAuthorization({ pending: false })).toBeNull();
    expect(parsePendingAuthorization({ pending: 'true', client: 'Claude', step: 'allow' })).toBeNull();
    expect(parsePendingAuthorization({ pending: true, client: 'Claude', step: 'approve' })).toBeNull();
    expect(parsePendingAuthorization({ pending: true, client: 'Claude' })).toBeNull();
    for (const junk of [null, undefined, 'pending', 1, [], {}]) expect(parsePendingAuthorization(junk)).toBeNull();
  });

  test('the way back is one of two fixed backend pages', () => {
    expect(pendingAuthorizationPath('allow')).toBe('/auth/login');
    expect(pendingAuthorizationPath('continue')).toBe('/callback');
  });

  test('a client name is cleaned and cut to 40 characters', () => {
    expect(displayClientName('Claude')).toBe('Claude');
    expect(displayClientName('  Claude \n Desktop\t ')).toBe('Claude Desktop');
    expect(displayClientName('')).toBeNull();
    expect(displayClientName('   ')).toBeNull();
    expect(displayClientName(42)).toBeNull();
    expect(displayClientName({ name: 'Claude' })).toBeNull();
    // Direction overrides could make a name read as something else.
    expect(displayClientName('Clau‮de')).toBe('Clau de');
    const long = displayClientName('A'.repeat(200))!;
    expect(Array.from(long)).toHaveLength(CLIENT_NAME_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(displayClientName('B'.repeat(CLIENT_NAME_MAX))).toBe('B'.repeat(CLIENT_NAME_MAX));
    // Cut by character, not in the middle of one.
    expect(Array.from(displayClientName('😀'.repeat(60))!)).toHaveLength(CLIENT_NAME_MAX);
  });

  test('the sign-up names only the assistants it knows', () => {
    expect(signUpClientName('claude')).toBe('Claude');
    expect(signUpClientName('ChatGPT')).toBe('ChatGPT');
    expect(signUpClientName('muse')).toBe('Meta Muse');
    for (const other of ['other', 'assistant', '<b>x</b>', 'constructor', '', null, undefined]) {
      expect(signUpClientName(other)).toBeNull();
    }
  });
});

test.describe('the "finish connecting" bar', () => {
  test('is not shown when nothing is waiting', async ({ page }) => {
    const backend = await mockBackend(page, { signedIn: true, pending: { pending: false } });
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
    await expect.poll(backend.asked).toBeGreaterThan(0);
    await expect(bar(page)).toHaveCount(0);
  });

  for (const [name, opts] of [
    ['answers 500', { pending: { pending: true, client: 'Claude', step: 'allow' }, pendingStatus: 500 }],
    ['answers 404', { pending: { message: 'Not Found' }, pendingStatus: 404 }],
    ['cannot be reached', { pending: 'abort' }],
    ['answers with something that is not JSON', { pending: '<html>oops</html>' }],
    ['answers with an unknown step', { pending: { pending: true, client: 'Claude', step: 'later' } }],
  ] as const) {
    test(`is not shown when the endpoint ${name}`, async ({ page }) => {
      const backend = await mockBackend(page, { signedIn: true, ...opts });
      await page.goto('/');
      await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
      await expect.poll(backend.asked).toBeGreaterThan(0);
      // Time for the answer to be handled before asserting nothing came of it.
      await page.waitForTimeout(300);
      await expect(bar(page)).toHaveCount(0);
    });
  }

  test('self-hosted never asks and never shows it', async ({ page }) => {
    const backend = await mockBackend(page, {
      cloud: false,
      signedIn: true,
      pending: { pending: true, client: 'Claude', step: 'continue' },
    });
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(backend.asked()).toBe(0);
    await expect(bar(page)).toHaveCount(0);
  });

  test('not allowed yet: "Claude is waiting for you", back to the authorization page', async ({ page }) => {
    await mockBackend(page, { signedIn: true, pending: { pending: true, client: 'Claude', step: 'allow' } });
    await page.goto('/');
    await expect(bar(page)).toBeVisible({ timeout: 15_000 });
    await expect(bar(page)).toContainText('Claude is waiting for you.');
    await bar(page).getByRole('button', { name: 'Back to connecting Claude' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(page.getByRole('heading', { name: 'Allow access' })).toBeVisible();
  });

  test('allowed, only "Continue" missing: "Claude is not connected yet", on to /callback', async ({ page }) => {
    await mockBackend(page, { signedIn: true, pending: { pending: true, client: 'Claude', step: 'continue' } });
    // A return left over from the card-trial detour is spent with it. Seeded
    // once: the page behind /callback must not write it again.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('amcp_card_trial_return', JSON.stringify({ path: '/callback', savedAt: Date.now() }));
    });
    await page.goto('/connectors');
    await expect(bar(page)).toBeVisible({ timeout: 15_000 });
    await expect(bar(page)).toContainText('Claude is not connected yet.');
    // Reachable and usable from the keyboard.
    const action = bar(page).getByRole('button', { name: 'Finish connecting Claude' });
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/callback$/);
    await expect(page.getByRole('heading', { name: 'Back to the client' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('amcp_card_trial_return'))).toBeNull();
  });

  test('without a client name it says "your AI assistant"', async ({ page }) => {
    await mockBackend(page, { signedIn: true, pending: { pending: true, step: 'continue' } });
    await page.goto('/');
    await expect(bar(page)).toContainText('Your AI assistant is not connected yet.', { timeout: 15_000 });
    await expect(bar(page).getByRole('button', { name: 'Finish connecting your AI assistant' })).toBeVisible();
  });

  test('a long, HTML-looking client name is shown as text and cut', async ({ page }) => {
    const raw = '<img src=x onerror="document.title=\'pwned\'"><b>Evil</b> assistant with a very, very long name';
    const shown = displayClientName(raw)!;
    expect(Array.from(shown)).toHaveLength(CLIENT_NAME_MAX);
    await mockBackend(page, { signedIn: true, pending: { pending: true, client: raw, step: 'allow' } });
    await page.goto('/');
    await expect(bar(page)).toBeVisible({ timeout: 15_000 });
    await expect(bar(page).locator('p')).toHaveText(`${shown} is waiting for you.`);
    await expect(bar(page)).toContainText('<img src=x');
    await expect(bar(page).locator('img, b')).toHaveCount(0);
    expect(await page.title()).not.toBe('pwned');
  });

  test('on a 360 px screen it wraps, pushes the page down and adds no scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockBackend(page, {
      signedIn: true,
      pending: { pending: true, client: 'An assistant with quite a long name', step: 'continue' },
    });
    await page.goto('/');
    await expect(bar(page)).toBeVisible({ timeout: 15_000 });
    const action = bar(page).getByRole('button');
    await expect(action).toBeInViewport({ ratio: 1 });
    const box = (await bar(page).boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.width).toBe(360);
    // The page header starts below the bar instead of under it…
    const header = (await page.locator('header').first().boundingBox())!;
    expect(header.y).toBeGreaterThanOrEqual(box.height - 0.5);
    // …and the app shell gave up exactly that height: nothing scrolls.
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
  });

  test('is hidden on the sign-up an authorization page opened, shown on a plain sign-in', async ({ page }) => {
    const backend = await mockBackend(page, { pending: { pending: true, client: 'Claude', step: 'allow' } });
    await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin&client=claude');
    await expect(page.getByRole('heading', { name: 'Create your free account' })).toBeVisible({ timeout: 15_000 });
    await expect.poll(backend.asked).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(bar(page)).toHaveCount(0);

    await page.goto('/login');
    await expect(bar(page)).toBeVisible({ timeout: 15_000 });
    await expect(bar(page).getByRole('button', { name: 'Back to connecting Claude' })).toBeVisible();
  });

  test('is hidden on the card-trial page while that page returns to the authorization', async ({ page }) => {
    const trialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const backend = await mockBackend(page, {
      signedIn: true,
      pending: { pending: true, client: 'Claude', step: 'continue' },
      extra: (p) => {
        if (p.endsWith('/license/status')) {
          return { json: { plan: 'trial', status: 'active', expiresAt: trialEnd, trialDaysLeft: 5, features: {} } };
        }
        if (p.endsWith('/license/card-trial-eligibility')) return { json: { kind: 'trial', trialEndsAt: trialEnd } };
        if (p === '/api/price-estimate') return { json: { currency: null, vat: true } };
        return null;
      },
    });
    await page.addInitScript(() => localStorage.setItem('amcp_card_trial_prompt:u1', 'shown'));
    await page.goto('/start-trial?source=post_approve&return=%2Fcallback');
    await expect(page.getByText('Either way, you go straight back')).toBeVisible({ timeout: 15_000 });
    await expect.poll(backend.asked).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(bar(page)).toHaveCount(0);
  });

  test('appears when the tab comes back and an authorization is waiting by then', async ({ page }) => {
    const backend = await mockBackend(page, { signedIn: true, pending: { pending: false } });
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
    await expect.poll(backend.asked).toBeGreaterThan(0);
    await expect(bar(page)).toHaveCount(0);

    backend.setPending({ pending: true, client: 'Claude', step: 'continue' });
    const before = backend.asked();
    // Several returns in a row are one question, and not before 5 s are over.
    for (let i = 0; i < 5; i += 1) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(bar(page)).toBeVisible({ timeout: 10_000 });
    expect(backend.asked() - before).toBeLessThanOrEqual(2);
  });
});

test.describe('the sign-up inside an authorization', () => {
  test('says it is step 1 of 2 and names the client', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin&client=claude');
    await expect(page.getByTestId('authorization-step')).toHaveText(
      'Step 1 of 2. Create your account, then you go straight back to finish connecting Claude.',
      { timeout: 15_000 },
    );
  });

  test('a client it does not know is "your AI assistant", never the value from the address', async ({ page }) => {
    await mockBackend(page);
    await page.goto(`/login?mode=register&redirect=%2Fauth%2Flogin&client=${encodeURIComponent('<b>Evil</b>')}`);
    await expect(page.getByTestId('authorization-step')).toHaveText(
      'Step 1 of 2. Create your account, then you go straight back to finish connecting your AI assistant.',
      { timeout: 15_000 },
    );
    await expect(page.getByText('Evil')).toHaveCount(0);
  });

  for (const query of ['?mode=register', '?mode=register&redirect=%2Fconnectors', '?redirect=%2Fauth%2Flogin']) {
    test(`shows no step line on /login${query}`, async ({ page }) => {
      await mockBackend(page);
      await page.goto(`/login${query}`);
      await expect(page.locator('#auth-email')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('authorization-step')).toHaveCount(0);
    });
  }
});

test.describe('the email code step of that sign-up', () => {
  /** Signs up through the form; the account's address is not verified yet. */
  async function signUpToCodeStep(page: Page) {
    await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin&client=claude');
    await page.locator('#auth-name').fill('New');
    await page.locator('#auth-email').fill(UNVERIFIED.email);
    await page.locator('#auth-password').fill('Str0ng!passw0rd');
    await page.locator('#auth-confirm-password').fill('Str0ng!passw0rd');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /^Start free trial/ }).click();
    await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible({ timeout: 15_000 });
  }

  /**
   * "Resend code" waits 60 seconds after the first code. Needs
   * `page.clock.install()` before the page loads: the countdown is a chain of
   * one-second timers, run here one at a time.
   */
  async function waitOutResendCountdown(page: Page) {
    const resend = page.getByRole('button', { name: /^Resend/ });
    for (let i = 0; i < 200 && (await resend.isDisabled()); i += 1) await page.clock.runFor(1000);
    await expect(resend).toHaveText('Resend code');
  }

  /** Cloud's sign-up: no session from /register, one from the sign-in that follows. */
  const signUpAnswers = (p: string, method: string) => {
    if (p === '/api/auth/register' && method === 'POST') return { json: { verificationRequired: true } };
    if (p === '/api/auth/login' && method === 'POST') return { json: { accessToken: 'new-token', user: UNVERIFIED } };
    return null;
  };

  test('"I opened the link in the email" goes back to the authorization once the address is verified', async ({ page }) => {
    let verifyCalls = 0;
    await mockBackend(page, {
      extra: (p, method) => {
        if (p === '/api/auth/verify-email') verifyCalls += 1;
        if (p === '/api/users/me') return { json: { ...UNVERIFIED, emailVerified: true } };
        return signUpAnswers(p, method);
      },
    });
    await signUpToCodeStep(page);
    await page.getByRole('button', { name: 'I opened the link in the email' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Allow access' })).toBeVisible();
    // Signed in to the dashboard on the way, without a code being spent.
    expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBe('new-token');
    expect(verifyCalls).toBe(0);
  });

  for (const [name, me] of [
    ['an account that is not verified yet', { json: { ...UNVERIFIED, emailVerified: false } }],
    // Cloud refuses an unverified account everything but the verification endpoints.
    ['Cloud refusing the unverified account', { status: 403, json: { statusCode: 403, message: 'Email verification required' } }],
  ] as const) {
    test(`"I opened the link in the email" says so for ${name}`, async ({ page }) => {
      await mockBackend(page, {
        extra: (p, method) => (p === '/api/users/me' ? me : signUpAnswers(p, method)),
      });
      await signUpToCodeStep(page);
      await page.getByRole('button', { name: 'I opened the link in the email' }).click();
      await expect(
        page.getByText('This address is not verified yet. Open the link in the email or enter the code.'),
      ).toBeVisible();
      // Still the code step, and the code can still be entered.
      await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
      await expect(page.getByPlaceholder('000000')).toBeEditable();
      expect(new URL(page.url()).pathname).toBe('/login');
      expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBeNull();
    });
  }

  test('a check that fails says to try again', async ({ page }) => {
    await mockBackend(page, {
      extra: (p, method) =>
        p === '/api/users/me' ? { status: 503, json: { message: 'Service Unavailable' } } : signUpAnswers(p, method),
    });
    await signUpToCodeStep(page);
    await page.getByRole('button', { name: 'I opened the link in the email' }).click();
    await expect(page.getByText('We could not check this right now. Please try again.')).toBeVisible();
  });

  test('"Resend code" answered "already verified" goes on instead of promising a new code', async ({ page }) => {
    await mockBackend(page, {
      extra: (p, method) => {
        if (p === '/api/auth/resend-verification') return { json: { message: 'Email is already verified' } };
        return signUpAnswers(p, method);
      },
    });
    // On the test's clock from the start, so the countdown below can be run.
    await page.clock.install();
    await signUpToCodeStep(page);
    await waitOutResendCountdown(page);
    await page.getByRole('button', { name: 'Resend code' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    await expect(page.getByText('A new code has been sent to your email')).toHaveCount(0);
  });

  test('"Resend code" that did send a code still says so', async ({ page }) => {
    await mockBackend(page, {
      extra: (p, method) => {
        if (p === '/api/auth/resend-verification') return { json: { message: 'Verification code resent' } };
        return signUpAnswers(p, method);
      },
    });
    await page.clock.install();
    await signUpToCodeStep(page);
    await waitOutResendCountdown(page);
    await page.getByRole('button', { name: 'Resend code' }).click();
    await expect(page.getByText('A new code has been sent to your email')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('a right code still goes back to the authorization', async ({ page }) => {
    await mockBackend(page, {
      extra: (p, method) => {
        if (p === '/api/auth/verify-email') return { json: { message: 'Email verified successfully', emailVerified: true } };
        return signUpAnswers(p, method);
      },
    });
    await signUpToCodeStep(page);
    await page.getByPlaceholder('000000').fill('123456');
    await page.getByRole('button', { name: 'Verify Email' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
  });
});

test.describe('the link from the verification email', () => {
  const verified = (p: string) => (p === '/api/auth/verify-email-link' ? { json: { ok: true } } : null);

  test('with an authorization waiting, the way on is "Continue connecting Claude"', async ({ page }) => {
    await mockBackend(page, { pending: { pending: true, client: 'Claude', step: 'allow' }, extra: verified });
    await page.goto('/verify-email?token=abc');
    const go = page.getByRole('link', { name: 'Continue connecting Claude' });
    await expect(go).toBeVisible({ timeout: 15_000 });
    await expect(go).toHaveAttribute('href', '/login?emailVerified=true&redirect=%2Fauth%2Flogin');
    await expect(page.getByRole('link', { name: 'Go to Sign In' })).toHaveCount(0);
    await go.click();
    await expect(page).toHaveURL(/\/login\?emailVerified=true&redirect=%2Fauth%2Flogin$/);
    await expect(page.getByText('Email verified', { exact: false }).first()).toBeVisible();
  });

  test('without a client name it says "your AI assistant"', async ({ page }) => {
    await mockBackend(page, { pending: { pending: true, step: 'allow' }, extra: verified });
    await page.goto('/verify-email?token=abc');
    await expect(page.getByRole('link', { name: 'Continue connecting your AI assistant' })).toBeVisible({ timeout: 15_000 });
  });

  test('with nothing waiting it stays "Go to Sign In", with a hint for another device', async ({ page }) => {
    const backend = await mockBackend(page, { pending: { pending: false }, extra: verified });
    await page.goto('/verify-email?token=abc');
    const go = page.getByRole('link', { name: 'Go to Sign In' });
    await expect(go).toBeVisible({ timeout: 15_000 });
    await expect(go).toHaveAttribute('href', '/login?emailVerified=true');
    await expect(
      page.getByText('Started on another device or in another tab? Go back there and choose “I opened the link in the email”.'),
    ).toBeVisible();
    await expect(page.getByTestId('continue-connecting')).toHaveCount(0);
    expect(backend.asked()).toBeGreaterThan(0);
  });

  test('self-hosted keeps "Go to Sign In" and never asks', async ({ page }) => {
    const backend = await mockBackend(page, {
      cloud: false,
      pending: { pending: true, client: 'Claude', step: 'allow' },
      extra: verified,
    });
    await page.goto('/verify-email?token=abc');
    await expect(page.getByRole('link', { name: 'Go to Sign In' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('continue-connecting')).toHaveCount(0);
    expect(backend.asked()).toBe(0);
  });

  test('a link that fails keeps its error and "Back to Sign In"', async ({ page }) => {
    await mockBackend(page, {
      pending: { pending: true, client: 'Claude', step: 'allow' },
      extra: (p) =>
        p === '/api/auth/verify-email-link'
          ? { status: 400, json: { statusCode: 400, message: 'This link has already been used' } }
          : null,
    });
    await page.goto('/verify-email?token=abc');
    await expect(page.getByText('This link has already been used')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Back to Sign In' })).toBeVisible();
    await expect(page.getByTestId('continue-connecting')).toHaveCount(0);
  });
});
