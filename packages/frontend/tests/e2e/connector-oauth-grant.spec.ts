import { expect, test, type Page } from '@playwright/test';

/**
 * The OAuth2 editor offers the grant. Datto RMM issues 100-hour tokens with
 * no refresh token, so a connector set up with the authorization-code flow
 * stopped working after 100 hours; with the password grant it asks the token
 * URL again by itself, and there is nothing to authorize.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const CONNECTOR = {
  id: 'c1',
  name: 'Datto RMM',
  type: 'REST',
  baseUrl: 'https://merlot-api.centrastage.net',
  authType: 'OAUTH2',
  authConfig: 'opaque-ciphertext',
  isActive: true,
  headers: null,
  envVars: null,
  config: null,
  tools: [],
  createdAt: '2026-09-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

const OAUTH_CONFIG = {
  clientId: 'public-client',
  authorizationUrl: 'https://merlot-api.centrastage.net/auth/oauth/authorize',
  tokenUrl: 'https://merlot-api.centrastage.net/auth/oauth/token',
  scopes: '',
  tokenAuthMethod: 'client_secret_basic',
  pkce: true,
  hasClientSecret: true,
  hasAccessToken: true,
  hasRefreshToken: false,
};

async function openConnector(page: Page, oauthConfig: Record<string, unknown>) {
  const patches: unknown[] = [];
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/connectors/c1/oauth-config')) {
      if (req.method() === 'PATCH') {
        patches.push(req.postDataJSON());
        return json({ message: 'OAuth configuration updated' });
      }
      return json(oauthConfig);
    }
    if (url.includes('/api/connectors/c1') && req.method() === 'PUT') return json(CONNECTOR);
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(CONNECTOR);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([CONNECTOR]);
    return json({});
  });

  await page.goto('/connectors/c1');
  return { patches };
}

test.describe('Connector editor — OAuth2 grant', () => {
  test('switches an authorization-code connector to the password grant', async ({ page }) => {
    const { patches } = await openConnector(page, OAUTH_CONFIG);
    await expect(page.getByRole('button', { name: 'Authorize with Provider' })).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Grant type').selectOption('password');
    // Nothing to authorize with this grant.
    await expect(page.getByText('Authorization URL', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText(/Enter the username and password/)).toBeVisible();
    expect(patches).toEqual([]);

    await page.getByLabel('Username').fill('datto-api-key');
    await page.getByLabel('Password', { exact: true }).fill('datto-api-secret');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Connector updated')).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      grant: 'password',
      username: 'datto-api-key',
      password: 'datto-api-secret',
      tokenAuthMethod: 'client_secret_basic',
    });
  });

  test('hides Authorize with Provider for a password-grant connector and keeps its credentials', async ({ page }) => {
    const { patches } = await openConnector(page, {
      ...OAUTH_CONFIG,
      grant: 'password',
      hasUsername: true,
      hasPassword: true,
    });
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Authorize with Provider' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Grant type')).toHaveValue('password');
    await expect(page.getByLabel('Username')).toHaveAttribute('placeholder', 'Leave empty to keep current');

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Connector updated')).toBeVisible();
    expect(patches).toHaveLength(1);
    // Unchanged grant and untouched credentials are not sent.
    expect(patches[0]).not.toHaveProperty('grant');
    expect(patches[0]).not.toHaveProperty('username');
    expect(patches[0]).not.toHaveProperty('password');
  });
});
