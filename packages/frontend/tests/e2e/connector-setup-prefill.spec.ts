import { expect, test, type Page } from '@playwright/test';

/**
 * A setup link can start the address fields with values (prefill.<NAME>), as
 * the AnythingMCP module in Odoo does with the Odoo address and database. A
 * credential is never taken from a link.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const ODOO = {
  slug: 'odoo',
  name: 'Odoo',
  description: 'Odoo ERP 19 and newer',
  icon: 'odoo',
  connector: { name: 'Odoo', type: 'REST', baseUrl: '{{ODOO_URL}}', authType: 'BEARER_TOKEN' },
  setupKind: 'credentials',
  envVars: [
    { name: 'ODOO_URL', required: true, label: 'Odoo address', kind: 'address', secret: false },
    { name: 'ODOO_DB', required: true, label: 'Database name', kind: 'address', secret: false },
    { name: 'ODOO_API_KEY', required: true, label: 'API key', kind: 'credential', secret: true },
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
    if (url.endsWith('/api/adapters/odoo/verify')) {
      calls.verify.push(req.postDataJSON());
      return json({ ok: false, kind: 'auth_failed', status: 401, message: 'Invalid API key' });
    }
    if (url.endsWith('/api/adapters/odoo')) return json(ODOO);
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

test('starts the address fields with the values in the link, never the key', async ({ page }) => {
  const calls = await setup(page);
  const q = new URLSearchParams({
    'prefill.ODOO_URL': 'https://acme.odoo.com',
    'prefill.ODOO_DB': ' acme-prod ',
    'prefill.ODOO_API_KEY': 'from-a-link',
  });
  await page.goto(`/connectors/setup/odoo?${q}`);
  await expect(page.getByLabel('Odoo address')).toHaveValue('https://acme.odoo.com');
  await expect(page.getByLabel('Database name')).toHaveValue('acme-prod');
  await expect(page.getByLabel('API key')).toHaveValue('');

  // The prefilled values are sent like typed ones.
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect.poll(() => calls.verify.length).toBe(1);
  expect(calls.verify[0]).toEqual({
    credentials: { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme-prod', ODOO_API_KEY: 'typed-key' },
  });
});
