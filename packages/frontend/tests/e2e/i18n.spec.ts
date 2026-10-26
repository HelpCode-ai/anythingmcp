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

/** An instance for the pre-sign-in pages: self-hosted or Cloud, with users and open registration. */
async function mockServer(page: Page, deploymentMode: 'self-hosted' | 'cloud' = 'self-hosted') {
  await page.route(/\/(api|health)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/health/server-info') {
      return route.fulfill({
        json: { deploymentMode, mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] },
      });
    }
    return route.fulfill({ json: {} });
  });
}

/** A Cloud admin on a free trial that ends in five days, as /start-trial expects. */
async function cloudTrialSession(page: Page) {
  const trialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: BASE_URL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/(api|health)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (path === '/api/price-estimate') return json({ currency: null, vat: true });
    if (path.endsWith('/license/card-trial-eligibility')) return json({ kind: 'trial', trialEndsAt: trialEnd });
    if (path.endsWith('/license/status')) {
      return json({ plan: 'trial', status: 'active', expiresAt: trialEnd, trialDaysLeft: 5, features: {} });
    }
    if (path.endsWith('/users/me')) return json(USER);
    return json({});
  });
}

test.describe('auth and onboarding pages from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE' });

    test('renders registration in German, including its client-side checks', async ({ page }) => {
      await mockServer(page);
      await page.goto('/login?mode=register');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { level: 1, name: 'Konto erstellen', exact: true })).toBeVisible();
      await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Passwort bestätigen', { exact: true })).toBeVisible();
      await expect(page.getByText('Sie haben bereits ein Konto?')).toBeVisible();

      await page.getByLabel('Name', { exact: true }).fill('Test');
      await page.getByLabel('E-Mail', { exact: true }).fill('test@example.com');
      await page.getByLabel('Passwort', { exact: true }).fill('password');
      await page.getByLabel('Passwort bestätigen', { exact: true }).fill('password');
      await expect(page.getByText('✓ Mindestens 8 Zeichen')).toBeVisible();
      await expect(page.getByText('• Ein Großbuchstabe')).toBeVisible();
      await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();
      await expect(page.getByText(/^Das Passwort muss mindestens 8 Zeichen lang sein/)).toBeVisible();
    });

    test('renders the Cloud sign-up and its trust panel in German', async ({ page }) => {
      await mockServer(page, 'cloud');
      await page.goto('/login?mode=register');
      await expect(page.getByRole('heading', { level: 1, name: 'Kostenloses Konto erstellen', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Kostenlos testen →', exact: true })).toBeVisible();
      const panel = page.getByRole('complementary', { name: 'Warum Teams auf AnythingMCP setzen' });
      await expect(panel.getByText('Funktioniert mit', { exact: true })).toBeVisible();
      await expect(panel.getByText('Ihre 7-tägige Testphase umfasst', { exact: true })).toBeVisible();
    });

    test('renders /forgot-password in German', async ({ page }) => {
      await mockServer(page);
      await page.goto('/forgot-password');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { name: 'Passwort vergessen', exact: true })).toBeVisible();
      await expect(page.getByLabel('E-Mail', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Link zum Zurücksetzen senden', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Zurück zur Anmeldung', exact: true })).toBeVisible();
    });

    test('renders /verify-email without a token in German', async ({ page }) => {
      await mockServer(page);
      await page.goto('/verify-email');
      await expect(page.getByRole('heading', { level: 1, name: 'E-Mail-Bestätigung', exact: true })).toBeVisible();
      await expect(page.getByText('Kein Bestätigungstoken angegeben', { exact: true })).toBeVisible();
    });

    test('renders /welcome in German', async ({ page }) => {
      await fakeSession(page);
      await page.goto('/welcome');
      await expect(page.getByRole('heading', { level: 1, name: 'Verbinden Sie Ihr erstes Tool, Test.', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /Marktplatz durchsuchen/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Vorerst überspringen', exact: true })).toBeVisible();
    });

    test('renders /start-trial in German, with the date in German', async ({ page }) => {
      await cloudTrialSession(page);
      await page.goto('/start-trial');
      await expect(page.getByRole('heading', { level: 1, name: 'Ihre kostenlose Testphase', exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/^Kostenlos bis \d{1,2}\. \S+ \d{4}$/)).toBeVisible();
      await expect(page.getByText(/^Heute 0 €\./)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ohne Zahlungsdaten fortfahren', exact: true })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT' });

    test('renders /reset-password in Italian, with its mismatch check', async ({ page }) => {
      await mockServer(page);
      await page.goto('/reset-password?token=abc');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('heading', { name: 'Reimposta password', exact: true })).toBeVisible();
      await page.getByLabel('Nuova password', { exact: true }).fill('Password1!');
      await page.getByLabel('Conferma password', { exact: true }).fill('Password2!');
      await page.getByRole('button', { name: 'Reimposta password', exact: true }).click();
      await expect(page.getByText('Le password non coincidono', { exact: true })).toBeVisible();
    });

    test('renders /accept-invite without a token in Italian', async ({ page }) => {
      await mockServer(page);
      await page.goto('/accept-invite');
      await expect(page.getByRole('heading', { name: 'Invito non valido', exact: true })).toBeVisible();
      await expect(page.getByText('Nessun token di invito fornito', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: "Vai all'accesso", exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US' });

    test('keeps registration and the reset pages in English', async ({ page }) => {
      await mockServer(page);
      await page.goto('/login?mode=register');
      await expect(page.getByRole('heading', { level: 1, name: 'Create your account', exact: true })).toBeVisible();
      await expect(page.getByLabel('Confirm Password', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create Account', exact: true })).toBeVisible();
      await expect(page.getByText('Already have an account?')).toBeVisible();

      await page.goto('/reset-password');
      await expect(page.getByRole('heading', { name: 'Invalid Link', exact: true })).toBeVisible();
      await expect(page.getByText('This password reset link is invalid or has expired.', { exact: true })).toBeVisible();
    });
  });
});

/** The signed-in session plus a few audit-log rows and analytics breakdowns. */
async function auditSession(page: Page) {
  await fakeSession(page);
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/(audit\/(invocations|breakdowns)|mcp-servers)/, (route) => {
    const url = route.request().url();
    if (url.includes('/mcp-servers')) return route.fulfill({ json: [{ id: 'srv-1', name: 'Test Server' }] });
    if (url.includes('/breakdowns')) {
      return route.fulfill({
        json: {
          days: 30,
          total: 1234,
          errors: 1,
          proxyCalls: 0,
          estCostMicros: 0,
          rates: { callMicros: 0, proxyCallMicros: 0 },
          byConnector: [{ id: 'c1', label: 'Echo Service', count: 1234, errors: 1 }],
          byServer: [],
          byUser: [],
        },
      });
    }
    return route.fulfill({
      json: [
        {
          id: 'log-1',
          createdAt: new Date().toISOString(),
          status: 'ERROR',
          durationMs: 42,
          mcpServerId: 'srv-1',
          mcpServer: { id: 'srv-1', name: 'Test Server' },
          toolId: 't-1',
          tool: { name: 'echo_message', connector: { name: 'Echo Service', type: 'REST' } },
          input: { message: 'hello' },
          error: 'Upstream timed out',
          clientInfo: JSON.stringify({ authMethod: 'jwt' }),
        },
      ],
    });
  });
}

test.describe('audit log and analytics from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders /logs in German, including a row and its details', async ({ page }) => {
      await auditSession(page);
      await page.goto('/logs');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByText('Audit-Log', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Erfolgreich', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('Nach Tool oder Connector suchen…')).toBeVisible();
      await expect(page.getByText('Dauer', { exact: true })).toBeVisible();
      await expect(page.getByText('Seite 1 · 1 Ergebnis', { exact: true })).toBeVisible();

      await page.getByText('FEHLER', { exact: true }).last().click();
      await expect(page.getByRole('heading', { name: 'Fehler', exact: true })).toBeVisible();
      await expect(page.getByText('Authentifizierung: JWT', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Als cURL kopieren', exact: true })).toBeVisible();
      // The shell around every page.
      await expect(page.getByRole('button', { name: 'Design wechseln', exact: true }).last()).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders /analytics in Italian, with plurals', async ({ page }) => {
      await auditSession(page);
      await page.goto('/analytics');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('button', { name: '30 g', exact: true })).toBeVisible();
      await expect(page.getByText('Chiamate · 30 g', { exact: true })).toBeVisible();
      await expect(page.getByText('1 errore', { exact: true })).toBeVisible();
      await expect(page.getByText('nessuna tariffa configurata', { exact: true })).toBeVisible();
      await expect(page.getByText('Chiamate per connettore', { exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps /logs and /analytics in English', async ({ page }) => {
      await auditSession(page);
      await page.goto('/logs');
      await expect(page.getByRole('button', { name: 'Timeouts', exact: true })).toBeVisible();
      await expect(page.getByText('Page 1 · 1 results', { exact: true })).toBeVisible();
      await expect(page.getByText('ERROR', { exact: true }).last()).toBeVisible();

      await page.goto('/analytics');
      await expect(page.getByText('Tool calls · 30d', { exact: true })).toBeVisible();
      await expect(page.getByText('1 error', { exact: true })).toBeVisible();
      await expect(page.getByText('no rate configured', { exact: true })).toBeVisible();
    });
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
