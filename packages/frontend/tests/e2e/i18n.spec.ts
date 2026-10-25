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

/** /login with an instance that has users and open registration, so the sign-in form shows. */
async function openLogin(page: Page) {
  await page.route(/\/(api|health)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/health/server-info') {
      return route.fulfill({
        json: { deploymentMode: 'self-hosted', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/login');
}

async function expectSignIn(
  page: Page,
  lang: string,
  texts: { heading: string; email: string; password: string; submit: string; forgot: string; noAccount: string; register: string },
) {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.getByRole('heading', { level: 1, name: texts.heading, exact: true })).toBeVisible();
  await expect(page.getByLabel(texts.email, { exact: true })).toBeVisible();
  await expect(page.getByLabel(texts.password, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: texts.submit, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: texts.forgot, exact: true })).toBeVisible();
  await expect(page.getByText(texts.noAccount, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: texts.register, exact: true })).toBeVisible();
}

const GERMAN = {
  heading: 'Anmelden',
  email: 'E-Mail',
  password: 'Passwort',
  submit: 'Anmelden',
  forgot: 'Passwort vergessen?',
  noAccount: 'Noch kein Konto?',
  register: 'Registrieren',
};
const ITALIAN = {
  heading: 'Accedi',
  email: 'Email',
  password: 'Password',
  submit: 'Accedi',
  forgot: 'Password dimenticata?',
  noAccount: 'Non hai un account?',
  register: 'Registrati',
};
const ENGLISH = {
  heading: 'Sign in',
  email: 'Email',
  password: 'Password',
  submit: 'Sign In',
  forgot: 'Forgot password?',
  noAccount: "Don't have an account?",
  register: 'Register',
};

test.describe('sign-in form from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE' });

    test('renders /login in German', async ({ page }) => {
      await openLogin(page);
      await expectSignIn(page, 'de', GERMAN);
      await page.getByRole('button', { name: 'Wiederherstellungscode verwenden', exact: true }).click();
      await expect(page.getByLabel('Wiederherstellungscode', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mit Wiederherstellungscode anmelden', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Zurück zur Anmeldung mit Passwort', exact: true })).toBeVisible();
    });

    test('shows the email-verified notice in German', async ({ page }) => {
      await page.route(/\/(api|health)\//, (route) => route.fulfill({ json: {} }));
      await page.goto('/login?emailVerified=true');
      await expect(page.getByText('E-Mail-Adresse erfolgreich bestätigt! Sie können sich jetzt anmelden.')).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT' });

    test('renders /login in Italian', async ({ page }) => {
      await openLogin(page);
      await expectSignIn(page, 'it', ITALIAN);
    });
  });

  test.describe('fr-FR', () => {
    test.use({ locale: 'fr-FR' });

    test('falls back to English', async ({ page }) => {
      await openLogin(page);
      await expectSignIn(page, 'en', ENGLISH);
    });
  });
});

test.describe('language switcher', () => {
  test('on /login sets the cookie and switches the language', async ({ page }) => {
    await openLogin(page);
    await expectSignIn(page, 'en', ENGLISH);

    const select = page.getByLabel('Language', { exact: true });
    await expect(select).toHaveValue('en');
    await select.selectOption('de');
    await expectSignIn(page, 'de', GERMAN);
    await expect(page.getByLabel('Sprache', { exact: true })).toHaveValue('de');

    const cookie = (await page.context().cookies()).find((c) => c.name === 'amcp_locale');
    expect(cookie?.value).toBe('de');
    expect(cookie?.path).toBe('/');
    expect(cookie?.sameSite).toBe('Lax');
    // One year, give or take the time the test took.
    const days = ((cookie?.expires ?? 0) - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365);

    await page.reload();
    await expectSignIn(page, 'de', GERMAN);
  });

  test('in Settings persists across a reload and sign-out', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/settings');
    // The sidebar renders on the client, so once it shows the page is hydrated
    // and the switcher's onChange is attached.
    await expectSidebar(page, 'en', { group: 'Overview', links: ['Connectors'], settings: 'Settings' });

    const select = page.getByLabel('Language', { exact: true });
    await expect(async () => {
      await select.selectOption('it');
      const cookie = (await page.context().cookies()).find((c) => c.name === 'amcp_locale');
      expect(cookie?.value).toBe('it');
    }).toPass({ timeout: 15_000 });
    // router.refresh() re-renders the server components; give a cold dev server time.
    await expect(page.locator('html')).toHaveAttribute('lang', 'it', { timeout: 15_000 });
    await expectSidebar(page, 'it', { group: 'Panoramica', links: ['Connettori'], settings: 'Impostazioni' });
    await expect(page.getByLabel('Lingua', { exact: true })).toHaveValue('it');

    await page.reload();
    await expectSidebar(page, 'it', { group: 'Panoramica', links: ['Connettori'], settings: 'Impostazioni' });
    await expect(page.getByLabel('Lingua', { exact: true })).toHaveValue('it');

    await page.locator('aside').getByRole('button', { name: /Acme/ }).click();
    await page.getByRole('button', { name: 'Esci', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'it');
    await expect(page.getByRole('heading', { level: 1, name: 'Accedi', exact: true })).toBeVisible();
    const cookie = (await page.context().cookies()).find((c) => c.name === 'amcp_locale');
    expect(cookie?.value).toBe('it');
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
