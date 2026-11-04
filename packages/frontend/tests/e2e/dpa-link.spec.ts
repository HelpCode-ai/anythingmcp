import { expect, test, type Page } from '@playwright/test';

/**
 * Settings → License → "Data Processing Agreement": paid Cloud plans get a
 * button that asks the backend for a one-hour link to the self-service DPA on
 * the licence site and opens it in a new tab. Trials get no DPA card.
 */

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const DPA_URL = 'https://dpa.example.test/dpa#session=abc';

async function cloudSession(page: Page, plan: string) {
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
    if (req.method() === 'POST' && p.endsWith('/license/dpa-link')) {
      posted.push({ path: p, body: req.postDataJSON() });
      return json({ url: DPA_URL });
    }
    if (p.endsWith('/license/refresh')) return json({ refreshed: false });
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) {
      return json({ plan, status: 'active', expiresAt: plan === 'trial' ? new Date(Date.now() + 5 * 86_400_000).toISOString() : null, features: {} });
    }
    if (p.endsWith('/license/usage')) {
      return json({ plan, connectors: { current: 1, max: 15, isOver: false }, mcpServers: { current: 1, max: 10, isOver: false }, users: { current: 1, max: 3, isOver: false }, isOverAny: false });
    }
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/mcp-servers')) return json([]);
    return json({});
  });
  await page.context().route('https://dpa.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>DPA page stub</h1>' }),
  );
  return { posted };
}

test.describe('Data Processing Agreement (cloud)', () => {
  test('a paid plan opens the DPA page from the licence site in a new tab', async ({ page }) => {
    const { posted } = await cloudSession(page, 'team');
    await page.goto('/settings/license');
    await expect(page.getByRole('heading', { name: 'Data Processing Agreement' })).toBeVisible({ timeout: 15_000 });

    const [tab] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Open the DPA' }).click(),
    ]);
    await expect(tab).toHaveURL(DPA_URL);
    expect(posted).toEqual([{ path: '/api/license/dpa-link', body: { locale: 'en' } }]);
  });

  test('a trial has no DPA card', async ({ page }) => {
    await cloudSession(page, 'trial');
    await page.goto('/settings/license');
    await expect(page.getByRole('heading', { name: 'License' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Data Processing Agreement' })).toHaveCount(0);
  });
});
