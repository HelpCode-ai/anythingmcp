import { expect, test } from '@playwright/test';

/**
 * A new workspace (onboarding not completed, no connectors) opening the
 * dashboard is sent to /welcome, where the starter pack is.
 *
 * The redirect used to never fire in practice: the evaluation marked itself
 * done before it ran, `deploymentMode` (from /health/server-info) arrived a
 * moment later and re-ran the effect, the cleanup cancelled the evaluation
 * in flight, and the re-run found it "done". Server info answers late here
 * on purpose, while the onboarding state is still loading, to reproduce that
 * order.
 */

const USER = {
  id: 'u1',
  email: 'new@example.test',
  name: 'New User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

test('a new workspace is sent from the dashboard to /welcome', async ({ page }) => {
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      await new Promise((r) => setTimeout(r, 500));
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'oauth2', hasUsers: true, ssoProviders: [] });
    }
    if (p.endsWith('/users/me/onboarding-state')) {
      // Still in flight when server info lands and re-runs the effect.
      await new Promise((r) => setTimeout(r, 1500));
      return json({ onboardingCompletedAt: null });
    }
    if (p.endsWith('/users/me')) return json(USER);
    if (p.endsWith('/license/status')) return json({ plan: null, status: 'none' });
    if (p.endsWith('/adapters/starter-pack')) return json([]);
    if (p.endsWith('/connectors')) return json([]);
    return json({});
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
});
