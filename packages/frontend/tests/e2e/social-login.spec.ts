import { expect, test, type Page } from '@playwright/test';

/**
 * Cloud social sign-in (Google, Microsoft, GitHub) on /login and in Settings.
 * The provider round trip itself happens on the backend; here the API is
 * mocked and the provider URL is never actually opened.
 */
const USER = { id: 'u1', email: 'a@example.test', name: 'A', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
const PROVIDERS = [
  { id: 'google', name: 'Google' },
  { id: 'microsoft', name: 'Microsoft' },
  { id: 'github', name: 'GitHub' },
];

function serverInfo(cloud: boolean) {
  return {
    deploymentMode: cloud ? 'cloud' : 'self-hosted',
    mcpAuthMode: 'oauth2',
    hasUsers: true,
    registrationEnabled: true,
    ssoProviders: [],
    socialProviders: cloud ? PROVIDERS : [],
  };
}

async function mockApi(
  page: Page,
  opts: { cloud?: boolean; onStart?: (body: any) => void; exchange?: object; extra?: (p: string) => object | null } = {},
) {
  // The provider is never contacted: hold any navigation to it.
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Google</h1>' }),
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/health/server-info') return route.fulfill({ json: serverInfo(opts.cloud ?? true) });
    if (p === '/api/auth/social/start') {
      opts.onStart?.(route.request().postDataJSON());
      return route.fulfill({ json: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x' } });
    }
    if (p === '/api/auth/social/exchange') {
      return route.fulfill({ json: opts.exchange ?? { accessToken: 't', user: USER, isNewUser: false } });
    }
    const extra = opts.extra?.(p);
    if (extra) return route.fulfill({ json: extra });
    // An active licence, so the licence wall never covers the page.
    if (p.endsWith('/license/status')) {
      return route.fulfill({ json: { plan: 'team', status: 'active', expiresAt: null, features: {} } });
    }
    return route.fulfill({ json: {} });
  });
}

test.describe('social sign-in on /login', () => {
  test('cloud offers the configured providers on sign-in and sign-up', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');
    const box = page.getByTestId('social-providers');
    await expect(box.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(box.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
    await expect(box.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();

    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('social-providers')).toContainText('By continuing you accept the');
  });

  test('sign-up leads with the providers and folds the email form', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login?mode=register');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.locator('#auth-email')).toBeHidden();
    await page.getByRole('button', { name: 'Continue with email' }).click();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.getByText('Email', { exact: true })).toBeVisible();
  });

  test('sign-in keeps the email form open next to the providers', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.locator('#auth-email')).toBeVisible();
  });

  test('self-hosted shows no social buttons', async ({ page }) => {
    await mockApi(page, { cloud: false });
    await page.goto('/login');
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.getByTestId('social-providers')).toHaveCount(0);
  });

  test('a click starts the round trip with the redirect and goes to the provider', async ({ page }) => {
    let started: any = null;
    await mockApi(page, { onStart: (b) => (started = b) });
    await page.goto('/login?redirect=%2Fconnectors');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.waitForURL((url) => url.host === 'accounts.google.com');
    expect(started).toMatchObject({ provider: 'google', redirect: '/connectors' });
  });

  test('the one-time code from the callback signs in and follows the redirect', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login?social=code-1&redirect=%2Fconnectors%2Fstore');
    await page.waitForURL(/\/connectors\/store$/, { timeout: 15_000 });
  });

  test('a new workspace runs the licence step like a password sign-up', async ({ page }) => {
    let trialCalls = 0;
    await mockApi(page, {
      exchange: { accessToken: 't', user: USER, isNewUser: true, needsLicenseSetup: true },
      extra: (p) => {
        if (p.endsWith('/license/activate-trial') || p.endsWith('/license/trial')) {
          trialCalls += 1;
          return { trialStarted: true, trialDaysLeft: 7, plan: 'cloud_trial', expiresAt: null };
        }
        return null;
      },
    });
    await page.goto('/login?social=code-2');
    await expect.poll(() => trialCalls, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('a spent code in an already signed-in browser goes on instead of showing an error', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
    await page.addInitScript((user) => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify(user));
    }, USER);
    await mockApi(page, {
      extra: (p) => (p === '/api/users/me' ? USER : null),
    });
    await page.route('**/api/auth/social/exchange', (route) =>
      route.fulfill({ status: 401, json: { statusCode: 401, message: 'This sign-in link has expired. Please try again.' } }),
    );
    await page.goto('/login?social=spent&redirect=%2Fconnectors');
    await page.waitForURL(/\/connectors$/, { timeout: 15_000 });
  });

  test('the code is taken out of the address bar before it is spent', async ({ page }) => {
    let urlDuringExchange = '';
    await mockApi(page);
    await page.route('**/api/auth/social/exchange', async (route) => {
      urlDuringExchange = page.url();
      return route.fulfill({ status: 401, json: { statusCode: 401, message: 'This sign-in link has expired. Please try again.' } });
    });
    await page.goto('/login?social=code-3');
    await expect(page.getByText('This sign-in link has expired. Please try again.')).toBeVisible();
    expect(urlDuringExchange).not.toContain('social=');
    expect(page.url()).not.toContain('social=');
  });

  test('a refused sign-in shows the message from the callback', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/login?error=${encodeURIComponent('Sign-in was cancelled.')}`);
    await expect(page.getByText('Sign-in was cancelled.')).toBeVisible();
  });
});

test.describe('sign-in methods in Settings', () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    await context.addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
    await page.addInitScript((user) => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify(user));
    }, USER);
  });

  test('lists the providers and offers a password to a passwordless account', async ({ page }) => {
    await mockApi(page, {
      extra: (p) =>
        p === '/api/auth/social/identities'
          ? {
              hasPassword: false,
              providers: [
                { id: 'google', name: 'Google', connected: true, email: 'a@example.test', connectedAt: null, lastLoginAt: null },
                { id: 'github', name: 'GitHub', connected: false, email: null, connectedAt: null, lastLoginAt: null },
              ],
            }
          : p === '/api/users/me'
            ? USER
            : null,
    });
    await page.goto('/settings');
    const card = page.getByTestId('sign-in-methods');
    await expect(card).toContainText('a@example.test');
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Set a password' })).toBeVisible();
  });

  test('a passwordless account deletes without a password, after a fresh sign-in', async ({ page }) => {
    let deleteBody: any = null;
    await mockApi(page, {
      extra: (p) =>
        p === '/api/auth/social/identities'
          ? {
              hasPassword: false,
              providers: [
                { id: 'google', name: 'Google', connected: true, email: 'a@example.test', connectedAt: null, lastLoginAt: null },
              ],
            }
          : p === '/api/users/me'
            ? USER
            : null,
    });
    await page.route('**/api/users/me', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      deleteBody = route.request().postDataJSON();
      return route.fulfill({
        status: 403,
        json: { statusCode: 403, code: 'reauth_required', message: 'For your security, sign in again to confirm.' },
      });
    });
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.locator('input[type="text"]').fill('DELETE');
    await dialog.getByRole('button', { name: 'Delete my account' }).click();
    await expect(dialog.getByRole('button', { name: 'Sign in again with Google' })).toBeVisible();
    expect(deleteBody).toEqual({ confirm: 'DELETE' });
  });
});
