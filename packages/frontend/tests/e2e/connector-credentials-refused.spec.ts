import { expect, test, type Page } from '@playwright/test';

/**
 * A connector whose saved key the service keeps refusing on tool calls
 * (`authStatusCode: credential_refused`). The connector page says so in words
 * that fit a key (nothing is "authorized again") and offers the way to fix
 * it: the guided setup for a catalog connector, the place where the
 * credentials are kept for a hand-built one.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const REFUSED = {
  authStatus: 'needs_reauth',
  authStatusCode: 'credential_refused',
  authStatusMessage:
    "The API refused this connector's saved credentials on 3 calls in a row (HTTP 401). Telegram refused the bot token. Copy it again from @BotFather.",
  authStatusAt: '2026-11-14T09:30:00Z',
};

const BASE = {
  id: 'c1',
  type: 'REST',
  authType: 'NONE',
  authConfig: null,
  isActive: true,
  headers: {},
  maskedHeaders: [],
  tools: [],
  createdAt: '2026-09-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

const CATALOG = {
  ...BASE,
  ...REFUSED,
  name: 'Telegram Bot',
  baseUrl: 'https://api.telegram.org/bot',
  envVars: { TELEGRAM_BOT_TOKEN: '' },
  maskedEnvVars: ['TELEGRAM_BOT_TOKEN'],
  config: { adapterSlug: 'telegram-bot' },
};

const HAND_BUILT = {
  ...BASE,
  ...REFUSED,
  name: 'Warehouse API',
  baseUrl: 'https://warehouse.example.com/api',
  authType: 'API_KEY',
  envVars: { WAREHOUSE_API_KEY: '' },
  maskedEnvVars: ['WAREHOUSE_API_KEY'],
  config: null,
};

async function openConnector(page: Page, baseURL: string, connector: Record<string, unknown>) {
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

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
}

test.describe('Connector page — refused credentials', () => {
  test('a catalog connector says what happened and links to its setup', async ({ page, baseURL }) => {
    await openConnector(page, baseURL!, CATALOG);

    await expect(page.getByText('Key refused', { exact: true })).toBeVisible();
    const notice = page.getByRole('status').filter({ hasText: 'until you save valid credentials' });
    await expect(notice).toContainText('Every tool call of this connector fails until you save valid credentials.');
    await expect(notice).toContainText('Copy it again from @BotFather.');
    // Nothing is blocked and there is no sign-in to renew: the older wording must not show.
    await expect(page.getByText('tool calls stop here')).toHaveCount(0);

    const fix = notice.getByRole('link', { name: 'Update credentials' });
    await expect(fix).toHaveAttribute('href', '/connectors/setup/telegram-bot?connector=c1');
  });

  test('a hand-built connector opens its variables, with the first field focused', async ({ page, baseURL }) => {
    await openConnector(page, baseURL!, HAND_BUILT);

    const notice = page.getByRole('status').filter({ hasText: 'until you save valid credentials' });
    await expect(page.getByLabel('Value of WAREHOUSE_API_KEY')).toHaveCount(0);
    await notice.getByRole('button', { name: 'Update credentials' }).click();

    await expect(page.getByLabel('Value of WAREHOUSE_API_KEY')).toBeVisible();
    await expect(page.locator('#connector-variables input').first()).toBeFocused();
  });

  test('a hand-built connector without variables opens its details form', async ({ page, baseURL }) => {
    await openConnector(page, baseURL!, { ...HAND_BUILT, envVars: {}, maskedEnvVars: [] });

    await page
      .getByRole('status')
      .filter({ hasText: 'until you save valid credentials' })
      .getByRole('button', { name: 'Update credentials' })
      .click();

    await expect(page.locator('#connector-details input').first()).toBeFocused();
  });

  test('a revoked sign-in keeps its own words and gets no credentials button', async ({ page, baseURL }) => {
    await openConnector(page, baseURL!, {
      ...CATALOG,
      authType: 'OAUTH2',
      authStatusCode: 'refresh_refused',
      authStatusMessage: 'Google revoked the sign-in.',
    });

    await expect(page.getByText('Sign-in expired', { exact: true })).toBeVisible();
    await expect(page.getByText('tool calls stop here until you authorize again')).toBeVisible();
    await expect(page.getByText('Update credentials')).toHaveCount(0);
  });
});
