import { expect, test, type Page } from '@playwright/test';

/**
 * `/connectors/<id>?signin=1` is the link of the "your app was approved"
 * email (and of the AI client's answers): the provider's sign-in starts by
 * itself. A third of the people who opened the connector page from that email
 * never found the sign-in button on it.
 *
 * The parameter is only a flag. The page asks the server where the provider's
 * sign-in of this connector is, as the button does, and only while the
 * connector waits for its authorization.
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
  name: 'Etsy',
  type: 'REST',
  baseUrl: 'https://openapi.etsy.com/v3/application',
  authType: 'OAUTH2',
  authConfig: 'opaque-ciphertext',
  isActive: true,
  headers: null,
  envVars: { ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx', ETSY_CLIENT_SECRET: '' },
  maskedEnvVars: ['ETSY_CLIENT_SECRET'],
  missingVariables: [],
  config: { adapterSlug: 'etsy' },
  credentialScope: 'SHARED',
  setupStatus: 'needs_authorization',
  tools: [],
  createdAt: '2026-11-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

const OAUTH_CONFIG = {
  clientId: '{{ETSY_CLIENT_ID}}',
  authorizationUrl: 'https://www.etsy.com/oauth/connect',
  tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  scopes: 'shops_r transactions_r',
  tokenAuthMethod: 'client_secret_post',
  pkce: true,
  hasClientSecret: true,
  hasAccessToken: false,
  hasRefreshToken: false,
};

const PROVIDER_URL = 'https://www.etsy.com/oauth/connect?client_id=abc&state=st-1';

async function signIn(page: Page) {
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
}

/** Mocks the API; returns the sign-in starts the page asked the server for. */
async function mockApi(
  page: Page,
  opts: { connector?: Record<string, unknown>; start?: Record<string, unknown>; oauthConfig?: Record<string, unknown> } = {},
) {
  const connector = { ...CONNECTOR, ...(opts.connector ?? {}) };
  const starts: Array<{ url: string; auth: string | undefined }> = [];
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/oauth/authorize') && req.method() === 'POST') {
      starts.push({ url: new URL(url).pathname, auth: req.headers()['authorization'] });
      return json(opts.start ?? { authorizationUrl: PROVIDER_URL }, 201);
    }
    if (url.includes('/api/connectors/c1/oauth-config')) return json({ ...OAUTH_CONFIG, ...(opts.oauthConfig ?? {}) });
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
  // The provider's own page, so the browser has somewhere to arrive.
  await page.route('https://www.etsy.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Etsy sign-in</h1>' }),
  );
  return starts;
}

test.describe('Connector page: the sign-in link of the approval email', () => {
  test('starts the provider sign-in by itself for a connector that waits for it', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page);
    await page.goto('/connectors/c1?signin=1');

    await expect(page).toHaveURL(PROVIDER_URL);
    await expect(page.getByRole('heading', { name: 'Etsy sign-in' })).toBeVisible();
    // The server was asked once, for the connector in the link, as the signed-in user.
    expect(starts).toEqual([{ url: '/api/connectors/c1/oauth/authorize', auth: 'Bearer test-token' }]);

    // "Back" from the provider lands on the connector page without the flag,
    // and does not start the sign-in a second time.
    await page.goBack();
    await expect(page).toHaveURL(/\/connectors\/c1$/);
    await expect(page.getByRole('button', { name: 'Authorize with Provider' })).toBeVisible();
    await expect(page.getByText(/Opening the sign-in/)).toHaveCount(0);
    expect(starts).toHaveLength(1);
  });

  test('does nothing for a connector that is already signed in', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page, {
      connector: { setupStatus: 'ready' },
      oauthConfig: { hasAccessToken: true, hasRefreshToken: true },
    });
    await page.goto('/connectors/c1?signin=1');

    await expect(page.getByRole('button', { name: 'Authorize with Provider' })).toBeVisible();
    await expect(page).toHaveURL(/\/connectors\/c1$/);
    expect(starts).toEqual([]);
    await expect(page.getByText(/Opening the sign-in/)).toHaveCount(0);
  });

  test('does nothing while the app keys are missing', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page, {
      connector: { setupStatus: 'needs_input', missingVariables: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'] },
    });
    await page.goto('/connectors/c1?signin=1');

    await expect(page.getByText(/Save your app's client ID and secret first/)).toBeVisible();
    await expect(page).toHaveURL(/\/connectors\/c1$/);
    expect(starts).toEqual([]);
  });

  test('does not start without the flag', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page);
    await page.goto('/connectors/c1');

    await expect(page.getByRole('button', { name: 'Authorize with Provider' })).toBeVisible();
    await expect(page).toHaveURL(/\/connectors\/c1$/);
    expect(starts).toEqual([]);
  });

  test('follows only the address the server gives: a URL in the link is ignored', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page);
    let evil = 0;
    await page.route('https://evil.example/**', (route) => {
      evil++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: 'evil' });
    });
    await page.goto(
      `/connectors/c1?signin=1&returnTo=${encodeURIComponent('https://evil.example/x')}&authorizationUrl=${encodeURIComponent('https://evil.example/y')}&redirect=${encodeURIComponent('//evil.example/z')}`,
    );

    await expect(page).toHaveURL(PROVIDER_URL);
    expect(starts).toHaveLength(1);
    expect(evil).toBe(0);
  });

  test('when the sign-in cannot start, focuses the button with a line above it', async ({ page }) => {
    await signIn(page);
    const starts = await mockApi(page, { start: { error: 'The provider did not answer. Try again in a minute.' } });
    await page.goto('/connectors/c1?signin=1');

    await expect(page.getByText('The sign-in could not start by itself. Start it with this button:')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'The provider did not answer' })).toBeVisible();
    const button = page.getByRole('button', { name: 'Authorize with Provider' });
    await expect(button).toBeFocused();
    await expect(page).toHaveURL(/\/connectors\/c1$/);
    expect(starts).toHaveLength(1);
  });

  test('signed out, the link comes back whole after the sign-in', async ({ page }) => {
    await mockApi(page);
    await page.goto('/connectors/c1?signin=1');

    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/connectors/c1?signin=1');
  });
});
