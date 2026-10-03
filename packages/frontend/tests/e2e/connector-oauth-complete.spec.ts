import { expect, test, type Page } from '@playwright/test';

/**
 * "Authorize with Provider" completes in the dashboard: the backend callback
 * only forwards code + state here, and this page exchanges them in an
 * authenticated request, so the server can refuse a user other than the one
 * who started the authorization.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function mockApi(page: Page, complete: { status: number; body: unknown }) {
  const posts: unknown[] = [];
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/mcp-oauth/complete') && req.method() === 'POST') {
      posts.push({ body: req.postDataJSON(), auth: req.headers()['authorization'] });
      return json(complete.body, complete.status);
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors/c1')) return json({ id: 'c1', name: 'Etsy', type: 'REST', authType: 'OAUTH2', tools: [], isActive: true });
    if (url.includes('/api/connectors')) return json([]);
    return json({});
  });
  return posts;
}

async function signIn(page: Page) {
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
}

test('exchanges the code as the signed-in user and lands where the flow asked', async ({ page }) => {
  await signIn(page);
  const posts = await mockApi(page, {
    status: 200,
    body: { connectorId: 'c1', toolsImported: 0, returnTo: '/connectors/c1?oauth=success&tools=0' },
  });
  await page.goto('/connectors/oauth/complete?state=st-1&code=co-1');
  await expect(page).toHaveURL(/\/connectors\/c1/);
  expect(posts).toEqual([{ body: { state: 'st-1', code: 'co-1' }, auth: 'Bearer test-token' }]);
});

test('shows the server refusal instead of a success', async ({ page }) => {
  await signIn(page);
  await mockApi(page, {
    status: 403,
    body: { statusCode: 403, message: 'This authorization was started by another account.' },
  });
  await page.goto('/connectors/oauth/complete?state=st-1&code=co-1');
  await expect(page.locator('p[role="alert"]')).toContainText('started by another account');
  // The code does not stay in the address bar.
  await expect(page).toHaveURL(/\/connectors\/oauth\/complete$/);
});

test('explains an error the provider returned, with a way back', async ({ page }) => {
  await signIn(page);
  const posts = await mockApi(page, { status: 200, body: {} });
  await page.goto('/connectors/oauth/complete?error=The+authorization+was+cancelled+at+the+provider.&connectorId=c1');
  await expect(page.locator('p[role="alert"]')).toContainText('cancelled at the provider');
  await expect(page.getByRole('link', { name: 'Back to the connector' })).toHaveAttribute('href', '/connectors/c1');
  expect(posts).toHaveLength(0);
});

test('sends a signed-out visitor to sign in first, keeping the code', async ({ page }) => {
  const posts = await mockApi(page, { status: 200, body: {} });
  await page.goto('/connectors/oauth/complete?state=st-1&code=co-1');
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const redirect = new URL(page.url()).searchParams.get('redirect');
  expect(redirect).toBe('/connectors/oauth/complete?state=st-1&code=co-1');
  expect(posts).toHaveLength(0);
});
