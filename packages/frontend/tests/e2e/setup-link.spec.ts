import { expect, test, type Page } from '@playwright/test';

/**
 * One-time links an AI client hands out ("open this to finish connecting
 * Etsy"): /s/<token> resolves the token for the signed-in user and moves on to
 * the guided setup; a used, expired or foreign link says so.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

async function signIn(page: Page) {
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
}

async function mockApi(page: Page, resolve: { status: number; body: unknown }) {
  const resolved: any[] = [];
  await page.route(/\/(api|health)\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/setup-links/resolve') {
      resolved.push(req.postDataJSON());
      return route.fulfill({ status: resolve.status, contentType: 'application/json', body: JSON.stringify(resolve.body) });
    }
    if (path === '/api/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return resolved;
}

test('a valid link leads to the guided setup of its connector', async ({ page }) => {
  await signIn(page);
  const resolved = await mockApi(page, {
    status: 200,
    body: { redirect: '/connectors/setup/etsy?connector=c1&from=claude' },
  });

  await page.goto('/s/tok_abc123');

  await page.waitForURL(/\/connectors\/setup\/etsy\?connector=c1&from=claude$/, { timeout: 15_000 });
  expect(resolved).toEqual([{ token: 'tok_abc123' }]);
});

test('a used or expired link says so instead of opening anything', async ({ page }) => {
  await signIn(page);
  await mockApi(page, {
    status: 410,
    body: { statusCode: 410, message: 'This link was already used. Ask for a new one in the chat.' },
  });

  await page.goto('/s/tok_used');

  await expect(page.getByRole('heading', { name: 'This link does not work any more' })).toBeVisible();
  await expect(page.getByText('This link was already used.')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/s/tok_used');
});

test('signed out, it asks to sign in and comes back to the link', async ({ page }) => {
  await mockApi(page, { status: 200, body: { redirect: '/connectors' } });

  await page.goto('/s/tok_abc123');

  await page.waitForURL(/\/login\?redirect=/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/s/tok_abc123');
});
