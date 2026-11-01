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

/** The signed-in session plus one MCP server with a connector, for the server pages. */
async function mcpServerSession(page: Page) {
  await fakeSession(page);
  const server = {
    id: 's1',
    name: 'Search',
    slug: 'search',
    isActive: true,
    apiKeys: [],
    connectors: [{ connector: { id: 'c1', name: 'Echo Service' } }],
    _count: { connectors: 1, apiKeys: 0 },
    usage: { calls30d: 1, lastCallAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
  };
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/(mcp-servers|connectors)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/mcp-servers')) return route.fulfill({ json: [server] });
    if (path.endsWith('/mcp-servers/s1')) return route.fulfill({ json: { ...server, connectors: [] } });
    if (path.endsWith('/mcp-servers/s1/activity')) return route.fulfill({ json: { lastCallAt: null, calls30d: 0 } });
    if (path.endsWith('/connectors')) {
      return route.fulfill({ json: [{ id: 'c1', name: 'Echo Service', type: 'REST', tools: [{ id: 't1', name: 'echo', isEnabled: true }] }] });
    }
    return route.fulfill({ json: {} });
  });
}

test.describe('MCP server pages from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders /mcp-server in German, with plurals', async ({ page }) => {
      await mcpServerSession(page);
      await page.goto('/mcp-server');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('button', { name: 'Neuer MCP-Server' })).toBeVisible();
      await expect(page.getByText('Zuletzt genutzt vor 2 Tagen · 1 Aufruf in 30 Tagen', { exact: true })).toBeVisible();
      await expect(page.getByText('Aktiv', { exact: true }).last()).toBeVisible();
      await expect(page.getByText('Stellt bereit: Echo Service', { exact: true })).toBeVisible();
      await expect(page.getByText('1 Connector', { exact: true })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders /mcp-server/[id] in Italian, including a Quick Connect modal', async ({ page }) => {
      await mcpServerSession(page);
      await page.goto('/mcp-server/s1');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByText('Connettori assegnati (0)', { exact: true })).toBeVisible();
      await expect(page.getByText('Connetti il tuo client MCP', { exact: true })).toBeVisible();
      await expect(page.getByText('Impostazioni del server', { exact: true })).toBeVisible();
      // The connection check, waiting for the first request.
      await expect(page.getByRole('region', { name: 'Verifica della connessione' })).toContainText(
        'In attesa della prima richiesta',
      );
      // A rich-text line: the bold part is its own element.
      await expect(page.getByText('ancora nessun connettore', { exact: true }).first()).toBeVisible();

      await page.getByRole('button', { name: /Claude Desktop$/ }).click();
      await expect(page.getByRole('heading', { name: 'Connetti a Claude Desktop' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Aggiungi a Claude', exact: true })).toBeVisible();
      await expect(page.getByText('Consigliato:', { exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps /mcp-server and /mcp-server/[id] in English', async ({ page }) => {
      await mcpServerSession(page);
      await page.goto('/mcp-server');
      await expect(page.getByText('Last used 2 days ago · 1 call in 30 days', { exact: true })).toBeVisible();
      await expect(page.getByText('Exposes Echo Service', { exact: true })).toBeVisible();

      await page.goto('/mcp-server/s1');
      await expect(page.getByText('Assigned connectors (0)', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Connection check' })).toContainText('Waiting for the first request');
      await page.getByRole('button', { name: 'Select all', exact: true }).click();
      await expect(page.getByText('Saved', { exact: true })).toBeVisible();
      await expect(page.getByText('1 tools', { exact: true })).toBeVisible();
    });
  });
});

async function connectorsSession(page: Page) {
  await fakeSession(page);
  const list = [
    {
      id: 'c1',
      name: 'Orders DB',
      type: 'DATABASE',
      baseUrl: 'postgres://db.example.com/orders',
      authType: 'CONNECTION_STRING',
      isActive: true,
      setupStatus: 'needs_input',
      tools: [{ id: 't1' }, { id: 't2' }],
    },
    {
      id: 'c2',
      name: 'Calendar',
      type: 'REST',
      baseUrl: 'https://calendar.example.com',
      authType: 'OAUTH2',
      isActive: false,
      authStatus: 'needs_reauth',
      tools: [],
    },
  ];
  const catalog = [
    {
      slug: 'lexware',
      name: 'Lexware Office',
      description: 'Invoices and contacts.',
      region: 'de',
      category: 'accounting',
      icon: '',
      docsUrl: 'https://example.com/docs',
      requiredEnvVars: ['LEXWARE_API_KEY'],
      toolCount: 1,
      authType: 'API_KEY',
      setupEffort: { effort: 'api_key', minutes: 2 },
    },
    {
      slug: 'weather',
      name: 'Weather',
      description: 'Forecasts.',
      region: 'global',
      category: 'data',
      icon: '',
      docsUrl: '',
      requiredEnvVars: [],
      toolCount: 3,
      authType: 'NONE',
      setupEffort: { effort: 'none', minutes: 0 },
    },
  ];
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/(connectors|adapters)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/connectors')) return route.fulfill({ json: list });
    if (path.endsWith('/adapters/popular-connectors')) return route.fulfill({ json: { items: [{ slug: 'lexware' }] } });
    if (path.endsWith('/adapters')) return route.fulfill({ json: catalog });
    return route.fulfill({ json: {} });
  });
}

test.describe('connector list and marketplace from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders /connectors in German, with the status pills', async ({ page }) => {
      await connectorsSession(page);
      await page.goto('/connectors');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('link', { name: 'Connector hinzufügen' }).first()).toBeVisible();
      await expect(page.getByText('2 Connectors', { exact: true })).toBeVisible();
      await expect(page.getByText('Datenbank', { exact: true })).toBeVisible();
      await expect(page.getByText('Connection-String', { exact: true })).toBeVisible();
      await expect(page.getByText('Einrichtung offen', { exact: true })).toBeVisible();
      await expect(page.getByText('Anmeldung abgelaufen', { exact: true })).toBeVisible();
      await expect(page.getByText('Inaktiv', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Löschen' }).first().click();
      await expect(page.getByRole('dialog')).toContainText('Möchten Sie Orders DB und alle zugehörigen Tools wirklich löschen?');
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders /connectors/store in Italian, with its filters', async ({ page }) => {
      await connectorsSession(page);
      await page.goto('/connectors/store');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(
        page.getByText('Connettori pronti per le app più diffuse. Ogni scheda indica cosa richiede la configurazione.'),
      ).toBeVisible();
      await expect(page.getByText('2 adapter', { exact: true })).toBeVisible();
      await expect(page.getByText('Contabilità', { exact: true })).toBeVisible();
      await expect(page.getByText('Germania', { exact: true })).toBeVisible();
      await expect(page.getByText('Chiave API · 2 min', { exact: true })).toBeVisible();
      await expect(page.getByText('strumento', { exact: true })).toBeVisible();
      await expect(page.getByText('Popolare', { exact: true })).toBeVisible();

      // The translated names are searchable too.
      await page.getByRole('textbox', { name: 'Cerca adapter' }).fill('Germania');
      await expect(page.getByText('Lexware Office', { exact: true })).toBeVisible();
      await expect(page.getByText('Weather', { exact: true })).toHaveCount(0);

      await page.getByRole('textbox', { name: 'Cerca adapter' }).fill('');
      await page.getByRole('button', { name: /^Contabilità/ }).click();
      await page.getByRole('button', { name: /^Nessuna configurazione/ }).click();
      await expect(page.getByText('Nessun risultato in Contabilità con “Nessuna configurazione”.', { exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps /connectors and /connectors/store in English', async ({ page }) => {
      await connectorsSession(page);
      await page.goto('/connectors');
      await expect(page.getByText('2 connectors', { exact: true })).toBeVisible();
      await expect(page.getByText('Database', { exact: true })).toBeVisible();
      await expect(page.getByText('Connection String', { exact: true })).toBeVisible();
      await expect(page.getByText('Needs setup', { exact: true })).toBeVisible();
      await expect(page.getByText('Sign-in expired', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Delete' }).first().click();
      await expect(page.getByRole('dialog')).toContainText(
        'Are you sure you want to delete Orders DB and all its tools? This action cannot be undone.',
      );

      await page.goto('/connectors/store');
      await expect(page.getByText('2 adapters', { exact: true })).toBeVisible();
      await expect(page.getByText('Germany', { exact: true })).toBeVisible();
      await expect(page.getByText('API key · 2 min', { exact: true })).toBeVisible();
      await expect(page.getByText('tool', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Accounting/ }).click();
      await page.getByRole('button', { name: /^No setup/ }).click();
      await expect(page.getByText('Nothing matches in Accounting with no setup.', { exact: true })).toBeVisible();
    });
  });
});

async function connectorSetupSession(page: Page) {
  await fakeSession(page);
  const shop = {
    slug: 'shopx',
    name: 'Shopx',
    description: 'Your shop',
    icon: 'shopx',
    connector: { name: 'Shopx', type: 'REST', baseUrl: '{{SHOPX_URL}}/api', authType: 'API_KEY' },
    setupKind: 'credentials',
    envVars: [
      { name: 'SHOPX_URL', required: true, label: 'Shop address', kind: 'address', secret: false },
      { name: 'SHOPX_KEY', required: true, label: 'API key', kind: 'credential', secret: true },
    ],
    setupGuide: {
      effort: 'api_key',
      minutes: 3,
      examples: ['Which orders came in today?'],
      steps: [
        { id: 'shop', title: 'Your shop', fields: ['SHOPX_URL'] },
        { id: 'key', title: 'Your key', fields: ['SHOPX_KEY'] },
      ],
    },
  };
  await page.route(/\/health\/server-info/, (route) =>
    route.fulfill({ json: { mcpAuthMode: 'oauth2', serverUrl: '', mcpEndpoint: '', deploymentMode: 'self-hosted' } }),
  );
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/(adapters|connectors|mcp-servers)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/adapters/shopx')) return route.fulfill({ json: shop });
    if (path.endsWith('/adapters/shopx/verify')) return route.fulfill({ json: { ok: true, sample: '{"ok":true}' } });
    if (path.endsWith('/adapters/shopx/import')) {
      return route.fulfill({ json: { message: 'ok', connectorId: 'c9', attachedToServer: { id: 's1', name: 'Default' } } });
    }
    if (path.endsWith('/connectors/c9')) {
      return route.fulfill({ json: { id: 'c9', setupStatus: 'ready', envVars: {}, maskedEnvVars: [], mcpServers: [{ mcpServerId: 's1' }] } });
    }
    if (path.endsWith('/mcp-servers/s1/activity')) return route.fulfill({ json: { calls30d: 0, lastCallAt: null } });
    if (path.endsWith('/mcp-servers/s1')) return route.fulfill({ json: { id: 's1', name: 'Default', slug: 'default' } });
    if (path.endsWith('/connectors/oauth/redirect-uri')) return route.fulfill({ json: { redirectUri: 'https://example.com/cb' } });
    if (path.endsWith('/adapters/match-url')) return route.fulfill({ json: { matches: [] } });
    if (path.endsWith('/connectors')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
}

test.describe('connector setup and new connector from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the guided setup in German, through to the success screen', async ({ page }) => {
      await connectorSetupSession(page);
      await page.goto('/connectors/setup/shopx');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { name: 'Shopx mit Ihrer KI verbinden' })).toBeVisible();
      await expect(page.getByText('API-Schlüssel · 3 Min.', { exact: true })).toBeVisible();
      await expect(page.getByText('2 Schritte', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Starten', exact: true }).click();
      await expect(page.getByText('Schritt 1 von 2', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(page.getByText('Pflichtfeld', { exact: true })).toBeVisible();

      await page.getByLabel('Shop address').fill('https://shop.example.com');
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await page.getByLabel('API key').fill('secret');
      await page.getByRole('button', { name: 'Prüfen und verbinden', exact: true }).click();
      await expect(page.getByRole('heading', { name: /Shopx ist verbunden/ })).toBeVisible();
      await expect(page.getByText('AnythingMCP hat ihn mit Shopx geprüft: Er funktioniert.', { exact: true })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders /connectors/new in Italian', async ({ page }) => {
      await connectorSetupSession(page);
      await page.goto('/connectors/new');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByText('Scegli il tipo di connettore', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^API REST/ }).click();
      await expect(page.getByText('Configura API REST', { exact: true })).toBeVisible();
      await expect(page.getByText('Nome del connettore', { exact: true })).toBeVisible();
      await expect(page.getByText('Header personalizzati', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Testa la connessione' })).toBeVisible();

      await page.getByRole('button', { name: /^Database/ }).click();
      await expect(page.getByRole('button', { name: 'Sola lettura', exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps the guided setup and /connectors/new in English', async ({ page }) => {
      await connectorSetupSession(page);
      await page.goto('/connectors/setup/shopx');
      await expect(page.getByRole('heading', { name: 'Connect Shopx to your AI' })).toBeVisible();
      await expect(page.getByText('API key · 3 min', { exact: true })).toBeVisible();
      await expect(page.getByText('2 steps', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.getByText('Step 1 of 2', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByText('Required', { exact: true })).toBeVisible();

      await page.goto('/connectors/new');
      await expect(page.getByText('Choose connector type', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^REST API/ }).click();
      await expect(page.getByText('Configure REST API', { exact: true })).toBeVisible();
      await expect(page.getByText('Custom headers', { exact: true })).toBeVisible();
    });
  });
});

async function connectorDetailSession(page: Page) {
  await fakeSession(page);
  const connector = {
    id: 'c1',
    name: 'Orders API',
    type: 'REST',
    baseUrl: 'https://api.example.com/v1',
    authType: 'API_KEY',
    isActive: true,
    createdAt: '2026-01-15T10:00:00Z',
    envVars: { API_REGION: 'eu' },
    maskedEnvVars: [],
    headers: null,
    config: {},
    tools: [],
    mcpServers: [{ mcpServerId: 's1' }],
  };
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/connectors/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/connectors/c1')) return route.fulfill({ json: connector });
    if (path.endsWith('/connectors/c1/catalog-diff')) return route.fulfill({ json: { catalogManaged: false } });
    if (path.endsWith('/connectors/proxy-availability')) return route.fulfill({ json: { available: false } });
    if (path.endsWith('/connectors/c1/tools')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
}

test.describe('connector page from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders /connectors/[id] in German, in view and edit mode', async ({ page }) => {
      await connectorDetailSession(page);
      await page.goto('/connectors/c1');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByText('Connector-Details', { exact: true })).toBeVisible();
      await expect(page.getByText('API-Schlüssel', { exact: true })).toBeVisible();
      await expect(page.getByText('Umgebungsvariablen', { exact: true })).toBeVisible();
      await expect(page.getByText('Aktiv', { exact: true }).first()).toBeVisible();

      await page.getByRole('button', { name: 'Bearbeiten (1)' }).click();
      await expect(page.getByRole('button', { name: '+ Variable hinzufügen' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Variablen speichern' })).toBeVisible();

      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
      await expect(page.getByText('Header-Name', { exact: true }).first()).toBeVisible();
      await expect(page.getByPlaceholder('Leer lassen zum Beibehalten').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Änderungen speichern' })).toBeVisible();

      await expect(page.getByText('Connector löschen', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Löschen', exact: true }).last().click();
      await expect(page.getByRole('dialog')).toContainText('Möchten Sie Orders API und alle zugehörigen Tools wirklich löschen?');
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders /connectors/[id] in Italian', async ({ page }) => {
      await connectorDetailSession(page);
      await page.goto('/connectors/c1');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByText('Dettagli del connettore', { exact: true })).toBeVisible();
      await expect(page.getByText('Chiave API', { exact: true })).toBeVisible();
      await expect(page.getByText('Variabili d\'ambiente', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Modifica', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Salva modifiche' })).toBeVisible();
      await expect(page.getByText('Elimina connettore', { exact: true }).first()).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps /connectors/[id] in English', async ({ page }) => {
      await connectorDetailSession(page);
      await page.goto('/connectors/c1');
      await expect(page.getByText('Connector Details', { exact: true })).toBeVisible();
      await expect(page.getByText('Auth Type', { exact: true })).toBeVisible();
      await expect(page.getByText('API Key', { exact: true })).toBeVisible();
      await expect(page.getByText('Environment Variables', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Edit (1)' }).click();
      await expect(page.getByRole('button', { name: '+ Add Variable' })).toBeVisible();

      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByText('Header Name', { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('Leave empty to keep current').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();

      await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
      await expect(page.getByRole('dialog')).toContainText(
        'Are you sure you want to delete Orders API and all its tools? This action cannot be undone.',
      );
    });
  });
});

async function connectorToolsSession(page: Page) {
  await fakeSession(page);
  const connector = {
    id: 'c1',
    name: 'Orders API',
    type: 'REST',
    baseUrl: 'https://api.example.com/v1',
    authType: 'NONE',
    isActive: true,
    createdAt: '2026-01-15T10:00:00Z',
    envVars: {},
    maskedEnvVars: [],
    headers: null,
    config: {},
    tools: [
      {
        id: 't1',
        name: 'list_orders',
        description: 'List recent orders',
        isEnabled: true,
        parameters: { type: 'object', properties: { status: { type: 'string', description: 'Order status' } } },
        endpointMapping: { method: 'GET', path: '/orders', queryParams: { status: '$status' } },
        responseMapping: null,
      },
    ],
    mcpServers: [{ mcpServerId: 's1' }],
  };
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\/connectors/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/connectors/c1')) return route.fulfill({ json: connector });
    if (path.endsWith('/connectors/c1/catalog-diff')) return route.fulfill({ json: { catalogManaged: false } });
    if (path.endsWith('/connectors/proxy-availability')) return route.fulfill({ json: { available: false } });
    if (path.endsWith('/tools/t1/annotations')) {
      return route.fulfill({
        json: { derived: { readOnlyHint: true }, override: null, effective: { readOnlyHint: true }, supportedKeys: [] },
      });
    }
    return route.fulfill({ json: {} });
  });
}

test.describe('connector tools and tool editor from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the tools section and the tool editor in German', async ({ page }) => {
      await connectorToolsSession(page);
      await page.goto('/connectors/c1');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByText('MCP-Tools (1)', { exact: true })).toBeVisible();
      await expect(page.getByText('aktiviert', { exact: true })).toBeVisible();
      await expect(page.getByText('1 Parameter', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Testen', exact: true }).last().click();
      await expect(page.getByText('Eingabeparameter (JSON)', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Test ausführen' })).toBeVisible();

      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).last().click();
      await expect(page.getByRole('heading', { name: 'Tool bearbeiten(REST)' })).toBeVisible();
      await expect(page.getByText('Tool-Name', { exact: true })).toBeVisible();
      await expect(page.getByText('Eingabeparameter', { exact: true })).toBeVisible();
      await expect(page.getByText('Response-Mapping', { exact: true })).toBeVisible();
      await page.getByLabel('Feldauswahl').check();
      await expect(page.getByText('Ausgabevorlage (JSON)', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tool aktualisieren' })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders the import panel and the tool hints in Italian', async ({ page }) => {
      await connectorToolsSession(page);
      await page.goto('/connectors/c1');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('button', { name: 'Verifica', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Importa strumenti' }).click();
      await expect(page.getByText('Importa strumenti da', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'File HAR (acquisizione del browser)' }).click();
      await expect(page.getByText(/^Dai DevTools del browser/)).toBeVisible();

      await page.getByRole('button', { name: 'Hint', exact: true }).click();
      await expect(page.getByText('Sola lettura', { exact: true })).toBeVisible();
      await expect(page.getByText('Comunicato ai client', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Salva hint' })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps the tools section, tool editor and hints in English', async ({ page }) => {
      await connectorToolsSession(page);
      await page.goto('/connectors/c1');
      await expect(page.getByText('MCP Tools (1)', { exact: true })).toBeVisible();
      await expect(page.getByText('1 params', { exact: true })).toBeVisible();
      await expect(page.getByText('1 query', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Import Tools' }).click();
      await expect(page.getByText('Import Tools From', { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('Paste OpenAPI JSON/YAML or enter URL...')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel Import' }).click();

      await page.getByRole('button', { name: 'Hints', exact: true }).click();
      await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Auto (yes)' }).first()).toBeAttached();
      await page.getByRole('button', { name: 'Close hints' }).click();

      await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
      await expect(page.getByRole('heading', { name: 'Edit Tool(REST)' })).toBeVisible();
      await expect(page.getByText('Input Parameters', { exact: true })).toBeVisible();
      await expect(page.getByText('Query Parameter', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Response Cache TTL', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Update Tool' })).toBeVisible();
    });
  });
});

async function settingsSession(page: Page) {
  await fakeSession(page);
  // Not under /api, so fakeSession's catch-all does not answer it.
  await page.route(/\/health\/server-info/, (route) =>
    route.fulfill({
      json: {
        mcpAuthMode: 'both',
        serverUrl: 'http://localhost:4000',
        mcpEndpoint: 'http://localhost:4000/mcp',
        deploymentMode: 'self-hosted',
        hasUsers: true,
        registrationEnabled: false,
        ssoProviders: [],
        oauthEndpoints: {
          wellKnown: '/.well-known/oauth-authorization-server',
          authorize: '/oauth/authorize',
          token: '/oauth/token',
          register: '/oauth/register',
        },
      },
    }),
  );
  // Registered after fakeSession's catch-all, so these win for their URLs.
  await page.route(/\/api\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/users') {
      return json([
        { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', createdAt: '2026-01-02T10:00:00Z', learningMode: null },
        { id: 'u2', email: 'ada@example.com', name: 'Ada', role: 'EDITOR', createdAt: '2026-02-03T10:00:00Z', learningMode: null, learningOptOut: true, mcpRole: null },
      ]);
    }
    if (path === '/api/users/invitations') {
      return json([{ id: 'i1', email: 'new@example.com', role: 'VIEWER', createdAt: '2026-03-01T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]);
    }
    if (path === '/api/roles') return json([]);
    if (path === '/api/knowledge-graph/settings') {
      return json({ enabled: true, llmEnabled: false, llmAvailable: false, captureIntent: true, autoExtend: false, skillAutoApply: false, edgeAutoApply: false });
    }
    if (path === '/api/memory/status') {
      return json({ licensed: true, access: 'contribute', settings: { defaultAccess: 'personal', writeMode: 'approval' }, isCurator: true });
    }
    if (path === '/api/license/edition') {
      return json({
        edition: 'business', business: true, source: 'license', plan: 'business', seatLimit: 10, seatsUsed: 2,
        communitySeatLimit: 3, trialEndsAt: null, trialAvailable: false, trialDays: 0, transitionUntil: null,
      });
    }
    if (path === '/api/mcp-connections') {
      return json([
        { clientId: 'cl1', clientName: 'Claude', revoked: false, servers: [{ id: 's1', name: 'Sales' }], wholeWorkspace: null, connectedAt: '2026-01-01', updatedAt: '2026-01-01' },
      ]);
    }
    if (path === '/api/mcp-connections/targets') {
      return json([
        { organizationId: 'o1', organizationName: 'Acme', servers: [{ id: 's1', name: 'Sales', connectorCount: 2 }, { id: 's2', name: 'Support', connectorCount: 1 }] },
      ]);
    }
    return route.fallback();
  });
}

test.describe('settings pages from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the profile and users pages in German', async ({ page }) => {
      await settingsSession(page);
      await page.goto('/settings');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      const nav = page.locator('main nav');
      await expect(nav.getByRole('link', { name: /^Profil/ })).toBeVisible();
      await expect(nav.getByText('Workspace und neue Organisationen', { exact: true })).toBeVisible();
      await expect(nav.getByText('Organisation', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Passwort ändern' })).toBeVisible();
      await expect(page.getByPlaceholder('Neues Passwort wiederholen')).toBeVisible();
      await expect(page.getByText('Beides (OAuth 2.0 + Legacy)', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Der Authentifizierungsmodus wird über die Umgebungsvariable MCP_AUTH_MODE/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mein Konto löschen' })).toBeVisible();

      await page.goto('/settings/users');
      await expect(page.getByRole('heading', { name: 'Benutzerverwaltung' })).toBeVisible();
      await expect(page.getByText('Verwalten Sie Benutzer und versenden Sie Einladungen. 2 von 10 Benutzern auf dieser Instanz.')).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Skill-Lernen' })).toBeVisible();
      await expect(page.getByText('widersprochen', { exact: true })).toBeVisible();
      await expect(page.getByText('Ausstehend', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Insgesamt 2 Benutzer, 1 offene Einladung. Der erste registrierte Benutzer wird automatisch ADMIN.'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Benutzer einladen' }).click();
      await expect(page.getByRole('heading', { name: 'Neuen Benutzer einladen' })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders the organization and connections pages in Italian', async ({ page }) => {
      await settingsSession(page);
      await page.goto('/settings/organization');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('heading', { name: 'Organizzazione', exact: true })).toBeVisible();
      await expect(page.getByText("Nome dell'organizzazione", { exact: true })).toBeVisible();
      await expect(page.getByText("Acquisisci l'intento dell'utente", { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Le mie organizzazioni' })).toBeVisible();
      await expect(page.getByText(/^ADMIN · Entrato il /)).toBeVisible();
      await page.getByRole('button', { name: 'Disconnetti tutti' }).click();
      await expect(page.getByRole('dialog').getByText('Digita Acme per confermare')).toBeVisible();
      await page.getByRole('button', { name: 'Annulla' }).click();

      await page.goto('/settings/connections');
      await expect(page.getByRole('heading', { name: 'Client AI collegati' })).toBeVisible();
      await page.getByRole('button', { name: 'Modifica', exact: true }).click();
      await expect(page.getByText('2 connettori', { exact: true })).toBeVisible();
      await expect(page.getByText('1 connettore', { exact: true })).toBeVisible();
      await expect(page.getByText('Tutto in questo workspace', { exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps the settings pages in English', async ({ page }) => {
      await settingsSession(page);
      await page.goto('/settings');
      const nav = page.locator('main nav');
      await expect(nav.getByText('Workspace and new orgs', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
      await expect(page.getByText('Both (OAuth 2.0 + Legacy)', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Auth mode is configured via the MCP_AUTH_MODE environment variable. Set it to oauth2, legacy, both, or none.'),
      ).toBeVisible();
      await expect(
        page.getByText('API keys are now managed per MCP server. Go to MCP Servers to generate and manage keys for each server.'),
      ).toBeVisible();

      await page.goto('/settings/users');
      await expect(page.getByText('Manage users and send invitations. 2 of 10 users on this instance.')).toBeVisible();
      await expect(page.getByText('opted out', { exact: true })).toBeVisible();
      await expect(
        page.getByText('2 users, 1 pending invitation total. The first registered user automatically becomes ADMIN.'),
      ).toBeVisible();
      await expect(page.getByText('Default (personal)', { exact: true }).first()).toBeVisible();

      await page.goto('/settings/organization');
      await expect(page.getByText('Organization Name', { exact: true })).toBeVisible();
      await expect(page.getByText(/^ADMIN · Joined /)).toBeVisible();

      await page.goto('/settings/connections');
      await expect(page.getByRole('heading', { name: 'Connected AI clients' })).toBeVisible();
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await expect(page.getByText('2 connectors', { exact: true })).toBeVisible();
      await expect(page.getByText('1 connector', { exact: true })).toBeVisible();
      await expect(page.getByText('including connectors not on a server', { exact: true })).toBeVisible();
    });
  });
});

async function settingsAdminSession(page: Page) {
  await settingsSession(page);
  // Registered after settingsSession's routes, so these win for their URLs.
  await page.route(/\/api\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/roles') {
      return json([{ id: 'r1', name: 'Support', description: 'Support team', isSystem: false, _count: { users: 1, toolAccess: 2 } }]);
    }
    if (path === '/api/admin/settings/smtp') return json({ configured: true, host: 'smtp.example.com', port: 587, user: 'mailer', secure: false });
    if (path === '/api/admin/settings/alert-webhook') {
      return json({ url: 'https://example.com/hook', type: 'json', enabled: true, threshold: 5, windowMinutes: 10, cooldownMinutes: 30 });
    }
    if (path === '/api/admin/settings/footer-links') return json([]);
    if (path === '/api/version') return json({ version: '1.2.3', commit: 'abc1234', buildDate: '2026-10-01T00:00:00Z', deploymentMode: 'self-hosted' });
    if (path === '/api/license/status') {
      return json({
        plan: 'business', status: 'active', features: null, expiresAt: '2027-01-01T12:00:00Z',
        lastVerifiedAt: '2026-10-01T12:00:00Z', instanceId: 'inst-1',
      });
    }
    if (path === '/api/identity-providers') {
      return json([
        {
          id: 'p1', type: 'ENTRA', name: 'Contoso', isActive: true, issuer: 'https://login.microsoftonline.com/t1/v2.0',
          clientId: 'client-1', clientSecretExpiresAt: null, initiateId: 'init1', jitProvisioning: true, jitDefaultRole: 'VIEWER',
          roleSyncEnabled: true, roleSyncSource: 'GROUPS', roleSyncFallback: 'DENY_ALL', roleSyncDefaultRoleIds: [],
          scimEnabled: true, scimTokenIssuedAt: '2026-09-01T10:00:00Z', scimLastRequestAt: null, enforceSso: false,
          lastSuccessfulLoginAt: null, config: { tenantId: 't1' },
        },
      ]);
    }
    if (path === '/api/auth/recovery-codes') return json({ total: 10, unused: 8, generatedAt: '2026-09-01T10:00:00Z' });
    if (path === '/api/identity-providers/p1/scim') {
      return json({
        enabled: true, supported: true, issuedAt: '2026-09-01T10:00:00Z', lastRequestAt: new Date().toISOString(),
        tenantUrl: 'http://localhost:3100/api/scim/v2', userCount: 12, groupCount: 3, unlinkedMemberCount: 0,
      });
    }
    if (path === '/api/identity-providers/p1/role-mappings') {
      return json([{ id: 'm1', externalId: '4be78614-f22d-472f-a2cb-5eb81b6e3f6f', label: 'Sales', userRole: null, mcpRoleIds: ['r1'] }]);
    }
    return route.fallback();
  });
}

test.describe('settings roles, administration, license and single sign-on from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the roles and single sign-on pages in German', async ({ page }) => {
      await settingsAdminSession(page);
      await page.goto('/settings/roles');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { name: 'Eigene Rollen' })).toBeVisible();
      await expect(page.getByText('1 Benutzer', { exact: true })).toBeVisible();
      await expect(page.getByText('2 Tools zugewiesen', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'MCP-Rollen der Benutzer' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'MCP-Tool-Rolle' })).toBeVisible();

      await page.goto('/settings/identity-providers');
      await expect(page.getByRole('heading', { name: 'Single Sign-On', exact: true })).toBeVisible();
      await expect(page.getByText('Legt Konten bei der ersten Anmeldung an', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Wiederherstellungscodes' })).toBeVisible();
      await expect(page.getByText('8 von 10 ungenutzt. Neu erzeugen macht den aktuellen Satz ungültig.')).toBeVisible();
      await page.getByRole('button', { name: 'Provisionierung (SCIM)' }).click();
      await expect(page.getByText('Provisionierte Benutzer 12', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rollen jetzt neu synchronisieren' })).toBeVisible();
      await page.getByRole('button', { name: 'Anbieter hinzufügen' }).click();
      await expect(page.getByText('Verzeichnis-ID (Mandant)', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Konten bei der ersten Anmeldung anlegen/)).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders the administration and license pages in Italian', async ({ page }) => {
      await settingsAdminSession(page);
      await page.goto('/settings/admin');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('heading', { name: 'Avvisi sugli errori dei connettori' })).toBeVisible();
      await expect(
        page.getByText('Avvisa dopo 5 errori dello stesso connettore entro 10 minuti, poi attende 30 minuti prima di avvisare di nuovo.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Prova la connessione' })).toBeVisible();
      await expect(page.getByText(/^Versione 1\.2\.3 · commit abc1234 · build del 2026-10-01$/)).toBeVisible();

      await page.goto('/settings/license');
      await expect(page.getByRole('heading', { name: 'Licenza e piano' })).toBeVisible();
      await expect(page.getByText('attiva', { exact: true })).toBeVisible();
      await expect(page.getByText('Ultima verifica', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Cambia chiave di licenza' })).toBeVisible();

      await page.goto('/settings/identity-providers');
      await page.getByRole('button', { name: 'Associazioni dei ruoli' }).click();
      await expect(page.getByRole('heading', { name: 'Associazioni dei gruppi' })).toBeVisible();
      await expect(page.getByText('A chi non corrisponde a nulla', { exact: false })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps these settings pages in English', async ({ page }) => {
      await settingsAdminSession(page);
      await page.goto('/settings/roles');
      await expect(page.getByRole('heading', { name: 'Custom Roles' })).toBeVisible();
      await expect(page.getByText('1 user', { exact: true })).toBeVisible();
      await expect(page.getByText('2 tools assigned', { exact: true })).toBeVisible();

      await page.goto('/settings/admin');
      await expect(
        page.getByText('Alerts after 5 failures of the same connector within 10 minutes, then waits 30 minutes before alerting again.'),
      ).toBeVisible();
      await expect(page.getByText(/^Version 1\.2\.3 · commit abc1234 · built 2026-10-01$/)).toBeVisible();

      await page.goto('/settings/license');
      await expect(page.getByRole('heading', { name: 'License & Plan' })).toBeVisible();
      await expect(page.getByText('active', { exact: true })).toBeVisible();
      await expect(page.getByText('Last Verified', { exact: true })).toBeVisible();

      await page.goto('/settings/identity-providers');
      await expect(page.getByText('8 of 10 unused. Regenerating invalidates the current set.')).toBeVisible();
      await page.getByRole('button', { name: 'Provisioning (SCIM)' }).click();
      await expect(page.getByText('Users provisioned 12', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Role mappings' }).click();
      await expect(
        page.getByText(
          'A user in several mapped groups receives the union of their MCP roles and the most privileged workspace role. Roles an admin assigned by hand are never removed by a sync. Someone who matches nothing is given a “No access (SSO)” role, which grants no tools.',
        ),
      ).toBeVisible();

      await page.goto('/settings/license/activate');
      await expect(page.getByText('No license key was provided in the URL.')).toBeVisible();
    });
  });
});

async function adminPagesSession(page: Page) {
  await settingsAdminSession(page);
  // Registered after settingsAdminSession's routes, so these win for their URLs.
  await page.route(/\/api\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/connectors') return json([{ id: 'c1', name: 'Shop' }]);
    if (path === '/api/connectors/c1/tools') return json([{ id: 'tl1', name: 'list_orders' }, { id: 'tl2', name: 'get_order' }]);
    if (path === '/api/roles/r1/tools') return json([{ tool: { id: 'tl1' } }]);
    if (path === '/api/admin/settings/ssrf-allowed-hosts') return json({ hosts: ['koch-filesystem-bridge'], envHosts: ['db.internal'] });
    return route.fallback();
  });
}

test.describe('admin pages from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the admin users and roles pages in German', async ({ page }) => {
      await adminPagesSession(page);
      await page.goto('/admin/users');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('banner').getByText('Benutzerverwaltung', { exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Beigetreten' })).toBeVisible();
      await expect(page.getByText('Uneingeschränkt', { exact: true })).toBeVisible();
      await expect(page.getByText('2.1.2026', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Insgesamt 2 Benutzer. Der erste registrierte Benutzer wird automatisch ADMIN.'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Benutzer einladen' }).click();
      await expect(page.getByRole('heading', { name: 'Neuen Benutzer einladen' })).toBeVisible();

      await page.goto('/admin/roles');
      await expect(page.getByRole('banner').getByText('MCP-Rollenverwaltung', { exact: true })).toBeVisible();
      await expect(page.getByText('2 Tools zugewiesen', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Tools verwalten' }).click();
      await expect(page.getByRole('button', { name: 'Speichern (1 Tool)' })).toBeVisible();
      await page.getByRole('button', { name: 'Alle auswählen' }).click();
      await expect(page.getByRole('button', { name: 'Speichern (2 Tools)' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'MCP-Tool-Rolle' })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders the admin settings page in Italian', async ({ page }) => {
      await adminPagesSession(page);
      await page.goto('/admin/settings');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('banner').getByText('Impostazioni di amministrazione', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Email / configurazione SMTP' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Prova la connessione' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Allowlist SSRF' })).toBeVisible();
      await expect(page.getByText(/^Dalla variabile d’ambiente SSRF_ALLOWED_HOSTS \(sola lettura\):$/)).toBeVisible();
      await expect(page.getByText(/^Nomi host \(oppure caratteri jolly \*\.suffix/)).toBeVisible();
      await page.getByRole('button', { name: 'Salva allowlist' }).click();
      await expect(page.getByText('Allowlist SSRF salvata', { exact: true })).toBeVisible();
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps the admin pages in English', async ({ page }) => {
      await adminPagesSession(page);
      await page.goto('/admin/users');
      await expect(page.getByRole('banner').getByText('User Management', { exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Joined' })).toBeVisible();
      await expect(page.getByText('Unrestricted', { exact: true })).toBeVisible();
      await expect(page.getByText('1/2/2026', { exact: true })).toBeVisible();
      await expect(page.getByText('2 users total. The first registered user automatically becomes ADMIN.')).toBeVisible();

      await page.goto('/admin/roles');
      await expect(page.getByRole('banner').getByText('MCP Role Management', { exact: true })).toBeVisible();
      await expect(page.getByText('1 user', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Manage Tools' }).click();
      await expect(page.getByRole('button', { name: 'Save (1 tools)' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Select all', exact: true })).toBeVisible();

      await page.goto('/admin/settings');
      await expect(page.getByRole('banner').getByText('Admin Settings', { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          'Hostnames (or *.suffix wildcards / plain IPs) that the SSRF guard will let through when they resolve to a private network address. Needed when connectors call services on the internal network — e.g. a Docker-compose service like koch-filesystem-bridge.',
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "⚠ Use with caution. Anything added here can be reached by every connector in every organization on this deployment. Do not add hosts you don't fully trust.",
        ),
      ).toBeVisible();
      await expect(page.getByText('From SSRF_ALLOWED_HOSTS env var (read-only):')).toBeVisible();
      await page.getByRole('button', { name: 'Save allowlist' }).click();
      await expect(page.getByText('SSRF allowlist saved', { exact: true })).toBeVisible();
    });
  });
});

async function knowledgeSession(page: Page) {
  await fakeSession(page);
  // Registered after fakeSession's routes, so these win for their URLs.
  await page.route(/\/api\//, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/knowledge-graph') {
      return json({
        enabled: true,
        lastBuiltAt: '2026-01-02T10:00:00Z',
        nodes: [
          {
            id: 'n1', entity: 'customer', label: 'Customer', connectorId: 'c1', connectorName: 'Shop',
            fields: [{ name: 'id', type: 'string' }, { name: 'email', type: 'string' }],
            toolNames: ['list_customers'], source: 'STATIC', confidence: 1, observations: 0,
          },
          {
            id: 'n2', entity: 'order', label: 'Order', connectorId: 'c1', connectorName: 'Shop',
            fields: [{ name: 'customerId', type: 'string' }], toolNames: ['list_orders'],
            source: 'STATIC', confidence: 1, observations: 0,
          },
        ],
        edges: [
          {
            id: 'e1', sourceNodeId: 'n2', targetNodeId: 'n1', kind: 'references', matchKey: 'customerId',
            source: 'STATIC', confidence: 0.9, observations: 3, isManual: false, status: 'active',
          },
        ],
      });
    }
    if (path === '/api/knowledge-graph/settings') return json({ enabled: true, llmEnabled: true });
    if (path === '/api/connectors') return json([{ id: 'c1', name: 'Shop' }]);
    if (path === '/api/mcp-servers') return json([{ id: 'm1', name: 'Sales' }]);
    if (path === '/api/knowledge-folders') {
      return json({
        restrictionsAvailable: false,
        folders: [
          { id: 'f1', parentId: null, name: 'Orders', description: null, roleIds: [], path: 'Orders', depth: 0, skillCount: 1, memoryCount: 1 },
        ],
      });
    }
    if (path === '/api/knowledge-graph/skills') {
      return json({
        total: 2,
        take: 25,
        skip: 0,
        counts: { pending: 1, applied: 1, dismissed: 0 },
        items: [
          {
            id: 's1', connectorId: null, mcpServerId: 'm1', mcpServer: { name: 'Sales' },
            title: 'Confirm the delivery address', whenToUse: 'Before placing an order',
            instruction: 'Ask the user to confirm the address.', confidence: 1, evidenceCount: 0,
            status: 'applied', source: 'manual', version: 2, useCount: 3, lastUsedAt: '2026-01-05T08:00:00Z',
          },
          {
            id: 's2', connectorId: 'c1', connector: { name: 'Shop' }, mcpServerId: null,
            title: 'Order lookups', whenToUse: 'When looking up an order',
            instruction: 'Search by order number first.', confidence: 0.85, evidenceCount: 4,
            status: 'pending', source: 'consolidation', replaces: ['a', 'b'], body: 'Step 1',
            version: 1, useCount: 0,
          },
        ],
      });
    }
    if (path === '/api/knowledge-graph/skills/s1/versions') {
      return json([
        { version: 1, title: 'Check the address', whenToUse: '', instruction: 'Check it.', body: null, createdAt: '2026-01-03T09:00:00Z' },
      ]);
    }
    if (path === '/api/memory/status') {
      return json({
        licensed: true,
        access: 'contribute',
        isCurator: true,
        settings: { defaultAccess: 'personal', writeMode: 'approval' },
      });
    }
    if (path === '/api/memory/items') {
      const base = { ownerUserId: 'u1', createdByUserId: 'u1', approvedByUserId: null, approvedAt: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
      if (url.searchParams.get('scope') === 'personal') {
        return json({
          total: 1, pending: 1, take: 25, skip: 0,
          items: [
            { ...base, id: 'mm1', scope: 'personal', kind: 'preference', content: 'Answer in short bullet points', tags: ['style'], status: 'active', source: { via: 'mcp', client: 'Claude' } },
          ],
        });
      }
      return json({
        total: 1, pending: 1, take: 25, skip: 0,
        items: [
          { ...base, id: 'mm2', scope: 'organization', kind: 'fact', content: 'STAMMKUNDE means a customer with a framework agreement', tags: [], status: 'pending', source: { via: 'ui' }, about: 'customer', folderId: 'f1' },
        ],
      });
    }
    return route.fallback();
  });
}

test.describe('knowledge graph, AI skills and memory from Accept-Language', () => {
  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

    test('renders the knowledge graph and the AI skills in German', async ({ page }) => {
      await knowledgeSession(page);
      await page.goto('/knowledge-graph');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('button', { name: 'Graph neu aufbauen' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mit KI anreichern' })).toBeVisible();
      await expect(page.getByText('Ebene', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'beobachtet', exact: true })).toBeVisible();
      await expect(page.getByText('Vorschläge anzeigen', { exact: true })).toBeVisible();
      await expect(page.getByText('2 Entitäten · 1 Beziehung', { exact: true })).toBeVisible();
      await expect(page.getByText('Datenfluss', { exact: true })).toBeVisible();
      await expect(page.getByText('Erkunden', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '+ Entität hinzufügen' }).click();
      await expect(page.getByPlaceholder('Bezeichnung (z. B. Treuestufe)')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Vergrößern' })).toBeVisible();
      // The first node circle is the Customer entity (labels only show once zoomed in).
      await page.locator('svg g[transform] > circle').first().click();
      await expect(page.getByRole('heading', { name: 'Customer' })).toBeVisible();
      await expect(page.getByText('Felder (2)', { exact: true })).toBeVisible();
      await expect(page.getByText('Verbindungen (1)', { exact: true })).toBeVisible();
      await expect(page.getByText('Referenz · customerId', { exact: true })).toBeVisible();

      await page.goto('/knowledge-graph/skills');
      await expect(page.getByRole('banner').getByText('KI-Skills', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Vorgeschlagen\s*1$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Aus behobenen Fehlern lernen' })).toBeVisible();
      await expect(page.getByText(/^Server: Sales · von Hand geschrieben · v2 · 3× geöffnet, zuletzt am 5\.1\.2026$/)).toBeVisible();
      await expect(
        page.getByText(/^Connector: Shop · Vorschlag zum Zusammenführen · v1 · Konfidenz 0\.85 · 4 Beispiele · noch nicht geöffnet$/),
      ).toBeVisible();
      await expect(
        page.getByText('Ersetzt 2 aktive Skills: Wenn Sie ihn übernehmen, werden diese deaktiviert (sie bleiben mit ihrem Verlauf erhalten).'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Verlauf (1 frühere Version)' }).click();
      await expect(page.getByRole('button', { name: 'Verlauf ausblenden' })).toBeVisible();
      await expect(page.getByText('Ordner', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Alle Skills' })).toBeVisible();
    });
  });

  test.describe('it-IT', () => {
    test.use({ locale: 'it-IT', viewport: { width: 1280, height: 860 } });

    test('renders the memory page in Italian', async ({ page }) => {
      await knowledgeSession(page);
      await page.goto('/memory');
      await expect(page.locator('html')).toHaveAttribute('lang', 'it');
      await expect(page.getByRole('banner').getByText('Memoria', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/^Il tuo accesso in questo workspace: Memoria personale \+ proposte alla memoria aziendale · si imposta per utente in/),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Impostazioni → Utenti' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'La mia memoria' })).toBeVisible();
      await expect(page.getByText('preferenza', { exact: true })).toBeVisible();
      await expect(page.getByText(/salvato da un client AI \(Claude\) · 02\/01\/2026$/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ricorda' })).toBeVisible();
      await expect(page.getByText('Non salvare mai password, token o chiavi: vengono rifiutati.')).toBeVisible();

      await page.getByRole('button', { name: /^Da rivedere/ }).click();
      await expect(page.getByText('in attesa di revisione', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Orders · riguarda customer · aggiunto dalla dashboard/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approva' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tutta la memoria aziendale' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Impostazioni del workspace' })).toBeVisible();
      await expect(page.getByLabel('Accesso predefinito per gli utenti')).toHaveValue('personal');
    });
  });

  test.describe('en-US', () => {
    test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('keeps the knowledge graph, AI skills and memory pages in English', async ({ page }) => {
      await knowledgeSession(page);
      await page.goto('/knowledge-graph');
      await expect(page.getByRole('button', { name: 'Rebuild graph' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'observed', exact: true })).toBeVisible();
      await expect(page.getByText('show suggested', { exact: true })).toBeVisible();
      await expect(page.getByText('2 entities · 1 relationships', { exact: true })).toBeVisible();
      await expect(page.getByText('data flow', { exact: true })).toBeVisible();
      // The first node circle is the Customer entity (labels only show once zoomed in).
      await page.locator('svg g[transform] > circle').first().click();
      await expect(page.getByRole('heading', { name: 'Customer' })).toBeVisible();
      await expect(page.getByText('Fields (2)', { exact: true })).toBeVisible();
      await expect(page.getByText('references · customerId', { exact: true })).toBeVisible();

      await page.goto('/knowledge-graph/skills');
      await expect(page.getByRole('banner').getByText('AI Skills', { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          "Rules and procedures for recurring tasks, scoped to one connector or to a whole MCP server. Active skills reach that server's AI clients on connect, as full text or as a list they open with skill_get (set per server). Long procedures are always opened on demand.",
        ),
      ).toBeVisible();
      await expect(page.getByText(/^server: Sales · written by hand · v2 · opened 3×, last 1\/5\/2026$/)).toBeVisible();
      await expect(
        page.getByText(/^connector: Shop · merge proposal · v1 · confidence 0\.85 · 4 example\(s\) · not opened yet$/),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'History (1 earlier version)' })).toBeVisible();
      await expect(page.getByText('Procedure (6 characters)', { exact: true })).toBeVisible();

      await page.goto('/memory');
      await expect(
        page.getByText(/^Your access in this workspace: Personal memory \+ propose to company memory · set per user under/),
      ).toBeVisible();
      await expect(page.getByText('preference', { exact: true })).toBeVisible();
      await expect(page.getByText(/saved by an AI client \(Claude\) · 1\/2\/2026$/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remember' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
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
