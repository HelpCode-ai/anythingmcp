import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UI language: the amcp_locale cookie wins, then Accept-Language, then English.
 * Playwright's `locale` option sets the Accept-Language header the server sees.
 * The session is faked the same way as in redesign.spec.ts.
 */

const BASE_URL = 'http://localhost:3100';

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function fakeSession(page: Page) {
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: BASE_URL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    if (url.includes('/api/audit/stats')) return json({ invocations24h: 0, errors24h: 0 });
    if (url.includes('/api/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    return json({});
  });
}

async function expectSidebar(page: Page, lang: string, labels: { group: string; links: string[]; settings: string }) {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  const aside = page.locator('aside');
  await expect(aside.getByText(labels.group, { exact: true })).toBeVisible();
  for (const name of labels.links) {
    await expect(aside.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(aside.getByRole('link', { name: labels.settings, exact: true })).toBeVisible();
}

test.describe('UI language from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE' });

    test('renders the sidebar in German', async ({ page }) => {
      await fakeSession(page);
      await page.goto('/');
      await expectSidebar(page, 'de', {
        group: 'Übersicht',
        links: ['Dashboard', 'Audit-Log', 'Marktplatz', 'MCP-Server'],
        settings: 'Einstellungen',
      });
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT' });

    test('renders the sidebar in Italian', async ({ page }) => {
      await fakeSession(page);
      await page.goto('/');
      await expectSidebar(page, 'it', {
        group: 'Panoramica',
        links: ['Dashboard', 'Registro di audit', 'Connettori', 'Server MCP'],
        settings: 'Impostazioni',
      });
    });
  });

  test.describe('fr-FR', () => {
    test.use({ locale: 'fr-FR' });

    test('falls back to English for an unsupported language', async ({ page }) => {
      await fakeSession(page);
      await page.goto('/');
      await expectSidebar(page, 'en', {
        group: 'Overview',
        links: ['Dashboard', 'Audit Log', 'Marketplace', 'MCP Servers'],
        settings: 'Settings',
      });
    });
  });
});

test.describe('amcp_locale cookie', () => {
  test.use({ locale: 'de-DE' });

  test('takes precedence over Accept-Language', async ({ page }) => {
    await page.context().addCookies([{ name: 'amcp_locale', value: 'it', url: BASE_URL }]);
    await fakeSession(page);
    await page.goto('/');
    await expectSidebar(page, 'it', { group: 'Panoramica', links: ['Connettori'], settings: 'Impostazioni' });
  });

  test('is ignored when it holds an unsupported locale', async ({ page }) => {
    await page.context().addCookies([{ name: 'amcp_locale', value: 'xx', url: BASE_URL }]);
    await fakeSession(page);
    await page.goto('/');
    await expectSidebar(page, 'de', { group: 'Übersicht', links: ['Marktplatz'], settings: 'Einstellungen' });
  });
});

test.describe('message files', () => {
  const read = (locale: string) =>
    JSON.parse(readFileSync(join(__dirname, '../../messages', `${locale}.json`), 'utf8')) as Record<string, unknown>;

  const keys = (messages: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(messages).flatMap(([key, value]) =>
      value && typeof value === 'object'
        ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`]
    );

  const english = keys(read('en')).sort();

  for (const locale of ['de', 'it']) {
    test(`${locale}.json has exactly the keys of en.json`, () => {
      expect(keys(read(locale)).sort()).toEqual(english);
    });
  }
});
