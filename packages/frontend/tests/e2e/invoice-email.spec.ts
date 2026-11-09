import { expect, test, type Page } from '@playwright/test';

/**
 * Settings → License: "Invoices by email" (Cloud). The API is mocked; the
 * tests check what the admin sees and what the page sends.
 */

const DAY = 86_400_000;
const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};
const PAID = {
  plan: 'starter',
  status: 'active',
  expiresAt: null,
  features: {},
  billing: {
    status: 'active',
    cancelling: false,
    endsAt: null,
    currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
    trialEnd: null,
    amount: 1900,
    currency: 'eur',
    interval: 'month',
  },
};
const OFF = {
  available: true,
  enabled: false,
  billingContact: 'billing@acme-gmbh.de',
  recipient: { kind: 'billing', address: 'billing@acme-gmbh.de' },
  lastSent: null,
};

async function session(
  page: Page,
  opts: { deploymentMode?: 'cloud' | 'self-hosted'; license?: Record<string, unknown>; settings?: Record<string, unknown> } = {},
) {
  const puts: unknown[] = [];
  let settings: Record<string, any> = opts.settings ?? OFF;
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, ADMIN);
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: opts.deploymentMode ?? 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/license/invoice-email')) {
      if (req.method() === 'PUT') {
        const change = req.postDataJSON();
        puts.push(change);
        if (change.to === 'refused@acme-gmbh.de') return json({ message: 'Invalid email address' }, 400);
        const to = change.to === undefined ? settings.recipient.address : (change.to ?? settings.billingContact);
        settings = {
          ...settings,
          enabled: change.enabled,
          recipient: { kind: to === settings.billingContact ? 'billing' : 'custom', address: to },
        };
      }
      return json(settings);
    }
    if (p.endsWith('/license/refresh')) return json({ refreshed: false });
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) return json(opts.license ?? PAID);
    if (p.endsWith('/license/usage')) {
      return json({ plan: 'starter', connectors: { current: 1, max: 5, isOver: false }, mcpServers: { current: 1, max: 3, isOver: false }, users: { current: 1, max: 1, isOver: false }, isOverAny: false });
    }
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/mcp-servers')) return json([]);
    return json({});
  });
  return { puts };
}

test.describe('invoices by email (cloud)', () => {
  test('switching on sends only the switch, and the billing contact is the default recipient', async ({ page }) => {
    const { puts } = await session(page);
    await page.goto('/settings/license');
    const toggle = page.getByRole('switch', { name: 'Invoices by email' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(puts).toEqual([{ enabled: true }]);
    await expect(page.getByRole('radio', { name: /Billing contact \(billing@acme-gmbh\.de\)/ })).toBeChecked();
    await expect(page.getByText('Invoices will be emailed from the next payment on.')).toBeVisible();
  });

  test('another address is saved with the switch kept on; a refused one shows an error', async ({ page }) => {
    const { puts } = await session(page, { settings: { ...OFF, enabled: true } });
    await page.goto('/settings/license');
    await page.getByRole('radio', { name: 'Another address' }).click({ timeout: 15_000 });
    const input = page.getByTestId('invoice-email-address');
    await input.fill('not an email');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByTestId('invoice-email-card').getByRole('alert')).toHaveText('Enter one valid email address.');
    expect(puts).toEqual([]);

    await input.fill('refused@acme-gmbh.de');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByTestId('invoice-email-card').getByRole('alert')).toHaveText('Invalid email address');

    await input.fill('Accounting@Acme-GmbH.de');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();
    expect(puts.at(-1)).toEqual({ enabled: true, to: 'Accounting@Acme-GmbH.de' });

    await page.getByRole('radio', { name: /Billing contact/ }).click();
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();
    expect(puts.at(-1)).toEqual({ enabled: true, to: null });
  });

  test('shows the last invoice sent', async ({ page }) => {
    await session(page, {
      settings: { ...OFF, enabled: true, lastSent: { number: 'VCOAA7SE-1402', at: '2026-11-09T10:00:00.000Z', to: 'bi***@acme-gmbh.de' } },
    });
    await page.goto('/settings/license');
    await expect(page.getByTestId('invoice-email-last-sent')).toHaveText(
      'Last invoice sent: VCOAA7SE-1402 on 9 November 2026 to bi***@acme-gmbh.de',
      { timeout: 15_000 },
    );
  });

  test('is hidden when the workspace has no subscription to invoice', async ({ page }) => {
    await session(page, { settings: { ...OFF, available: false } });
    await page.goto('/settings/license');
    await expect(page.getByRole('button', { name: 'Manage subscription & billing' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('invoice-email-card')).toHaveCount(0);
  });

  test('is not offered on a free trial', async ({ page }) => {
    await session(page, { license: { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + 3 * DAY).toISOString(), features: {}, trialDaysLeft: 3 } });
    await page.goto('/settings/license');
    await expect(page.getByText('Trial', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('invoice-email-card')).toHaveCount(0);
  });
});
