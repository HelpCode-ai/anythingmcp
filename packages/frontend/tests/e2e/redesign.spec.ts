import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke tests for the redesign (sidebar app shell + theme toggle).
 *
 * The authenticated app is behind a client-side auth gate (AuthProvider),
 * so we fake a session: seed localStorage with a token + user before any
 * page script runs, and stub every /api/* call the shell + dashboard make.
 * No backend required — backend-dependent behavior is covered by
 * scripts/smoke-test/run.sh.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function fakeSession(page: Page) {
  // proxy.ts (Next middleware) redirects to /login server-side unless the
  // amcp_token COOKIE is present — set it before navigating.
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  // Seed the client session (localStorage) before the app's bootstrap effect reads it.
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  // Stub the API surface the shell + dashboard touch on first paint.
  // playwright.config.ts pins NEXT_PUBLIC_API_URL='' so these are same-origin.
  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    if (url.includes('/api/audit/stats')) return json({ invocations24h: 0, errors24h: 0 });
    if (url.includes('/api/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    return json({});
  });
}

test.describe('redesign shell', () => {
  test('dashboard renders the sidebar with grouped navigation', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/');

    // Brand mark in the sidebar.
    await expect(page.getByText('Anything', { exact: false }).first()).toBeVisible();

    // Grouped nav links from the redesign.
    const aside = page.locator('aside');
    await expect(aside.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(aside.getByRole('link', { name: 'Connectors' })).toBeVisible();
    await expect(aside.getByRole('link', { name: 'MCP Servers' })).toBeVisible();
    await expect(aside.getByRole('link', { name: 'Knowledge Graph' })).toBeVisible();

    // Group labels.
    await expect(aside.getByText('Overview', { exact: true })).toBeVisible();
    await expect(aside.getByText('Build', { exact: true })).toBeVisible();
  });

  test('theme toggle switches the dark class on <html>', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/');

    const html = page.locator('html');
    const wasDark = await html.evaluate((el) => el.classList.contains('dark'));

    await page.getByRole('button', { name: 'Toggle theme' }).click();

    if (wasDark) {
      await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    } else {
      await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    }
  });
});
