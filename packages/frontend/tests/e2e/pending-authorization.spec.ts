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
