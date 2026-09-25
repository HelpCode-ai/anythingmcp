import { expect, test, type Page } from '@playwright/test';

/**
 * OAuth 1.0a credentials can be corrected in the connector editor. The editor
 * used to have no fields for them, so an ImmobilienScout24 connector installed
 * with the account's e-mail address as consumer key could only be fixed by
 * deleting and reinstalling it.
 *
 * Same rules as the other auth types: stored values are never pre-filled, and
 * a field left empty keeps its value (the PATCH carries only what was typed).
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
  name: 'ImmobilienScout24',
  type: 'REST',
  baseUrl: 'https://rest.immobilienscout24.de/restapi/api',
  authType: 'OAUTH1',
  // Encrypted on the server; the page must never try to show it.
  authConfig: 'opaque-ciphertext',
  isActive: true,
  headers: null,
  envVars: null,
  config: { adapterSlug: 'immobilienscout24' },
  tools: [],
  createdAt: '2026-09-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

async function openConnector(page: Page, patchStatus = 200) {
  const patches: unknown[] = [];
  const puts: Record<string, unknown>[] = [];
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

    if (url.includes('/api/connectors/c1/oauth1-config') && req.method() === 'PATCH') {
      patches.push(req.postDataJSON());
      return patchStatus === 200
        ? json({ message: 'OAuth 1.0a credentials updated' })
        : json(
            {
              statusCode: patchStatus,
              message: 'The consumer key looks like an e-mail address.',
            },
            patchStatus,
          );
    }
    if (url.includes('/api/connectors/c1') && req.method() === 'PUT') {
      puts.push(req.postDataJSON() as Record<string, unknown>);
      return json(CONNECTOR);
    }
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
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  return { patches, puts };
}

test.describe('Connector editor — OAuth 1.0a credentials', () => {
  test('shows empty fields and sends only what was typed', async ({ page }) => {
    const { patches, puts } = await openConnector(page);

    const key = page.getByLabel('Consumer Key');
    const secret = page.getByLabel('Consumer Secret');
    await expect(key).toBeVisible();
    await expect(key).toHaveValue('');
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('placeholder', 'Leave empty to keep current');

    await key.fill('  MyAppKey-123  ');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Connector updated')).toBeVisible();
    expect(patches).toEqual([{ consumerKey: 'MyAppKey-123' }]);
    // The main update keeps the auth type and carries no credentials.
    expect(puts).toHaveLength(1);
    expect(puts[0].authType).toBe('OAUTH1');
    expect(puts[0]).not.toHaveProperty('authConfig');
  });

  test('saves nothing when no credential was typed', async ({ page }) => {
    const { patches, puts } = await openConnector(page);

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Connector updated')).toBeVisible();
    expect(patches).toEqual([]);
    expect(puts).toHaveLength(1);
  });

  test('a refused key stops the save and shows the reason', async ({ page }) => {
    const { patches, puts } = await openConnector(page, 400);

    await page.getByLabel('Consumer Key').fill('someone@example.com');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText(/looks like an e-mail address/)).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(puts).toHaveLength(0);
  });
});
