import { expect, test, type Page } from '@playwright/test';

/**
 * A browser that still holds a session the backend no longer accepts (it
 * expired, or its account was deleted). Every authenticated request answers
 * 401 and the session is forgotten.
 *
 * Regression: the 401 used to send every page to a bare /login. On the
 * sign-up an AI client's authorization page opens ("Create an account":
 * /login?mode=register&redirect=/auth/login) that dropped the redirect, so the
 * new account finished on the dashboard (card-trial offer, welcome wizard)
 * instead of back in the authorization, and the client was never connected.
 */
const STALE_USER = { id: 'gone', email: 'gone@example.test', name: 'Gone', role: 'ADMIN', organizationId: 'o1' };

async function staleSession(page: Page, onStart?: (body: any) => void) {
  await page.addInitScript((user) => {
    // Seed once: a later sign-in in the same test must not be overwritten.
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('amcp_token', 'stale-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, STALE_USER);
  await page.route('https://github.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>GitHub</h1>' }),
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/health/server-info') {
      return route.fulfill({
        json: {
          deploymentMode: 'cloud',
          mcpAuthMode: 'oauth2',
          hasUsers: true,
          registrationEnabled: true,
          ssoProviders: [],
          socialProviders: [{ id: 'github', name: 'GitHub' }],
        },
      });
    }
    if (p === '/api/auth/social/start') {
      onStart?.(req.postDataJSON());
      return route.fulfill({ json: { authorizationUrl: 'https://github.com/login/oauth/authorize?state=x' } });
    }
    if ((req.headers()['authorization'] ?? '').includes('stale-token')) {
      return route.fulfill({ status: 401, json: { statusCode: 401, message: 'Unauthorized' } });
    }
    return route.fulfill({ json: {} });
  });
}

test.describe('a session the backend no longer accepts', () => {
  test('the sign-up from an authorization page keeps its redirect and mode', async ({ page }) => {
    let started: any = null;
    await staleSession(page, (b) => (started = b));
    await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin&client=claude');

    // The saved session is checked and refused…
    await expect.poll(() => page.evaluate(() => localStorage.getItem('amcp_token'))).toBeNull();
    // …and the page stays the sign-up, with the way back to the authorization.
    expect(new URL(page.url()).search).toBe('?mode=register&redirect=%2Fauth%2Flogin&client=claude');
    await expect(page.getByRole('button', { name: 'Continue with email' })).toBeVisible();

    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    await page.waitForURL((url) => url.host === 'github.com');
    expect(started).toMatchObject({ provider: 'github', redirect: '/auth/login' });
  });

  test('a dashboard page sends to sign-in and comes back to the same page', async ({ page }) => {
    await staleSession(page);
    await page.goto('/connectors?tab=mine');
    await page.waitForURL(/\/login\?redirect=%2Fconnectors%3Ftab%3Dmine$/, { timeout: 15_000 });
  });
});
