import { expect, test } from '@playwright/test';

/**
 * "Catalog update available" says, tool by tool, what an update will do before
 * it does it, and lists the user's own tools on the connector as kept: a full
 * update used to retire every tool not in the catalog, including those.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
const CONNECTOR = {
  id: 'c1', name: 'Etsy Open API v3', type: 'REST', baseUrl: 'https://openapi.etsy.com/v3/application',
  authType: 'OAUTH2', authConfig: null, isActive: true, headers: {}, maskedHeaders: [], envVars: {}, maskedEnvVars: [],
  config: { adapterSlug: 'etsy' }, tools: [], createdAt: '2026-09-01T00:00:00Z', userId: 'u1', organizationId: 'o1',
};
const DIFF = {
  catalogManaged: true, slug: 'etsy', catalogVersion: 'abcdef123456', connectorVersion: 'old',
  updated: [{ name: 'etsy_get_listing', kind: 'safe' }, { name: 'etsy_get_shop', kind: 'structural' }],
  added: ['etsy_get_listings_by_shop'], removed: ['etsy_retired_tool'], custom: ['etsy_create_draft_listing'],
  instructionsRefreshable: false, baseUrl: null, isUpToDate: false, isSafeClass: false,
};

test('lists what an update changes, and the user\'s own tools as kept', async ({ page, baseURL }) => {
  const posts: unknown[] = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/connectors/c1/resync-catalog') && req.method() === 'POST') {
      posts.push(req.postDataJSON());
      return json({ applied: true });
    }
    if (url.includes('/api/connectors/c1/catalog-diff')) return json(DIFF);
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1')) return json(CONNECTOR);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([CONNECTOR]);
    return json({});
  });

  await page.goto('/connectors/c1');
  await expect(page.getByRole('heading', { name: 'Catalog update available' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('etsy_get_listing, etsy_get_shop ●')).toBeVisible();
  await expect(page.getByText('etsy_get_listings_by_shop')).toBeVisible();
  await expect(page.getByText('etsy_retired_tool')).toBeVisible();
  await expect(page.getByText('Yours, kept as they are')).toBeVisible();
  await expect(page.getByText('etsy_create_draft_listing')).toBeVisible();

  await page.getByRole('button', { name: 'Apply update' }).click();
  await expect.poll(() => posts.length).toBe(1);
});
