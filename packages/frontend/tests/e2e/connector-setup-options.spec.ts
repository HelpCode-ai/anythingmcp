import { expect, test, type Page } from '@playwright/test';

/**
 * A connector variable with a fixed list of choices (`envVarMeta.options`,
 * one API host per country) is a select on the setup page: nothing is
 * chosen at first, a required choice must be made before the check runs,
 * and the value sent is the option's value (the whole address), not its label.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const SELLER = {
  slug: 'good-seller',
  name: 'Good Seller',
  description: 'A marketplace with one seller API host per country',
  icon: 'good-seller',
  connector: { name: 'Good Seller', type: 'REST', baseUrl: '{{GOOD_SELLER_HOST}}/api', authType: 'API_KEY' },
  setupKind: 'credentials',
  envVars: [
    {
      name: 'GOOD_SELLER_HOST',
      required: true,
      label: 'Country',
      kind: 'address',
      secret: false,
      options: [
        { value: 'https://seller.good.fr', label: 'France' },
        { value: 'https://seller.good.es', label: 'Spain' },
      ],
    },
    { name: 'GOOD_SELLER_API_KEY', required: true, label: 'API key', kind: 'credential', secret: true },
  ],
};

async function setup(page: Page): Promise<{ verify: any[] }> {
  const calls = { verify: [] as any[] };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (/\/api\/adapters\/good-seller\/verify$/.test(url)) {
      calls.verify.push(req.postDataJSON());
      return json({ ok: false, kind: 'auth_failed', status: 401, message: 'Invalid API key' });
    }
    if (url.endsWith('/api/adapters/good-seller')) return json(SELLER);
    if (url.includes('/api/product-events')) return json({ ok: true });
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    return json({});
  });
  return calls;
}

test('a variable with fixed choices is a select that must be chosen, and sends the option value', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/connectors/setup/good-seller');

  const country = page.getByLabel('Country');
  await expect(country).toBeVisible();
  expect(await country.evaluate((el) => el.tagName)).toBe('SELECT');
  await expect(country).toHaveValue('');
  await expect(country.locator('option')).toHaveText(['Choose…', 'France', 'Spain']);

  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect(page.getByText('Required').first()).toBeVisible();
  expect(calls.verify).toHaveLength(0);

  await country.selectOption({ label: 'Spain' });
  await expect(country).toHaveValue('https://seller.good.es');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect.poll(() => calls.verify.length).toBe(1);
  expect(calls.verify[0].credentials.GOOD_SELLER_HOST).toBe('https://seller.good.es');
});
