import { expect, test } from '@playwright/test';

/**
 * The install form asks for API credentials. A browser that sees a text field
 * followed by a password field takes it for a login and fills in the saved
 * AnythingMCP e-mail and password: seen on live installs, where a user's own
 * login ended up as a connector's Basic Auth or Odoo user id. The fields must
 * opt out of autofill and password managers.
 *
 * And an adapter whose key travels in the body (authType NONE, Odoo's
 * JSON-RPC) is not a "Public API".
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
const ODOO = {
  slug: 'odoo-jsonrpc', name: 'Odoo 14-18 (JSON-RPC)', description: 'Odoo over JSON-RPC.', region: 'intl', category: 'erp',
  icon: 'odoo', docsUrl: null, requiredEnvVars: ['ODOO_URL', 'ODOO_DB', 'ODOO_UID', 'ODOO_API_KEY'], toolCount: 11, authType: 'NONE',
};
const HN = { slug: 'hackernews', name: 'Hacker News', description: 'Public stories.', region: 'intl', category: 'news', icon: 'hackernews', docsUrl: null, requiredEnvVars: [], toolCount: 5, authType: 'NONE' };

test('credential fields opt out of autofill, and a body-key adapter is not labelled public', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/api\/adapters\/odoo-jsonrpc$/.test(url)) {
      return json({
        ...ODOO,
        instructions: 'Four values.',
        connector: { name: 'Odoo', type: 'REST', authType: 'NONE', baseUrl: '{{ODOO_URL}}' },
        tools: [],
        setupKind: 'credentials',
        envVars: [
          { name: 'ODOO_URL', required: true, label: 'URL', kind: 'address', secret: false },
          { name: 'ODOO_DB', required: true, label: 'Database', kind: 'setting', secret: false },
          { name: 'ODOO_UID', required: true, label: 'User ID', kind: 'setting', secret: false },
          { name: 'ODOO_API_KEY', required: true, label: 'API key', kind: 'credential', secret: true },
        ],
      });
    }
    if (/\/api\/adapters(\?|$)/.test(url)) return json([ODOO, HN]);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    return json({});
  });

  await page.goto('/connectors/store');
  await expect(page.getByText('Odoo 14-18 (JSON-RPC)', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('API Key', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Public API', { exact: true })).toHaveCount(1); // Hacker News only

  // Install opens the guided setup, whose fields carry the same opt-outs.
  await page.getByRole('button', { name: 'Install' }).first().click();
  await page.waitForURL(/\/connectors\/setup\/odoo-jsonrpc/);
  const uid = page.getByLabel('User ID');
  const key = page.getByLabel('API key');
  await expect(uid).toBeVisible({ timeout: 10_000 });
  await expect(uid).toHaveAttribute('autocomplete', 'off');
  await expect(key).toHaveAttribute('autocomplete', 'new-password');
  for (const field of [uid, key]) {
    await expect(field).toHaveAttribute('data-1p-ignore');
    await expect(field).toHaveAttribute('data-lpignore', 'true');
    await expect(field).toHaveAttribute('name', /^amcp-connector-var-/);
  }
});
