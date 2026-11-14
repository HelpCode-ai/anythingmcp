import { expect, test, type Page } from '@playwright/test';

/**
 * Deleting a Cloud workspace that still has a subscription Stripe would
 * charge is refused (409 `active_subscription`). The dialog then explains why
 * and offers a button that opens Stripe's cancellation page for that
 * workspace; any other refusal still shows as plain text.
 */

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const WORKSPACE = 'Acme Shop';
const CANCEL_URL = 'https://billing.example.test/cancel';

async function cloudSession(page: Page, deleteAnswer: { status: number; body: unknown }) {
  const posted: { path: string; body: unknown }[] = [];
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, ADMIN);
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (req.method() === 'DELETE' && p.endsWith('/organizations/current')) {
      posted.push({ path: p, body: req.postDataJSON() });
      return json(deleteAnswer.body, deleteAnswer.status);
    }
    if (req.method() === 'POST' && p.endsWith('/license/billing-portal')) {
      posted.push({ path: p, body: req.postDataJSON() });
      return json({ url: CANCEL_URL });
    }
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: WORKSPACE, createdAt: new Date().toISOString() });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: WORKSPACE, role: 'ADMIN', joinedAt: new Date().toISOString() }]);
    if (p.endsWith('/license/refresh')) return json({ refreshed: false });
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) return json({ plan: 'starter', status: 'active', expiresAt: null, features: {} });
    if (p.endsWith('/license/usage')) {
      return json({ plan: 'starter', connectors: { current: 1, max: 5, isOver: false }, mcpServers: { current: 1, max: 3, isOver: false }, users: { current: 1, max: 1, isOver: false }, isOverAny: false });
    }
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/mcp-servers')) return json([]);
    return json({});
  });
  await page.context().route('https://billing.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Cancellation page stub</h1>' }),
  );
  return { posted };
}

async function tryToDelete(page: Page) {
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'Delete this organization' }).click({ timeout: 15_000 });
  await page.getByPlaceholder(WORKSPACE).fill(WORKSPACE);
  await page.getByRole('button', { name: 'Delete organization' }).click();
}

test.describe('Deleting a workspace with a live subscription (cloud)', () => {
  test('explains the refusal and opens Stripe’s cancellation page', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      status: 409,
      body: {
        statusCode: 409,
        code: 'active_subscription',
        message: 'This workspace has an active subscription. Cancel it first.',
        organizations: [{ id: 'o1', name: WORKSPACE }],
      },
    });
    await tryToDelete(page);

    await expect(page.getByText('Cancel the subscription first')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel subscription' }).click();
    await expect(page).toHaveURL(CANCEL_URL);

    const portal = posted.find((p) => p.path.endsWith('/license/billing-portal'));
    expect(portal?.body).toMatchObject({ flow: 'cancel' });
    expect((portal?.body as { returnUrl: string }).returnUrl).toMatch(/\/settings\/organization$/);
  });

  test('any other refusal still shows its message', async ({ page }) => {
    await cloudSession(page, { status: 403, body: { statusCode: 403, message: 'Only org admins can delete the organization' } });
    await tryToDelete(page);
    await expect(page.getByText('Only org admins can delete the organization')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);
  });
});
