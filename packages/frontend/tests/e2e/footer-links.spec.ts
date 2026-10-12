import { test, expect, type Page } from '@playwright/test';

/**
 * Admins save footer links per workspace. The footer used to read only the
 * instance-wide list from the public route, so on Cloud a workspace's own links
 * never appeared. Signed in, it now asks for the workspace's links.
 */

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function session(page: Page, opts: { workspaceLinks: unknown; publicLinks: unknown; workspaceStatus?: number }) {
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, ADMIN);
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/api/settings/footer-links')) return json(opts.workspaceLinks, opts.workspaceStatus ?? 200);
    if (p.endsWith('/api/site-settings/footer-links')) return json(opts.publicLinks);
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) return json({ plan: 'cloud_team', status: 'active', expiresAt: null, features: {} });
    if (p.endsWith('/connectors') || p.endsWith('/adapters')) return json([]);
    return json({});
  });
}

test('a signed-in member sees their workspace footer links', async ({ page }) => {
  await session(page, {
    workspaceLinks: [{ label: 'Acme privacy', url: 'https://acme.test/privacy' }],
    publicLinks: [{ label: 'Instance imprint', url: 'https://instance.test/imprint' }],
  });
  await page.goto('/connectors');
  const link = page.getByRole('link', { name: 'Acme privacy' });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(link).toHaveAttribute('href', 'https://acme.test/privacy');
  await expect(page.getByRole('link', { name: 'Instance imprint' })).toHaveCount(0);
});

test('falls back to the instance-wide links if the workspace call fails', async ({ page }) => {
  await session(page, {
    workspaceLinks: { message: 'boom' },
    workspaceStatus: 500,
    publicLinks: [{ label: 'Instance imprint', url: 'https://instance.test/imprint' }],
  });
  await page.goto('/connectors');
  await expect(page.getByRole('link', { name: 'Instance imprint' })).toBeVisible({ timeout: 15_000 });
});
