import { expect, test, type Page } from '@playwright/test';

/**
 * A connector added without its credentials (picked after approving an AI
 * client, or installed from a chat) is linked from the chat by its connector
 * page, where "Finish setup" leads to the setup itself. The page reports that
 * it asked, once, so the visits that never take that click can be counted.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const CONNECTOR = {
  id: 'c1',
  name: 'Etsy Open API v3',
  type: 'REST',
  baseUrl: 'https://openapi.etsy.com/v3/application',
  authType: 'OAUTH2',
  authConfig: null,
  isActive: true,
  headers: {},
  envVars: {},
  maskedEnvVars: [],
  config: { adapterSlug: 'etsy' },
  setupStatus: 'needs_input',
  missingVariables: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'],
  tools: [],
  createdAt: '2026-11-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

async function openConnector(page: Page, baseURL: string, connector: Record<string, unknown>) {
  const events: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/product-events')) {
      events.push(req.postDataJSON());
      return json({ ok: true });
    }
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(connector);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([connector]);
    return json({});
  });
  await page.goto('/connectors/c1');
  return events;
}

test('an unfinished catalog connector reports once that its page asked to finish the setup', async ({ page, baseURL }) => {
  const events = await openConnector(page, baseURL!, CONNECTOR);
  const finish = page.getByRole('link', { name: 'Finish setup' });
  await expect(finish).toHaveAttribute('href', '/connectors/setup/etsy?connector=c1');
  const prompts = () => events.filter((e) => e.event === 'setup_finish_prompt_viewed').map((e) => e.metadata);
  await expect.poll(() => prompts().length).toBe(1);
  expect(prompts()).toEqual([{ adapterSlug: 'etsy', connectorId: 'c1', kind: 'needs_input' }]);
});

test('a connector that is ready reports nothing', async ({ page, baseURL }) => {
  const events = await openConnector(page, baseURL!, { ...CONNECTOR, setupStatus: 'ready', missingVariables: [] });
  await expect(page.getByRole('heading', { name: 'Connector Details' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Finish setup' })).toHaveCount(0);
  expect(events.filter((e) => e.event === 'setup_finish_prompt_viewed')).toEqual([]);
});
