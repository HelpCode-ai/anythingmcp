import { expect, test } from '@playwright/test';

/**
 * An Email (IMAP/SMTP) connector is created from the form: servers, ports
 * and security go to config.email, the login to authConfig, and the base URL
 * is derived from the IMAP server. No base URL, auth type or header fields.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

test('creates an Email connector from the IMAP/SMTP form', async ({ page, baseURL }) => {
  let created: Record<string, any> | null = null;
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (req.method() === 'POST' && /\/api\/connectors$/.test(url)) {
      created = req.postDataJSON();
      return json({ id: 'c9', name: created?.name, type: 'EMAIL', attachedToServer: null }, 201);
    }
    if (/\/api\/connectors\/c9$/.test(url)) {
      return json({ id: 'c9', name: 'Office Mail', type: 'EMAIL', baseUrl: 'imaps://imap.ionos.de:993', authType: 'BASIC_AUTH', config: created?.config, tools: [] });
    }
    if (url.includes('/api/connectors')) return json([]);
    return json({});
  });

  await page.goto('/connectors/new');
  await page.getByRole('button', { name: /Email \(IMAP\/SMTP\)/ }).click();
  const form = page.getByTestId('email-settings');
  await expect(form).toBeVisible({ timeout: 15_000 });
  // The HTTP fields are not offered for a mailbox.
  await expect(page.getByPlaceholder('https://api.example.com/v1')).toHaveCount(0);

  await page.getByPlaceholder('e.g., My REST API').fill('Office Mail');
  await form.getByPlaceholder('imap.example.com').fill('imap.ionos.de');
  await form.getByPlaceholder('smtp.example.com').fill('smtp.ionos.de');
  await form.getByPlaceholder('anna@example.com').fill('anna@example.com');
  await form.locator('input[type="password"]').first().fill('app-password-123');
  await page.getByRole('button', { name: 'Create connector' }).click();

  await expect.poll(() => created).not.toBeNull();
  expect(created).toMatchObject({
    name: 'Office Mail',
    type: 'EMAIL',
    baseUrl: 'imaps://imap.ionos.de:993',
    authType: 'BASIC_AUTH',
    authConfig: { username: 'anna@example.com', password: 'app-password-123' },
    config: {
      email: {
        imapHost: 'imap.ionos.de',
        imapPort: '993',
        imapSecurity: 'tls',
        smtpHost: 'smtp.ionos.de',
        smtpPort: '465',
        smtpSecurity: 'tls',
        saveSent: 'auto',
      },
    },
  });
  expect(created!.headers).toBeUndefined();
  expect(created!.authConfig.smtpUsername).toBeUndefined();
});
