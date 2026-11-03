import { expect, test, type Page } from '@playwright/test';

/**
 * Someone who signed in on the authorization page to connect Claude is then
 * handed dashboard links by the chat. The sign-in page offers "Continue as …"
 * for that account instead of asking for the password again.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

async function mockApi(page: Page, who: { status: number; body?: unknown }) {
  const calls: string[] = [];
  await page.route(/\/(api|health)\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/auth/recent-sign-in') {
      calls.push(req.method());
      if (req.method() === 'GET') {
        return route.fulfill({ status: who.status, contentType: 'application/json', body: who.body ? JSON.stringify(who.body) : '' });
      }
      if (req.method() === 'POST') {
        expect(req.headers()['x-amcp-dashboard']).toBe('1');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ accessToken: 'token-from-recent-sign-in', user: USER }),
        });
      }
    }
    if (path === '/api/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return calls;
}

test('offers to continue as the account that just signed in, and goes where the link pointed', async ({ page }) => {
  const calls = await mockApi(page, { status: 200, body: { email: 'test@example.com', name: 'Test User' } });

  await page.goto('/login?redirect=%2Fconnectors%2Fc1');

  const button = page.getByRole('button', { name: 'Continue as test@example.com' });
  await expect(button).toBeVisible();
  await button.click();

  await page.waitForURL(/\/connectors\/c1$/, { timeout: 15_000 });
  expect(calls).toEqual(['GET', 'POST']);
  expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBe('token-from-recent-sign-in');
});

test('offers nothing without a recent sign-in', async ({ page }) => {
  await mockApi(page, { status: 204 });

  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('recent-sign-in')).toHaveCount(0);
});
