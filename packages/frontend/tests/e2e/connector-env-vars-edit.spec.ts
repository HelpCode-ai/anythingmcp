import { expect, test, type Page } from '@playwright/test';

/**
 * Stored secrets in a connector's environment variables and headers are never
 * sent to the browser: the server returns them empty and names them in
 * `maskedEnvVars` / `maskedHeaders`. The editor shows them as set, sends them
 * back empty unless retyped (which keeps the stored value), and sends a value
 * only when one was typed.
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
  name: 'WhatsApp',
  type: 'REST',
  baseUrl: 'https://graph.facebook.com/v21.0',
  authType: 'NONE',
  authConfig: null,
  isActive: true,
  headers: { Accept: 'application/json', 'X-Api-Key': '' },
  maskedHeaders: ['X-Api-Key'],
  envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890' },
  maskedEnvVars: ['WHATSAPP_ACCESS_TOKEN'],
  config: { adapterSlug: 'whatsapp' },
  tools: [],
  createdAt: '2026-09-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

async function openConnector(
  page: Page,
  baseURL: string,
  envVarsResponse: Record<string, unknown> = { ...CONNECTOR, warnings: [] },
) {
  const envPuts: Record<string, any>[] = [];
  const puts: Record<string, any>[] = [];
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

    if (url.includes('/api/connectors/c1/env-vars') && req.method() === 'PUT') {
      envPuts.push(req.postDataJSON());
      return json(envVarsResponse);
    }
    if (url.includes('/api/connectors/c1') && req.method() === 'PUT') {
      puts.push(req.postDataJSON());
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
  return { envPuts, puts };
}

test.describe('Connector editor — masked environment variables', () => {
  test('shows a stored secret as set and keeps it when saving other values', async ({ page, baseURL }) => {
    const { envPuts } = await openConnector(page, baseURL!);
    await page.getByRole('button', { name: 'Edit (2)' }).click();

    const secret = page.getByLabel('Value of WHATSAPP_ACCESS_TOKEN');
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('type', 'password');
    await expect(secret).toHaveAttribute('placeholder', 'Set — leave empty to keep current');

    const visible = page.getByLabel('Value of WHATSAPP_BUSINESS_ACCOUNT_ID');
    await expect(visible).toHaveValue('1234567890');
    await expect(visible).toHaveAttribute('type', 'text');

    // A stored secret cannot be renamed in place (that would drop it).
    const names = page.getByLabel('Variable name');
    await expect(names.nth(0)).toHaveValue('WHATSAPP_ACCESS_TOKEN');
    await expect(names.nth(0)).toHaveAttribute('readonly', '');

    await visible.fill('9876543210');
    await page.getByRole('button', { name: 'Save Variables' }).click();

    await expect(page.getByText('Environment variables saved')).toBeVisible();
    expect(envPuts).toEqual([
      { envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '9876543210' } },
    ]);
  });

  test('sends a secret only when it is retyped', async ({ page, baseURL }) => {
    const { envPuts } = await openConnector(page, baseURL!);
    await page.getByRole('button', { name: 'Edit (2)' }).click();

    await page.getByLabel('Value of WHATSAPP_ACCESS_TOKEN').fill('new-test-token');
    await page.getByRole('button', { name: 'Save Variables' }).click();

    await expect(page.getByText('Environment variables saved')).toBeVisible();
    expect(envPuts).toEqual([
      { envVars: { WHATSAPP_ACCESS_TOKEN: 'new-test-token', WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890' } },
    ]);
  });

  test('shows what the server reports about variables it could not use', async ({ page, baseURL }) => {
    await openConnector(page, baseURL!, {
      ...CONNECTOR,
      warnings: [
        'IS24_CONSUMER_KEY is not set, so authConfig.consumerKey kept its stored value. Add IS24_CONSUMER_KEY to change it.',
      ],
    });
    await page.getByRole('button', { name: 'Edit (2)' }).click();
    await page.getByRole('button', { name: 'Save Variables' }).click();

    await expect(page.getByText(/IS24_CONSUMER_KEY is not set, so authConfig\.consumerKey kept its stored value/)).toBeVisible();
  });

  test('a masked header is sent back empty from the connector form', async ({ page, baseURL }) => {
    const { puts } = await openConnector(page, baseURL!);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const header = page.getByLabel('Value of header X-Api-Key');
    await expect(header).toHaveValue('');
    await expect(header).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Value of header Accept')).toHaveValue('application/json');

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Connector updated')).toBeVisible();
    expect(puts).toHaveLength(1);
    expect(puts[0].headers).toEqual({ Accept: 'application/json', 'X-Api-Key': '' });
    expect(puts[0]).not.toHaveProperty('envVars');
  });
});
